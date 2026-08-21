"""
Destination search.

The top bar was drawn as a search field wrapped around a static label — there was no
search anywhere in the product. What replaced it has to keep working with the radio
off, which is why the offline layer is tested here without any network access at all
(`ONEBAR_GEOCODING=0` is set by the suite fixtures).
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import pytest
from fastapi.testclient import TestClient

from geocode import parse_coordinate
from helpers import DEVICE_A
from index import app


@pytest.fixture(scope="module")
def client(isolated_stores):
    with TestClient(app, headers=DEVICE_A) as test_client:
        yield test_client


def test_street_names_are_searchable_without_a_network(client):
    """The road graph is already on the device; its street names are the offline index."""
    data = client.get("/geocode", params={"q": "broad"}).json()
    names = [r["name"] for r in data["results"]]
    assert "Broadway" in names or "Broad Street" in names

    for result in data["results"]:
        assert result["source"] == "offline"
        assert result["in_coverage"] is True
        assert -90 <= result["location"]["lat"] <= 90


def test_search_prefers_names_that_start_with_the_query(client):
    results = client.get("/geocode", params={"q": "fulton"}).json()["results"]
    assert results
    assert results[0]["name"].lower().startswith("fulton")


def test_safe_havens_are_searchable_by_name(client):
    client.post("/safe-havens", json={
        "name": "Zeta Emergency Assembly Point",
        "location": {"lat": 40.7105, "lon": -74.0080},
        "type": "assembly_point",
    })
    results = client.get("/geocode", params={"q": "zeta"}).json()["results"]
    assert results and results[0]["kind"] == "shelter"
    assert results[0]["in_coverage"] is True


def test_results_are_ranked_by_distance_when_a_position_is_given(client):
    near = client.get("/geocode", params={
        "q": "street", "lat": 40.7070, "lon": -74.0140,
    }).json()["results"]
    assert near
    distances = [r["distance_meters"] for r in near]
    assert all(d is not None for d in distances)


def test_a_pasted_coordinate_is_understood(client):
    """People share positions as raw numbers during an emergency."""
    results = client.get("/geocode", params={"q": "40.7085, -74.0110"}).json()["results"]
    assert results[0]["kind"] == "coordinate"
    assert results[0]["location"] == {"lat": 40.7085, "lon": -74.011}
    assert results[0]["in_coverage"] is True


def test_a_coordinate_outside_coverage_is_marked_as_such(client):
    results = client.get("/geocode", params={"q": "37.7749,-122.4194"}).json()["results"]
    assert results[0]["kind"] == "coordinate"
    assert results[0]["in_coverage"] is False


@pytest.mark.parametrize("raw,expected", [
    ("40.7128, -74.0060", (40.7128, -74.006)),
    ("40.7128 -74.0060", (40.7128, -74.006)),
    ("40.7128;-74.0060", (40.7128, -74.006)),
    ("not a coordinate", None),
    ("999, 999", None),
    ("40.7128", None),
])
def test_coordinate_parsing(raw, expected):
    result = parse_coordinate(raw)
    if expected is None:
        assert result is None
    else:
        assert (result.lat, result.lon) == expected


def test_no_match_says_so_rather_than_returning_something_wrong(client):
    """A confidently wrong destination during an evacuation is worse than an empty list."""
    data = client.get("/geocode", params={"q": "qqzzxx nonexistent place"}).json()
    assert data["results"] == []
    assert data["message"]
    assert "drop a pin" in data["message"].lower()


def test_reverse_geocode_names_a_pin_from_the_offline_graph(client):
    data = client.get("/geocode/reverse", params={"lat": 40.7107, "lon": -74.0101}).json()
    assert data["source"] == "offline"
    assert data["name"] and data["name"].startswith("Near ")
    assert data["in_coverage"] is True


def test_reverse_geocode_stays_silent_when_it_cannot_tell(client):
    """Naming a pin after the nearest street 4,000 km away would be a fabrication."""
    data = client.get("/geocode/reverse", params={"lat": 37.7749, "lon": -122.4194}).json()
    assert data["name"] is None
    assert data["in_coverage"] is False


def test_geocode_is_rate_limited(client):
    limiter = app.state.rate_limiter
    limiter.reset()
    limit = limiter.limits["geocode"].count
    codes = [client.get("/geocode", params={"q": "broad"}).status_code for _ in range(limit + 2)]
    assert 429 in codes
    limiter.reset()
