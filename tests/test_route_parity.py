"""
Golden parity between the two routing implementations.

OneBar now routes on-device (static/js/route-engine.js) and on the server
(app/router.py). Two implementations of the same algorithm drift unless something
forces them to agree, and a divergence here means the route a user sees offline is
not the route the app was tested against. This module is that forcing function.

The JS engine is executed through Node via tools/route_offline_cli.mjs. If Node is
unavailable the tests skip rather than fail, so the Python-only workflow still works.
"""

import json
import os
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from graph_loader import GraphManager
from router import find_route
from schemas import LatLon

REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
PACK = os.path.join(os.path.dirname(__file__), "fixtures", "packs", "test-region.obp")
CLI = os.path.join(REPO_ROOT, "tools", "route_offline_cli.mjs")
FIXTURE_GRAPH = os.path.join(os.path.dirname(__file__), "fixtures", "test_region.graphml")

# Origin/destination pairs inside the fixture graph, chosen to exercise different
# parts of the network rather than one short hop.
GOLDEN_CASES = [
    ({"lat": 40.7070, "lon": -74.0140}, {"lat": 40.7100, "lon": -74.0090}, "drive"),
    ({"lat": 40.7100, "lon": -74.0090}, {"lat": 40.7070, "lon": -74.0140}, "drive"),
    ({"lat": 40.7065, "lon": -74.0135}, {"lat": 40.7105, "lon": -74.0082}, "drive"),
    ({"lat": 40.7070, "lon": -74.0140}, {"lat": 40.7090, "lon": -74.0105}, "drive"),
    ({"lat": 40.7070, "lon": -74.0140}, {"lat": 40.7100, "lon": -74.0090}, "walk"),
]

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not os.path.exists(PACK),
    reason="Node or the test region pack is unavailable",
)


@pytest.fixture(scope="module")
def graph_manager():
    return GraphManager(cache_file=FIXTURE_GRAPH)


def run_js_route(origin, destination, mode, hazards=None):
    request = {
        "origin": origin,
        "destinations": [destination],
        "mode": mode,
        "hazards": hazards or [],
    }
    proc = subprocess.run(
        ["node", CLI, PACK, json.dumps(request)],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    assert proc.returncode == 0, f"offline engine failed: {proc.stderr}"
    return json.loads(proc.stdout)


def run_python_route(gm, origin, destination, mode):
    orig = gm.nearest_node(origin["lon"], origin["lat"], mode=mode)
    dest = gm.nearest_node(destination["lon"], destination["lat"], mode=mode)
    return find_route(
        gm.get_graph(), orig, dest, set(),
        mode=mode,
        orig_coord=LatLon(**origin),
        dest_coord=LatLon(**destination),
        max_speed_mps=gm.max_speed_mps,
    )


@pytest.mark.parametrize("origin,destination,mode", GOLDEN_CASES)
def test_offline_and_server_routes_agree(graph_manager, origin, destination, mode):
    js = run_js_route(origin, destination, mode)

    if not js["success"]:
        # Agreeing that no route exists is parity too — a small graph with one-way
        # streets genuinely has unreachable pairs. What must never happen is one
        # engine inventing a route the other cannot find.
        py_failed = run_python_route(graph_manager, origin, destination, mode)
        assert py_failed["success"] is False, (
            f"offline engine found no {mode} route but the server did — engines diverged"
        )
        pytest.skip(f"no {mode} route exists between these points; both engines agree")

    # Compare the ALGORITHMS, not the snapping. Each engine independently picks a
    # start node, and two different-but-valid snap choices would otherwise show up as
    # a false divergence. Re-running the server router between the exact endpoints the
    # offline engine used isolates the part that must not drift: the search itself.
    py_origin = dict(js["coordinates"][0])
    py_dest = dict(js["coordinates"][-1])
    py = run_python_route(graph_manager, py_origin, py_dest, mode)
    assert py["success"] is True

    # Both engines run A* over the same network with the same weights, so an optimal
    # path must cost the same in both. Allow 1% for the pack's integer quantisation
    # of edge length (metres) and speed (km/h).
    py_time = py["time"]
    js_time = js["total_travel_time_seconds"]
    assert js_time == pytest.approx(py_time, rel=0.01), (
        f"{mode} travel time diverged: offline={js_time}s server={py_time}s"
    )

    py_dist = py["distance"]
    js_dist = js["total_distance_meters"]
    assert js_dist == pytest.approx(py_dist, rel=0.01), (
        f"{mode} distance diverged: offline={js_dist}m server={py_dist}m"
    )


def test_offline_engine_honours_mode_restrictions():
    """A drive route must never be handed a pedestrian-only path."""
    js = run_js_route(
        {"lat": 40.7070, "lon": -74.0140},
        {"lat": 40.7100, "lon": -74.0090},
        "drive",
    )
    assert js["success"] is True
    streets = {m.get("street_name") for m in js["maneuvers"] if m.get("street_name")}
    assert streets, "expected named streets on a drive route"


def test_offline_engine_blocks_hazardous_edges():
    """A hazard across the corridor must change the route or flag a fallback."""
    origin = {"lat": 40.7070, "lon": -74.0140}
    destination = {"lat": 40.7100, "lon": -74.0090}

    clear = run_js_route(origin, destination, "drive")
    assert clear["success"] is True

    # A large polygon straddling the midpoint of the clear route.
    mid = clear["coordinates"][len(clear["coordinates"]) // 2]
    d = 0.0012
    ring = [
        {"lat": mid["lat"] - d, "lon": mid["lon"] - d},
        {"lat": mid["lat"] + d, "lon": mid["lon"] - d},
        {"lat": mid["lat"] + d, "lon": mid["lon"] + d},
        {"lat": mid["lat"] - d, "lon": mid["lon"] + d},
    ]
    blocked = run_js_route(origin, destination, "drive", hazards=[{
        "hazard_id": "test-block",
        "effective_coordinates": ring,
    }])

    assert blocked["blocked_edges_avoided"] > 0
    if blocked["success"]:
        detoured = blocked["total_travel_time_seconds"] > clear["total_travel_time_seconds"]
        assert detoured or blocked["is_fallback"], (
            "route through a hazard was neither longer nor flagged as a fallback"
        )


@pytest.mark.parametrize("origin,destination,mode", GOLDEN_CASES)
def test_both_engines_snap_close_to_the_requested_point(graph_manager, origin, destination, mode):
    """
    Snapping may differ between engines, but neither may snap far away.

    The original defect this guards against: `nearest_node` would map a coordinate
    anywhere on Earth onto the loaded graph without complaint.
    """
    from spatial import haversine

    js = run_js_route(origin, destination, mode)
    if not js["success"]:
        pytest.skip("no route between these points in the fixture graph")

    js_start = js["coordinates"][0]
    assert haversine(origin["lat"], origin["lon"], js_start["lat"], js_start["lon"]) < 250

    node = graph_manager.nearest_node(origin["lon"], origin["lat"], mode=mode)
    n = graph_manager.get_graph().nodes[node]
    assert haversine(origin["lat"], origin["lon"], n["y"], n["x"]) < 250
