import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from shapely.geometry import LineString
from shapely.strtree import STRtree

from schemas import LatLon
from spatial import (
    blocked_edges_for_polygon,
    buffer_polygon,
    calculate_bearing,
    create_circle_polygon,
    get_turn_type,
    haversine,
    to_shapely_polygon,
)


def test_polygon_roundtrip():
    coords = [LatLon(lat=40.71, lon=-74.01), LatLon(lat=40.72, lon=-74.01),
              LatLon(lat=40.72, lon=-74.00), LatLon(lat=40.71, lon=-74.00)]
    poly = to_shapely_polygon(coords)
    assert poly.is_valid and poly.exterior.is_closed


def test_circle_polygon_and_buffer():
    poly = create_circle_polygon(40.7128, -74.0060, radius_meters=100.0)
    assert poly.is_valid and poly.exterior.is_closed
    buffered = buffer_polygon(poly, buffer_meters=50.0)
    assert buffered.area > poly.area


def test_bearings_and_turns():
    # Due North: lat increases, lon constant -> 0 deg
    bearing_north = calculate_bearing(40.70, -74.00, 40.71, -74.00)
    assert abs(bearing_north - 0.0) < 1.0

    # Due East: lat constant, lon increases -> ~90 deg
    bearing_east = calculate_bearing(40.70, -74.00, 40.70, -73.99)
    assert abs(bearing_east - 90.0) < 1.0

    # Turn from North (0) to East (90) -> turn_right
    assert get_turn_type(0.0, 90.0) == "turn_right"
    # Turn from North (0) to West (270) -> turn_left
    assert get_turn_type(0.0, 270.0) == "turn_left"
    # Turn from North (0) to North-Northeast (25) -> slight_right
    assert get_turn_type(0.0, 25.0) == "slight_right"


def test_blocked_edges():
    line_inside = LineString([(-74.005, 40.715), (-74.005, 40.725)])
    line_outside = LineString([(-74.050, 40.750), (-74.060, 40.760)])
    linestrings = [line_inside, line_outside]
    edge_keys = [(1, 2, 0), (3, 4, 0)]
    tree = STRtree(linestrings)

    hazard = to_shapely_polygon([
        LatLon(lat=40.710, lon=-74.010), LatLon(lat=40.730, lon=-74.010),
        LatLon(lat=40.730, lon=-74.000), LatLon(lat=40.710, lon=-74.000),
    ])
    blocked = blocked_edges_for_polygon(hazard, tree, linestrings, edge_keys)
    assert (1, 2, 0) in blocked
    assert (3, 4, 0) not in blocked


def test_haversine():
    dist = haversine(40.7128, -74.0060, 51.5074, -0.1278)
    assert 5_500_000 < dist < 5_650_000
    assert haversine(40.7128, -74.0060, 40.7128, -74.0060) == 0.0
