import sys
import os
import tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from shapely.geometry import LineString
from shapely.strtree import STRtree

from schemas import LatLon
from hazard_store import HazardStore


def test_crud():
    store = HazardStore(persistence_file=None)
    coords = [LatLon(lat=40.71, lon=-74.01), LatLon(lat=40.72, lon=-74.01), LatLon(lat=40.72, lon=-74.00)]

    zone = store.add(coordinates=coords, name="Test Wildfire", hazard_type="wildfire")
    assert zone.hazard_id and zone.name == "Test Wildfire"
    assert len(store.list()) == 1

    assert store.get(zone.hazard_id).hazard_id == zone.hazard_id
    assert store.remove(zone.hazard_id)
    assert store.get(zone.hazard_id) is None


def test_radial_hazard_and_buffer():
    store = HazardStore(persistence_file=None)
    zone = store.add(
        center=LatLon(lat=40.7128, lon=-74.0060),
        radius_meters=150.0,
        buffer_meters=25.0,
        name="Powerline Hazard",
        hazard_type="debris",
    )
    assert zone.hazard_id
    assert zone.radius_meters == 150.0
    assert len(zone.coordinates) >= 3


def test_persistence():
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
        temp_path = tf.name

    try:
        store1 = HazardStore(persistence_file=temp_path)
        z1 = store1.add(
            coordinates=[LatLon(lat=40.71, lon=-74.01), LatLon(lat=40.72, lon=-74.01), LatLon(lat=40.72, lon=-74.00)],
            name="Persistent Hazard",
        )
        assert len(store1.list()) == 1

        # Reopen store from same file
        store2 = HazardStore(persistence_file=temp_path)
        assert len(store2.list()) == 1
        assert store2.get(z1.hazard_id).name == "Persistent Hazard"
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


def test_blocked_edges():
    store = HazardStore(persistence_file=None)
    store.add(coordinates=[
        LatLon(lat=40.710, lon=-74.010), LatLon(lat=40.730, lon=-74.010),
        LatLon(lat=40.730, lon=-74.000), LatLon(lat=40.710, lon=-74.000),
    ], name="Flood", hazard_type="flood")

    linestrings = [
        LineString([(-74.005, 40.715), (-74.005, 40.725)]),
        LineString([(-74.050, 40.750), (-74.060, 40.760)]),
    ]
    edge_keys = [(1, 2, 0), (3, 4, 0)]
    tree = STRtree(linestrings)

    blocked = store.blocked_edges(tree, linestrings, edge_keys)
    assert (1, 2, 0) in blocked
    assert (3, 4, 0) not in blocked

    assert store.clear() == 1
    assert store.list() == []
