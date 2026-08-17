import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import pytest
from fastapi.testclient import TestClient
from index import app


@pytest.fixture(scope="module")
def client():
    # Context manager triggers the FastAPI lifespan (loads GraphManager, HazardStore, SafeHavenStore)
    with TestClient(app) as test_client:
        yield test_client


def test_health_endpoint(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["app"] == "OneBar"


def test_region_info_endpoint(client):
    response = client.get("/region")
    assert response.status_code == 200
    data = response.json()
    assert "bounds" in data
    assert "node_count" in data
    assert data["node_count"] > 0


def test_spa_root_and_pwa_endpoints(client):
    # 1. Root SPA
    res_root = client.get("/")
    assert res_root.status_code == 200
    assert "text/html" in res_root.headers.get("content-type", "")
    assert "OneBar" in res_root.text

    # 2. Service worker
    res_sw = client.get("/sw.js")
    assert res_sw.status_code == 200
    assert res_sw.headers.get("service-worker-allowed") == "/"

    # 3. Web manifest
    res_mf = client.get("/manifest.webmanifest")
    assert res_mf.status_code == 200
    assert "OneBar" in res_mf.text


def test_hazards_api_lifecycle(client):
    # 1. Clear any existing
    client.delete("/hazards")

    # 2. Add polygon hazard
    hazard_payload = {
        "coordinates": [
            {"lat": 40.7128, "lon": -74.0060},
            {"lat": 40.7150, "lon": -74.0020},
            {"lat": 40.7100, "lon": -74.0010},
        ],
        "name": "Midtown Flood Zone",
        "hazard_type": "flood",
        "buffer_meters": 20.0,
    }
    create_res = client.post("/hazards", json=hazard_payload)
    assert create_res.status_code == 201
    zone = create_res.json()
    assert "hazard_id" in zone
    hazard_id = zone["hazard_id"]
    assert zone["name"] == "Midtown Flood Zone"

    # 3. Add radial hazard
    radial_payload = {
        "center": {"lat": 40.7130, "lon": -74.0050},
        "radius_meters": 80.0,
        "name": "Collapsed Tree",
        "hazard_type": "debris",
    }
    create_radial_res = client.post("/hazards", json=radial_payload)
    assert create_radial_res.status_code == 201
    r_zone = create_radial_res.json()
    assert r_zone["radius_meters"] == 80.0
    assert len(r_zone["coordinates"]) >= 3

    # 4. List hazards
    list_res = client.get("/hazards")
    assert list_res.status_code == 200
    list_data = list_res.json()
    assert list_data["total"] >= 2
    assert any(h["hazard_id"] == hazard_id for h in list_data["hazards"])

    # 5. Get specific hazard
    get_res = client.get(f"/hazards/{hazard_id}")
    assert get_res.status_code == 200
    assert get_res.json()["hazard_id"] == hazard_id

    # 6. Delete specific hazard
    del_res = client.delete(f"/hazards/{hazard_id}")
    assert del_res.status_code == 200
    assert del_res.json()["removed"] is True

    # 7. Verify 404 after deletion
    get_404 = client.get(f"/hazards/{hazard_id}")
    assert get_404.status_code == 404


def test_sync_external_hazards_api(client):
    sync_payload = {
        "center": {"lat": 40.7128, "lon": -74.0060},
        "radius_km": 10.0,
        "sources": ["simulation"],
        "clear_existing": True,
    }
    response = client.post("/hazards/sync-api", json=sync_payload)
    assert response.status_code == 200
    data = response.json()
    assert data["fetched_count"] > 0
    assert len(data["hazards"]) == data["fetched_count"]
    assert len(data["sources"]) >= 1

    # Verify hazards are in store
    list_res = client.get("/hazards")
    assert list_res.status_code == 200
    assert list_res.json()["total"] >= data["fetched_count"]


def test_safe_havens_lifecycle(client):
    # List safe havens
    list_res = client.get("/safe-havens")
    assert list_res.status_code == 200
    data = list_res.json()
    assert "safe_havens" in data
    assert data["total"] >= 1

    # Add custom safe haven
    haven_payload = {
        "name": "Custom Pier Evacuation Point",
        "location": {"lat": 40.7050, "lon": -74.0150},
        "type": "shelter",
        "address": "Pier 17, New York, NY",
        "capacity": 500,
    }
    add_res = client.post("/safe-havens", json=haven_payload)
    assert add_res.status_code == 201
    haven = add_res.json()
    assert haven["name"] == "Custom Pier Evacuation Point"
    assert haven["type"] == "shelter"
    assert "id" in haven


def test_route_calculation_with_maneuvers(client):
    # Test drive route
    route_payload = {
        "origin": {"lat": 40.7128, "lon": -74.0060},
        "destination": {"lat": 40.7140, "lon": -74.0040},
        "mode": "drive",
        "encode_polyline": True,
        "allow_penalty_fallback": True,
    }
    response = client.post("/route", json=route_payload)
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert len(data["coordinates"]) >= 2
    assert data["polyline"] is not None
    assert data["total_travel_time_seconds"] > 0
    assert data["total_distance_meters"] > 0
    assert "maneuvers" in data
    assert len(data["maneuvers"]) >= 1

    # Test walk route
    route_payload["mode"] = "walk"
    response_walk = client.post("/route", json=route_payload)
    assert response_walk.status_code == 200
    assert response_walk.json()["success"] is True


def test_fastest_route_to_safety_endpoint(client):
    # Ensure some hazard is present to test avoidance
    client.post("/hazards", json={
        "center": {"lat": 40.7130, "lon": -74.0050},
        "radius_meters": 75.0,
        "name": "Debris Blockade",
        "hazard_type": "debris",
    })

    safety_payload = {
        "origin": {"lat": 40.7110, "lon": -74.0080},
        "mode": "drive",
        "target_type": "all",
        "encode_polyline": True,
        "allow_penalty_fallback": True,
    }
    response = client.post("/route/safety", json=safety_payload)
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert "destination_safe_haven" in data
    assert data["destination_safe_haven"]["name"] is not None
    assert len(data["coordinates"]) >= 2
    assert data["total_travel_time_seconds"] > 0
    assert "maneuvers" in data
    assert len(data["maneuvers"]) >= 1
