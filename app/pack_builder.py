"""
Region pack construction.

The .obp format and serialiser used to live only in tools/build_pack.py, which
kept packs a strictly offline build step. Moving the core here lets a deployment
also offer *on-demand* coverage — an operator-gated endpoint builds a pack for
wherever a user actually is — without duplicating the binary layout. The CLI is
now a thin wrapper around this module, so the two can never drift apart.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import struct
from datetime import UTC, datetime

import networkx as nx
import osmnx as ox

from graph_loader import DRIVABLE_HIGHWAYS, DRIVE_ONLY_HIGHWAYS
from haven_sources import fetch_osm_safe_havens

logger = logging.getLogger("onebar.pack_builder")

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


# --- Whole-region pipeline ----------------------------------------------------

def fetch_graph(place: str | None = None, point: tuple[float, float] | None = None,
                radius_m: float | None = None, graphml: str | None = None) -> nx.MultiDiGraph:
    """Download (or load) a routable OSMnx graph, with speeds and travel times."""
    if graphml:
        graph = ox.load_graphml(graphml)
    elif place:
        graph = ox.graph_from_place(place, network_type="all", simplify=True)
    elif point:
        graph = ox.graph_from_point(point, dist=radius_m or 1500.0,
                                    network_type="all", simplify=True)
    else:
        raise ValueError("Provide one of graphml, place or point")

    graph = ox.add_edge_speeds(graph, fallback=50)
    return ox.add_edge_travel_times(graph)


def graph_bounds(graph: nx.MultiDiGraph) -> dict:
    lats = [d["y"] for _, d in graph.nodes(data=True) if "y" in d]
    lons = [d["x"] for _, d in graph.nodes(data=True) if "x" in d]
    return {
        "min_lat": min(lats), "max_lat": max(lats),
        "min_lon": min(lons), "max_lon": max(lons),
    }


def catalogue_entry(region_id: str, name: str, blob: bytes, graph: nx.MultiDiGraph,
                    havens: list, bounds: dict) -> dict:
    return {
        "id": region_id,
        "name": name,
        "bounds": {k: round(v, 6) for k, v in bounds.items()},
        "bytes": len(blob),
        "node_count": graph.number_of_nodes(),
        "edge_count": graph.number_of_edges(),
        "haven_count": len(havens),
        "sha256": hashlib.sha256(blob).hexdigest(),
        "format_version": FORMAT_VERSION,
    }


def build_region_pack(
    region_id: str,
    name: str,
    place: str | None = None,
    point: tuple[float, float] | None = None,
    radius_m: float | None = None,
    include_havens: bool = True,
) -> tuple[bytes, dict]:
    """Fetch a region and produce the pack blob plus its catalogue entry."""
    graph = fetch_graph(place=place, point=point, radius_m=radius_m)
    bounds = graph_bounds(graph)

    havens: list = []
    if include_havens:
        havens = fetch_osm_safe_havens(bounds)
        if not havens:
            logger.warning("No safe havens found for %s; shipping without shelters.", region_id)

    blob = build_pack(graph, havens, region_id)
    return blob, catalogue_entry(region_id, name, blob, graph, havens, bounds)


def write_pack(out_dir: str, entry: dict, blob: bytes) -> str:
    """Write one pack and upsert its catalogue entry. Returns the pack path."""
    os.makedirs(out_dir, exist_ok=True)
    pack_path = os.path.join(out_dir, f"{entry['id']}.obp")
    temp_path = f"{pack_path}.tmp"
    with open(temp_path, "wb") as f:
        f.write(blob)
    os.replace(temp_path, pack_path)

    index_path = os.path.join(out_dir, "index.json")
    index: list = []
    if os.path.exists(index_path):
        try:
            with open(index_path, encoding="utf-8") as f:
                index = [r for r in json.load(f).get("regions", []) if r["id"] != entry["id"]]
        except Exception as e:
            logger.warning("Could not read pack index %s: %s", index_path, e)
    stamped = dict(entry, published_at=datetime.now(UTC).isoformat())
    index.append(stamped)
    temp_index = f"{index_path}.tmp"
    with open(temp_index, "w", encoding="utf-8") as f:
        json.dump({"regions": sorted(index, key=lambda r: r["id"])}, f, indent=2)
    os.replace(temp_index, index_path)

    return pack_path


def per_node_bytes(blob: bytes, node_count: int) -> float:
    return len(blob) / max(1, node_count)
