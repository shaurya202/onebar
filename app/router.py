from typing import Any
import networkx as nx
import osmnx as ox
import polyline as polyline_lib
from shapely.geometry import LineString

from schemas import AlternativeHaven, EdgeKey, LatLon, Maneuver, SafeHaven
from spatial import calculate_bearing, format_bearing_cardinal, get_turn_type, haversine

WALK_SPEED = 1.389   # m/s  (~5 km/h)
DRIVE_SPEED = 13.88  # m/s  (~50 km/h)


def _build_routing_graph(
    graph: nx.MultiDiGraph,
    blocked_edges: set[EdgeKey],
    mode: str,
    impassable: bool,
    penalty: float = 100.0,
) -> nx.MultiDiGraph:
    G = graph.copy()
    speed = WALK_SPEED if mode == "walk" else DRIVE_SPEED

    for u, v, k, data in G.edges(keys=True, data=True):
        length = data.get("length", 10.0)
        data["w"] = length / speed if mode == "walk" else data.get("travel_time", length / DRIVE_SPEED)

    for u, v, k in blocked_edges:
        if not G.has_edge(u, v, k):
            continue
        if impassable:
            G.remove_edge(u, v, k)
        else:
            G[u][v][k]["w"] *= penalty

    return G


def _astar(G: nx.MultiDiGraph, src: int, dst: int, base_graph: nx.MultiDiGraph, mode: str) -> list[int]:
    # Use max speed (33.3 m/s = 120 km/h) for drive heuristic to guarantee admissible A*
    speed = 33.3 if mode == "drive" else WALK_SPEED

    def heuristic(u: int, v: int) -> float:
        n, m = base_graph.nodes[u], base_graph.nodes[v]
        return ox.distance.great_circle(n["y"], n["x"], m["y"], m["x"]) / speed

    return nx.astar_path(G, src, dst, heuristic=heuristic, weight="w")


def generate_maneuvers(
    graph: nx.MultiDiGraph,
    path: list[int],
    mode: str = "drive",
    orig_coord: LatLon | None = None,
    dest_coord: LatLon | None = None,
) -> list[Maneuver]:
    """Generate human-readable turn-by-turn evacuation instructions with street names."""
    if not path:
        return []

    speed = WALK_SPEED if mode == "walk" else DRIVE_SPEED

    if len(path) == 1:
        loc = orig_coord or LatLon(
            lat=round(graph.nodes[path[0]]["y"], 6),
            lon=round(graph.nodes[path[0]]["x"], 6),
        )
        dest_loc = dest_coord or loc
        dist = haversine(loc.lat, loc.lon, dest_loc.lat, dest_loc.lon) if (orig_coord and dest_coord) else 0.0
        return [
            Maneuver(
                type="depart",
                instruction="Depart towards destination",
                street_name="Local Way",
                distance_meters=round(dist, 1),
                travel_time_seconds=round(dist / speed, 1),
                location=loc,
            ),
            Maneuver(
                type="arrive",
                instruction="Arrive at evacuation destination",
                street_name=None,
                distance_meters=0.0,
                travel_time_seconds=0.0,
                location=dest_loc,
            ),
        ]

    maneuvers: list[Maneuver] = []
    current: Maneuver | None = None
    last_bearing: float | None = None

    for i, (u, v) in enumerate(zip(path[:-1], path[1:])):
        edges = graph.get_edge_data(u, v)
        if not edges:
            continue
        best = min(edges.values(), key=lambda e: e.get("travel_time", float("inf")))
        length = float(best.get("length", 10.0))
        t_time = float(length / speed if mode == "walk" else best.get("travel_time", length / DRIVE_SPEED))

        # Extract street name
        name_val = best.get("name")
        if isinstance(name_val, list):
            street_name = name_val[0] if name_val else None
        else:
            street_name = name_val

        if not street_name:
            hw = best.get("highway")
            if isinstance(hw, list):
                hw = hw[0]
            street_name = hw.replace("_", " ").title() if hw else "Connecting Road"

        u_node = graph.nodes[u]
        v_node = graph.nodes[v]
        u_lat, u_lon = float(u_node["y"]), float(u_node["x"])
        v_lat, v_lon = float(v_node["y"]), float(v_node["x"])
        edge_bearing = calculate_bearing(u_lat, u_lon, v_lat, v_lon)

        if current is None:
            cardinal = format_bearing_cardinal(edge_bearing)
            current = Maneuver(
                type="depart",
                instruction=f"Head {cardinal} on {street_name}",
                street_name=street_name,
                distance_meters=round(length, 1),
                travel_time_seconds=round(t_time, 1),
                location=orig_coord if (i == 0 and orig_coord) else LatLon(lat=round(u_lat, 6), lon=round(u_lon, 6)),
            )
            last_bearing = edge_bearing
        else:
            turn = get_turn_type(last_bearing, edge_bearing)
            if turn == "straight" and (street_name == current.street_name or street_name == "Connecting Road"):
                current.distance_meters = round(current.distance_meters + length, 1)
                current.travel_time_seconds = round(current.travel_time_seconds + t_time, 1)
                last_bearing = edge_bearing
            else:
                maneuvers.append(current)

                instruction_map = {
                    "straight": f"Continue onto {street_name}",
                    "slight_left": f"Bear slight left onto {street_name}",
                    "turn_left": f"Turn left onto {street_name}",
                    "sharp_left": f"Take sharp left onto {street_name}",
                    "slight_right": f"Bear slight right onto {street_name}",
                    "turn_right": f"Turn right onto {street_name}",
                    "sharp_right": f"Take sharp right onto {street_name}",
                    "u_turn": f"Make a U-turn onto {street_name}",
                }
                instruction = instruction_map.get(turn, f"Turn onto {street_name}")

                current = Maneuver(
                    type=turn,
                    instruction=instruction,
                    street_name=street_name,
                    distance_meters=round(length, 1),
                    travel_time_seconds=round(t_time, 1),
                    location=LatLon(lat=round(u_lat, 6), lon=round(u_lon, 6)),
                )
                last_bearing = edge_bearing

    if current:
        maneuvers.append(current)

    final_node = graph.nodes[path[-1]]
    dest_loc = dest_coord or LatLon(lat=round(final_node["y"], 6), lon=round(final_node["x"], 6))
    maneuvers.append(
        Maneuver(
            type="arrive",
            instruction="Arrive at evacuation destination",
            street_name=None,
            distance_meters=0.0,
            travel_time_seconds=0.0,
            location=dest_loc,
        )
    )

    return maneuvers


