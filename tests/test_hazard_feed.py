import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from hazard_feed import (
    _classify_hazard_type,
    _extract_polygon_coords_from_geojson_geom,
    generate_scenario_hazards,
    fetch_all_external_hazards,
)


def test_classify_hazard_type():
    assert _classify_hazard_type("Flash Flood Warning") == "flood"
    assert _classify_hazard_type("Red Flag Warning", "Wildfire risk high") == "wildfire"
    assert _classify_hazard_type("High Voltage Power Line Down") == "powerline"
    assert _classify_hazard_type("Earthquake Aftershock Collapse") == "collapse"
    assert _classify_hazard_type("Tree Blockade and Mudslide") == "debris"
    assert _classify_hazard_type("Road Obstruction") == "debris"
    assert _classify_hazard_type("Police Checkpoint Closure") == "closure"


def test_extract_polygon_coords_from_geojson_geom():
    poly_geom = {
        "type": "Polygon",
        "coordinates": [
            [[-74.006, 40.712], [-74.002, 40.715], [-74.001, 40.710], [-74.006, 40.712]]
        ]
    }
    coords = _extract_polygon_coords_from_geojson_geom(poly_geom)
    assert coords is not None
    assert len(coords) == 4
    assert coords[0].lat == 40.712
    assert coords[0].lon == -74.006


def test_generate_scenario_hazards():
    hazards = generate_scenario_hazards(40.7128, -74.0060)
    assert len(hazards) >= 3
    types = [h["hazard_type"] for h in hazards]
    assert "flood" in types
    assert "powerline" in types
    assert "debris" in types


def test_fetch_all_external_hazards_simulation():
    hazards, sources = fetch_all_external_hazards(
        center_lat=40.7128,
        center_lon=-74.0060,
        sources=["simulation"],
    )
    assert len(hazards) > 0
    assert "crisis_feed" in sources
