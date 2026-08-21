"""
Build an offline region pack (.obp) — a compact, routable road graph the client can
use with no network at all.

Run offline as a build step; never in the request path.

    python tools/build_pack.py --place "Lower Manhattan, New York, USA" --id lower-manhattan
    python tools/build_pack.py --point 40.7075,-74.0113 --radius 1200 --id battery-park

Why a custom format: OSMnx's GraphML costs ~1.3 KB per node, which puts a mid-size
city at hundreds of megabytes. The layout below costs ~78 bytes per node, needs no
parsing on the client (every section maps straight onto a typed array), and keeps the
whole graph in one contiguous ArrayBuffer that transfers zero-copy into a Web Worker.

Binary layout — little-endian throughout, every section 4-byte aligned:

    Header, 64 B
        0  char[4]  magic "OBP1"
        4  uint32   format version
        8  int32    minLat, minLon, maxLat, maxLon   (micro-degrees)
       24  uint32   nodeCount
       28  uint32   edgeCount
       32  float32  maxSpeedMps   — A* heuristic divisor; see note below
       36  uint32   stringOffset, stringLength
       44  uint32   geometryOffset, geometryLength
       52  uint32   havenOffset, havenLength
       60  uint32   reserved

    Nodes       int32   lat[nodeCount], lon[nodeCount]      micro-degrees
                uint32  edgeOffset[nodeCount + 1]           CSR row index

    Edges       uint32  target[edgeCount]
                uint16  lengthM[edgeCount]
                uint8   speedKph[edgeCount]
                uint8   flags[edgeCount]                    bit0 drive, bit1 walk
                uint16  nameId[edgeCount]                   index into string table
                uint32  geomOffset[edgeCount + 1]           index into geometry stream

    Geometry    int16 delta pairs (lat, lon) in micro-degrees, relative to the previous
                point and seeded from the edge's source node. Interior shape points
                only — both endpoints are already stored as nodes.

    Strings     uint32 count, then uint16 byteLength + UTF-8 bytes per entry
    Havens      UTF-8 JSON array of real, attributable safe havens

Travel cost is deliberately NOT baked in. Storing one cost per edge would force a
single travel mode into the pack; storing length and speed lets the client derive
drive and walk costs from the same data.
"""

import argparse
import json
import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))

import networkx as nx
import osmnx as ox

from graph_loader import DRIVABLE_HIGHWAYS, DRIVE_ONLY_HIGHWAYS
from haven_sources import fetch_osm_safe_havens

MAGIC = b"OBP1"
FORMAT_VERSION = 1
HEADER_BYTES = 64
COORD_SCALE = 1_000_000        # micro-degrees: ~11 cm, comfortably inside int32
MAX_EDGE_LENGTH_M = 65_535     # uint16 ceiling; longer edges are split
INT16_LIMIT = 32_767           # ~3.6 km per geometry hop

FLAG_DRIVE = 1 << 0
FLAG_WALK = 1 << 1


def _micro(value: float) -> int:
    return int(round(value * COORD_SCALE))


def _tags(data: dict) -> set[str]:
    hw = data.get("highway")
    if isinstance(hw, list):
        return {str(h) for h in hw}
    return {str(hw)} if hw else set()


def _edge_flags(data: dict) -> int:
    tags = _tags(data)
    flags = 0
    if not tags or (tags & DRIVABLE_HIGHWAYS):
        flags |= FLAG_DRIVE
    if not (tags & DRIVE_ONLY_HIGHWAYS):
        flags |= FLAG_WALK
    return flags


def _street_name(data: dict) -> str:
    name = data.get("name")
    if isinstance(name, list):
        name = name[0] if name else None
    if name and str(name) != "nan":
        return str(name)
    hw = data.get("highway")
    if isinstance(hw, list):
        hw = hw[0] if hw else None
    return str(hw).replace("_", " ").title() if hw else ""


def _speed_kph(data: dict) -> int:
    try:
        speed = float(data.get("speed_kph") or 0.0)
    except (TypeError, ValueError):
        speed = 0.0
    if speed <= 0:
        speed = 50.0
    return max(1, min(255, int(round(speed))))


