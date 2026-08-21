import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import networkx as nx
from shapely.geometry import LineString

from router import encode_polyline, find_route, generate_maneuvers, path_to_coords
from schemas import LatLon


def make_graph() -> nx.MultiDiGraph:
    r"""
    Simple diamond network:
        1 --(top: Broadway)--> 2 --> 4
        \                             /
         +--(bottom: Fulton St)-> 3-+
    """
    G = nx.MultiDiGraph()
    G.add_node(1, x=-74.01, y=40.71)
    G.add_node(2, x=-74.00, y=40.72)
    G.add_node(3, x=-74.00, y=40.70)
    G.add_node(4, x=-73.99, y=40.71)

    G.add_edge(1, 2, key=0, length=100.0, travel_time=10.0, name="Broadway", geometry=LineString([(-74.01, 40.71), (-74.00, 40.72)]))
    G.add_edge(2, 4, key=0, length=100.0, travel_time=10.0, name="Park Row", geometry=LineString([(-74.00, 40.72), (-73.99, 40.71)]))
    G.add_edge(1, 3, key=0, length=120.0, travel_time=12.0, name="Fulton St", geometry=LineString([(-74.01, 40.71), (-74.00, 40.70)]))
    G.add_edge(3, 4, key=0, length=120.0, travel_time=12.0, name="Water St", geometry=LineString([(-74.00, 40.70), (-73.99, 40.71)]))
    return G


def test_clear_path():
    result = find_route(make_graph(), 1, 4, set())
    assert result["success"] and result["path"] == [1, 2, 4]
    assert result["time"] == 20.0 and result["distance"] == 200.0
    assert "maneuvers" in result
    assert len(result["maneuvers"]) >= 2
    assert result["maneuvers"][0].type == "depart"
    assert result["maneuvers"][-1].type == "arrive"


def test_avoids_hazard():
    result = find_route(make_graph(), 1, 4, {(1, 2, 0)})
    assert result["success"] and result["path"] == [1, 3, 4]


def test_walk_mode():
    result = find_route(make_graph(), 1, 4, set(), mode="walk")
    assert result["success"] and result["distance"] == 200.0


def test_fallback_when_isolated():
    result = find_route(make_graph(), 1, 4, {(1, 2, 0), (1, 3, 0)}, allow_fallback=True)
    assert result["success"] and result["is_fallback"]


def test_maneuvers_details():
    G = make_graph()
    maneuvers = generate_maneuvers(G, [1, 2, 4])
    assert len(maneuvers) >= 2
    assert "Broadway" in maneuvers[0].instruction
    assert maneuvers[-1].type == "arrive"


def test_encode_polyline():
    poly = encode_polyline([LatLon(lat=40.71, lon=-74.01), LatLon(lat=40.72, lon=-74.00)])
    assert isinstance(poly, str) and len(poly) > 0


def test_path_to_coords():
    coords = path_to_coords(make_graph(), [1, 2, 4])
    assert len(coords) >= 3 and coords[0].lat == 40.71
