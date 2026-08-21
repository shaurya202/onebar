import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import pytest
from fastapi.testclient import TestClient

from helpers import ADMIN, DEVICE_A, DEVICE_B
from index import app


@pytest.fixture(scope="module")
def client(isolated_stores):
    # Context manager triggers the FastAPI lifespan (loads GraphManager, HazardStore, SafeHavenStore).
    # `isolated_stores` redirects persistence into tmp so the run never touches the repo.
    # Every write is attributed to a device, so the default client carries one.
    with TestClient(app, headers=DEVICE_A) as test_client:
        yield test_client


# The secondary clients deliberately skip the lifespan context manager: re-running it
# would rebuild app.state and hand each client its own stores, which is the opposite of
# what these fixtures exist to test. They share the state the primary client set up.
@pytest.fixture(scope="module")
def client_b(client):
    """A second device sharing the same server, for testing report scoping."""
    return TestClient(app, headers=DEVICE_B)


@pytest.fixture(scope="module")
def anon_client(client):
    """A client that sends no device header at all."""
    return TestClient(app)


# Coordinates inside the checked-in test graph. The previous values (40.7128, -74.0060)
# were ~1.3 km outside it, so `nearest_node` snapped them to a boundary node and the
# suite asserted against routes that had nothing to do with the requested points.
IN_COVERAGE_ORIGIN = {"lat": 40.7070, "lon": -74.0140}
IN_COVERAGE_DEST = {"lat": 40.7100, "lon": -74.0090}


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
            {"lat": 40.7080, "lon": -74.0130},
            {"lat": 40.7095, "lon": -74.0100},
            {"lat": 40.7065, "lon": -74.0095},
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
        "center": {"lat": 40.7085, "lon": -74.0110},
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


def test_sync_drill_mode_is_explicit_and_labelled(client):
    """Drill hazards appear only on request, and are unmistakably simulated."""
    sync_payload = {
        "center": {"lat": 40.7085, "lon": -74.0110},
        "radius_km": 10.0,
        "sources": [],
        "clear_existing": True,
        "drill_mode": True,
    }
    response = client.post("/hazards/sync-api", json=sync_payload, headers=ADMIN)
    assert response.status_code == 200
    data = response.json()
    assert data["fetched_count"] > 0
    assert data["drill_mode"] is True
    assert "DRILL" in data["message"].upper()
    for zone in data["hazards"]:
        assert zone["provenance"] == "drill"
        assert "NOT REAL" in zone["name"].upper()

    list_res = client.get("/hazards")
    assert list_res.status_code == 200
    assert list_res.json()["total"] >= data["fetched_count"]


def test_sync_never_fabricates_hazards_without_drill_mode(client):
    """
    An empty feed must report zero hazards.

    This is the regression guard for the behaviour that made the app unshippable:
    `include_simulation_if_empty=True` was hardcoded, so whenever the real feeds
    returned nothing the server invented four 'extreme' hazards near the user's GPS
    and the UI rendered them exactly like genuine NWS alerts.
    """
    response = client.post("/hazards/sync-api", json={
        "center": {"lat": 40.7085, "lon": -74.0110},
        "sources": [],            # query nothing at all
        "clear_existing": True,
    }, headers=ADMIN)
    assert response.status_code == 200
    data = response.json()
    assert data["fetched_count"] == 0
    assert data["hazards"] == []
    assert data["drill_mode"] is False
    assert "no active alerts" in data["message"].lower()
    assert client.get("/hazards").json()["total"] == 0


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
        "location": {"lat": 40.7075, "lon": -74.0120},
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
        "origin": IN_COVERAGE_ORIGIN,
        "destination": IN_COVERAGE_DEST,
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
    # A haven inside the mapped area. The bundled NYC defaults all sit outside the
    # test graph and are now correctly refused as unreachable, so the test provides
    # its own reachable destination rather than depending on test ordering.
    client.post("/safe-havens", json={
        "name": "Test Assembly Point",
        "location": {"lat": 40.7105, "lon": -74.0080},
        "type": "assembly_point",
    })

    # Ensure some hazard is present to test avoidance
    client.post("/hazards", json={
        "center": {"lat": 40.7085, "lon": -74.0110},
        "radius_meters": 75.0,
        "name": "Debris Blockade",
        "hazard_type": "debris",
    })

    safety_payload = {
        "origin": IN_COVERAGE_ORIGIN,
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


def test_route_outside_coverage_is_refused(client):
    """
    A point outside the mapped area must be refused, not silently snapped.

    `nearest_node` will map any coordinate on Earth onto the loaded graph, so before
    this check a user in California asking for a route got a fully-formed path through
    Lower Manhattan, complete with plausible travel times and turn instructions.
    """
    response = client.post("/route", json={
        "origin": {"lat": 37.7749, "lon": -122.4194},   # San Francisco
        "destination": IN_COVERAGE_DEST,
        "mode": "drive",
    })
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["outside_coverage"] is True
    assert detail["distance_km"] > 1000


def test_safety_route_outside_coverage_is_refused(client):
    response = client.post("/route/safety", json={
        "origin": {"lat": -33.8688, "lon": 151.2093},   # Sydney
        "mode": "walk",
    })
    assert response.status_code == 422
    assert response.json()["detail"]["outside_coverage"] is True


def test_region_reports_per_mode_routability(client):
    data = client.get("/region").json()
    assert data["drivable_edge_count"] > 0
    assert data["walkable_edge_count"] > 0
    assert set(data["supported_modes"]) == {"drive", "walk"}


def test_unreachable_havens_are_flagged(client):
    """The bundled NYC havens lie outside the test graph and must be marked unreachable."""
    havens = client.get("/safe-havens").json()["safe_havens"]
    assert havens, "expected seeded havens"
    outside = [h for h in havens if h["id"].startswith("haven-shelter-stuyvesant")]
    assert outside and outside[0]["reachable"] is False


def test_user_reported_hazards_are_not_marked_official(client):
    zone = client.post("/hazards", json={
        "center": {"lat": 40.7085, "lon": -74.0110},
        "radius_meters": 50.0,
        "name": "Reported by a user",
        "source": "nws",          # a client must not be able to claim authority
    }).json()
    assert zone["provenance"] == "user"
    assert zone["visibility"] == "private"
    assert zone["effective_coordinates"]


def test_bulk_hazard_delete_requires_operator_token(client):
    """
    Any anonymous client could previously wipe the hazard map for everyone.

    The stores are process-global, so this endpoint is destructive to every other
    user of the deployment, not just the caller.
    """
    response = client.delete("/hazards")
    assert response.status_code == 403
    assert "token" in response.json()["detail"].lower()


def test_pack_catalogue_is_served(client):
    response = client.get("/packs/index.json")
    assert response.status_code == 200
    assert "regions" in response.json()


def test_pack_download_rejects_path_traversal(client):
    assert client.get("/packs/..%2f..%2fetc%2fpasswd.obp").status_code in (400, 404)
    assert client.get("/packs/NOT_A_REGION.obp").status_code == 400


def test_privacy_policy_is_served(client):
    """Both app stores require a reachable policy, and the first-run flow links to it."""
    response = client.get("/privacy")
    assert response.status_code == 200
    assert "text/plain" in response.headers.get("content-type", "")
    body = response.text
    assert "privacy" in body.lower()
    # The two claims the app makes to the user in its own first-run copy.
    assert "no accounts" in body.lower()
    assert "never uploaded" in body.lower() or "never leave" in body.lower()