def _edge_geometry(data: dict, u_lat: float, u_lon: float) -> list[tuple[int, int]] | None:
    """Interior shape points as int16 micro-degree deltas, or None if they don't fit."""
    geom = data.get("geometry")
    if geom is None:
        return []
    try:
        coords = list(geom.coords)
    except Exception:
        return []
    if len(coords) <= 2:
        return []

    deltas: list[tuple[int, int]] = []
    prev_lat, prev_lon = _micro(u_lat), _micro(u_lon)
    for lon, lat in coords[1:-1]:
        cur_lat, cur_lon = _micro(lat), _micro(lon)
        d_lat, d_lon = cur_lat - prev_lat, cur_lon - prev_lon
        if abs(d_lat) > INT16_LIMIT or abs(d_lon) > INT16_LIMIT:
            # Too coarse to delta-encode; the renderer falls back to a straight line
            # between the endpoints, which is correct if slightly less pretty.
            return []
        deltas.append((d_lat, d_lon))
        prev_lat, prev_lon = cur_lat, cur_lon
    return deltas


def build_pack(graph: nx.MultiDiGraph, havens: list, region_id: str) -> bytes:
    """Serialise a routable graph plus its safe havens into one .obp buffer."""
    nodes = [n for n, d in graph.nodes(data=True) if "x" in d and "y" in d]
    index_of = {n: i for i, n in enumerate(nodes)}
    node_count = len(nodes)

    lats = [graph.nodes[n]["y"] for n in nodes]
    lons = [graph.nodes[n]["x"] for n in nodes]

    # CSR adjacency, sorted by source node so rows are contiguous.
    edge_offset = [0] * (node_count + 1)
    targets: list[int] = []
    lengths: list[int] = []
    speeds: list[int] = []
    flags: list[int] = []
    name_ids: list[int] = []
    geom_offset: list[int] = [0]
    geom_stream: list[int] = []

    strings: list[str] = [""]
    string_index: dict[str, int] = {"": 0}
    max_speed_kph = 0.0

    for i, node in enumerate(nodes):
        edge_offset[i] = len(targets)
        u_lat, u_lon = graph.nodes[node]["y"], graph.nodes[node]["x"]

        for _, v, data in graph.out_edges(node, data=True):
            if v not in index_of:
                continue

            edge_flags = _edge_flags(data)
            if edge_flags == 0:
                continue

            try:
                length = float(data.get("length") or 0.0)
            except (TypeError, ValueError):
                length = 0.0
            length = max(1, min(MAX_EDGE_LENGTH_M, int(round(length))))

            speed = _speed_kph(data)
            max_speed_kph = max(max_speed_kph, speed)

            name = _street_name(data)
            if name not in string_index:
                if len(strings) >= 65_535:
                    name = ""
                else:
                    string_index[name] = len(strings)
                    strings.append(name)

            deltas = _edge_geometry(data, u_lat, u_lon)
            for d_lat, d_lon in deltas:
                geom_stream.append(d_lat)
                geom_stream.append(d_lon)

            targets.append(index_of[v])
            lengths.append(length)
            speeds.append(speed)
            flags.append(edge_flags)
            name_ids.append(string_index[name])
            geom_offset.append(len(geom_stream))

    edge_offset[node_count] = len(targets)
    edge_count = len(targets)

    # --- assemble sections -------------------------------------------------
    def pad(buf: bytearray) -> None:
        while len(buf) % 4:
            buf.append(0)

    body = bytearray()
    body += struct.pack(f"<{node_count}i", *[_micro(v) for v in lats])
    body += struct.pack(f"<{node_count}i", *[_micro(v) for v in lons])
    body += struct.pack(f"<{node_count + 1}I", *edge_offset)
    body += struct.pack(f"<{edge_count}I", *targets)
    body += struct.pack(f"<{edge_count}H", *lengths)
    pad(body)
    body += struct.pack(f"<{edge_count}B", *speeds)
    pad(body)
    body += struct.pack(f"<{edge_count}B", *flags)
    pad(body)
    body += struct.pack(f"<{edge_count}H", *name_ids)
    pad(body)
    body += struct.pack(f"<{edge_count + 1}I", *geom_offset)

    geometry_offset = HEADER_BYTES + len(body)
    body += struct.pack(f"<{len(geom_stream)}h", *geom_stream)
    geometry_length = len(geom_stream) * 2
    pad(body)

    string_offset = HEADER_BYTES + len(body)
    string_blob = bytearray(struct.pack("<I", len(strings)))
    for text in strings:
        raw = text.encode("utf-8")[:65_535]
        string_blob += struct.pack("<H", len(raw)) + raw
    body += string_blob
    string_length = len(string_blob)
    pad(body)

    haven_offset = HEADER_BYTES + len(body)
    haven_blob = json.dumps(
        [h.model_dump() if hasattr(h, "model_dump") else h for h in havens],
        separators=(",", ":"),
    ).encode("utf-8")
    body += haven_blob

    max_speed_mps = (max_speed_kph / 3.6) if max_speed_kph else 33.3

    header = bytearray(HEADER_BYTES)
    struct.pack_into("<4sI", header, 0, MAGIC, FORMAT_VERSION)
    struct.pack_into(
        "<4i", header, 8,
        _micro(min(lats)), _micro(min(lons)), _micro(max(lats)), _micro(max(lons)),
    )
    struct.pack_into("<IIf", header, 24, node_count, edge_count, max_speed_mps)
    struct.pack_into("<II", header, 36, string_offset, string_length)
    struct.pack_into("<II", header, 44, geometry_offset, geometry_length)
    struct.pack_into("<II", header, 52, haven_offset, len(haven_blob))

    return bytes(header) + bytes(body)


