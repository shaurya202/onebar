"""
Build an offline region pack (.obp) — a compact, routable road graph the client can
use with no network at all.

Run offline as a build step; never in the request path. (The on-demand endpoint in
app/api.py reuses the same builder under an operator opt-in, so this CLI and that
endpoint can never drift apart.)

    python tools/build_pack.py --place "Lower Manhattan, New York, USA" --id lower-manhattan
    python tools/build_pack.py --point 40.7075,-74.0113 --radius 1200 --id battery-park

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
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))

import pack_builder


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

    point = None
    if args.point:
        lat, lon = (float(v) for v in args.point.split(","))
        point = (lat, lon)

    graph = pack_builder.fetch_graph(
        place=args.place, point=point, radius_m=args.radius, graphml=args.graphml,
    )
    bounds = pack_builder.graph_bounds(graph)

    havens: list = []
    if not args.no_havens:
        havens = pack_builder.fetch_osm_safe_havens(bounds)
        print(f"discovered {len(havens)} safe havens")

    blob = pack_builder.build_pack(graph, havens, args.id)
    entry = pack_builder.catalogue_entry(
        args.id,
        args.name or args.place or args.id,
        blob, graph, havens, bounds,
    )
    pack_path = pack_builder.write_pack(args.out_dir, entry, blob)

    per_node = pack_builder.per_node_bytes(blob, graph.number_of_nodes())
    print(f"{pack_path}: {len(blob) / 1e6:.2f} MB for {graph.number_of_nodes()} nodes "
          f"({per_node:.0f} B/node), {len(havens)} havens")


if __name__ == "__main__":
    main()