def find_route(
    graph: nx.MultiDiGraph,
    orig: int,
    dest: int,
    blocked_edges: set[EdgeKey],
    mode: str = "drive",
    allow_fallback: bool = True,
    orig_coord: LatLon | None = None,
    dest_coord: LatLon | None = None,
) -> dict:
    G = _build_routing_graph(graph, blocked_edges, mode, impassable=True)

    try:
        path = _astar(G, orig, dest, graph, mode)
        is_fallback, warning = False, None
    except nx.NetworkXNoPath:
        if not (allow_fallback and blocked_edges):
            return {"success": False, "error": "No viable route found avoiding active hazards."}
        G = _build_routing_graph(graph, blocked_edges, mode, impassable=False)
        try:
            path = _astar(G, orig, dest, graph, mode)
            is_fallback = True
            warning = "Clear paths blocked — routing via lowest-risk alternative."
        except nx.NetworkXNoPath:
            return {"success": False, "error": "No viable route found between origin and destination."}

    speed = WALK_SPEED if mode == "walk" else DRIVE_SPEED
    total_time = total_dist = 0.0

    for u, v in zip(path[:-1], path[1:]):
        edges = G.get_edge_data(u, v)
        if edges:
            best = min(edges.values(), key=lambda e: e.get("w", float("inf")))
            length = best.get("length", 0.0)
            total_dist += length
            total_time += length / speed if mode == "walk" else best.get("travel_time", length / DRIVE_SPEED)

    if total_dist == 0.0 and orig_coord and dest_coord:
        direct = haversine(orig_coord.lat, orig_coord.lon, dest_coord.lat, dest_coord.lon)
        total_dist = direct
        total_time = direct / speed

    maneuvers = generate_maneuvers(graph, path, mode=mode, orig_coord=orig_coord, dest_coord=dest_coord)

    return {
        "success": True,
        "path": path,
        "time": round(total_time, 1),
        "distance": round(total_dist, 1),
        "blocked": len(blocked_edges),
        "is_fallback": is_fallback,
        "warning": warning,
        "maneuvers": maneuvers,
    }