def load_graph(args) -> nx.MultiDiGraph:
    if args.graphml:
        graph = ox.load_graphml(args.graphml)
    elif args.place:
        graph = ox.graph_from_place(args.place, network_type="all", simplify=True)
    elif args.point:
        lat, lon = (float(v) for v in args.point.split(","))
        graph = ox.graph_from_point((lat, lon), dist=args.radius, network_type="all", simplify=True)
    else:
        raise SystemExit("Provide one of --graphml, --place or --point")

    graph = ox.add_edge_speeds(graph, fallback=50)
    return ox.add_edge_travel_times(graph)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a OneBar offline region pack")
    parser.add_argument("--id", required=True, help="region id, e.g. lower-manhattan")
    parser.add_argument("--name", help="human-readable region name")
    parser.add_argument("--place", help="OSM place name")
    parser.add_argument("--point", help="lat,lon centre")
    parser.add_argument("--radius", type=float, default=1500.0, help="metres around --point")
    parser.add_argument("--graphml", help="build from an existing .graphml instead of downloading")
    parser.add_argument("--out-dir", default="packs")
    parser.add_argument("--no-havens", action="store_true", help="skip OSM safe-haven discovery")
    args = parser.parse_args()

    graph = load_graph(args)

    lats = [d["y"] for _, d in graph.nodes(data=True) if "y" in d]
    lons = [d["x"] for _, d in graph.nodes(data=True) if "x" in d]
    bounds = {
        "min_lat": min(lats), "max_lat": max(lats),
        "min_lon": min(lons), "max_lon": max(lons),
    }

    havens = [] if args.no_havens else fetch_osm_safe_havens(bounds)
    if not args.no_havens and not havens:
        print("WARNING: no safe havens found for this region. The pack will ship "
              "without shelters rather than with invented ones.")

    blob = build_pack(graph, havens, args.id)

    os.makedirs(args.out_dir, exist_ok=True)
    pack_path = os.path.join(args.out_dir, f"{args.id}.obp")
    with open(pack_path, "wb") as f:
        f.write(blob)

    import hashlib
    entry = {
        "id": args.id,
        "name": args.name or args.place or args.id,
        "bounds": {k: round(v, 6) for k, v in bounds.items()},
        "bytes": len(blob),
        "node_count": graph.number_of_nodes(),
        "edge_count": graph.number_of_edges(),
        "haven_count": len(havens),
        "sha256": hashlib.sha256(blob).hexdigest(),
        "format_version": FORMAT_VERSION,
    }

    index_path = os.path.join(args.out_dir, "index.json")
    index = []
    if os.path.exists(index_path):
        with open(index_path, encoding="utf-8") as f:
            index = [r for r in json.load(f).get("regions", []) if r["id"] != args.id]
    index.append(entry)
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump({"regions": sorted(index, key=lambda r: r["id"])}, f, indent=2)

    per_node = len(blob) / max(1, graph.number_of_nodes())
    print(f"{pack_path}: {len(blob) / 1e6:.2f} MB for {graph.number_of_nodes()} nodes "
          f"({per_node:.0f} B/node), {len(havens)} havens")


if __name__ == "__main__":
    main()