def find_fastest_route_to_safety(
    graph: nx.MultiDiGraph,
    graph_manager: Any,
    orig_coord: LatLon,
    safe_candidates: list[SafeHaven],
    blocked_edges: set[EdgeKey],
    mode: str = "drive",
    allow_fallback: bool = True,
    encode_polyline_flag: bool = False,
) -> dict:
    """
    Evaluate all uncompromised safe havens and escape routes to automatically compute
    the globally fastest and safest evacuation route avoiding all active hazards.
    """
    if not safe_candidates:
        # Fallback: create emergency perimeter haven
        d_lat, d_lon = 0.015, 0.015
        safe_candidates = [
            SafeHaven(
                id="haven-auto-perimeter",
                name="Perimeter Safe Clearance Zone",
                type="perimeter_exit",
                location=LatLon(lat=round(orig_coord.lat + d_lat, 6), lon=round(orig_coord.lon + d_lon, 6)),
                address="Clear Zone outside Hazard Influence",
                capacity=None,
                is_compromised=False,
            )
        ]

    orig_node = graph_manager.nearest_node(orig_coord.lon, orig_coord.lat)
    candidate_results = []

    for haven in safe_candidates:
        dest_node = graph_manager.nearest_node(haven.location.lon, haven.location.lat)
        res = find_route(
            graph,
            orig_node,
            dest_node,
            blocked_edges,
            mode=mode,
            allow_fallback=allow_fallback,
            orig_coord=orig_coord,
            dest_coord=haven.location,
        )
        if res["success"]:
            candidate_results.append({
                "haven": haven,
                "result": res,
                "time": res["time"],
                "distance": res["distance"],
                "is_fallback": res["is_fallback"],
            })

    if not candidate_results:
        return {
            "success": False,
            "error": "No viable evacuation route to any safe haven could be constructed avoiding active hazard zones.",
        }

    # Rank: prefer non-fallback routes first, then lowest travel time
    candidate_results.sort(key=lambda item: (1 if item["is_fallback"] else 0, item["time"]))

    best = candidate_results[0]
    best_haven = best["haven"]
    best_res = best["result"]

    coords = path_to_coords(graph, best_res["path"], orig_coord, best_haven.location)
    polyline_str = encode_polyline(coords) if encode_polyline_flag else None

    # Compile alternative destinations
    alternatives = [
        AlternativeHaven(
            id=item["haven"].id,
            name=item["haven"].name,
            type=item["haven"].type,
            location=item["haven"].location,
            travel_time_seconds=item["time"],
            distance_meters=item["distance"],
        )
        for item in candidate_results[1:5]
    ]

    return {
        "success": True,
        "destination_safe_haven": best_haven,
        "coordinates": coords,
        "polyline": polyline_str,
        "total_travel_time_seconds": best_res["time"],
        "total_distance_meters": best_res["distance"],
        "blocked_edges_avoided": best_res["blocked"],
        "is_fallback": best_res["is_fallback"],
        "warning": best_res["warning"],
        "maneuvers": best_res.get("maneuvers", []),
        "alternatives": alternatives,
    }


def path_to_coords(
    graph: nx.MultiDiGraph,
    path: list[int],
    orig_coord: LatLon | None = None,
    dest_coord: LatLon | None = None,
) -> list[LatLon]:
    """Walk node pairs, preferring road geometry over straight lines."""
    points: list[LatLon] = []

    for i, (u, v) in enumerate(zip(path[:-1], path[1:])):
        edges = graph.get_edge_data(u, v)
        geom: LineString | None = None
        if edges:
            best = min(edges.values(), key=lambda e: e.get("travel_time", float("inf")))
            geom = best.get("geometry")

        if geom:
            coords = list(geom.coords)
            if i > 0:
                coords = coords[1:]  # drop shared vertex at segment joins
            points.extend(LatLon(lat=round(lat, 6), lon=round(lon, 6)) for lon, lat in coords)
        else:
            if i == 0:
                n = graph.nodes[u]
                points.append(LatLon(lat=round(n["y"], 6), lon=round(n["x"], 6)))
            n = graph.nodes[v]
            points.append(LatLon(lat=round(n["y"], 6), lon=round(n["x"], 6)))

    if not points and path:
        node_coords = [
            LatLon(lat=round(graph.nodes[n]["y"], 6), lon=round(graph.nodes[n]["x"], 6))
            for n in path
        ]
        if orig_coord and dest_coord and (orig_coord.lat != dest_coord.lat or orig_coord.lon != dest_coord.lon):
            return [orig_coord, *node_coords, dest_coord]
        return node_coords

    return points


def encode_polyline(coords: list[LatLon]) -> str:
    return polyline_lib.encode([(c.lat, c.lon) for c in coords])