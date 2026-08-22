"""
Web Push subscriptions and the nearby-hazard fan-out.

Push is the only feature that reaches a user who is *not* looking at the app, so
its failure modes matter more than most: alerting someone about a hazard they
never asked to watch erodes trust exactly once, and silently never alerting them
defeats the feature entirely. These tests pin both directions.
"""

import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import pytest
from fastapi.testclient import TestClient

import push_relay
from helpers import ADMIN, DEVICE_A, DEVICE_B
from index import app

WATCH_AREA = {"min_lat": 40.700, "max_lat": 40.720, "min_lon": -74.020, "max_lon": -73.995}
SUB_A = {
    "endpoint": "https://push.example/sub-a",
    "keys": {"p256dh": "key-a", "auth": "auth-a"},
    "watch_area": WATCH_AREA,
}
SHARED_HAZARD = {
    "center": {"lat": 40.7085, "lon": -74.0110},
    "radius_meters": 60.0,
    "name": "Water across West Street",
    "hazard_type": "flood",
    "share": True,
}


@pytest.fixture(scope="module")
def client(isolated_stores):
    with TestClient(app, headers=DEVICE_A) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def client_b(client):
    return TestClient(app, headers=DEVICE_B, client=("198.51.100.7", 40001))


@pytest.fixture(scope="module")
def anon_client(client):
    return TestClient(app)


def _unsubscribe(client, endpoint):
    return client.request("DELETE", "/push/subscriptions", json={"endpoint": endpoint})


@pytest.fixture(autouse=True)
def _clean_state(client):
    client.delete("/hazards", headers=ADMIN)
    for sub in client.get("/push/subscriptions").json()["subscriptions"]:
        _unsubscribe(client, sub["endpoint"])
    yield
    client.delete("/hazards", headers=ADMIN)
    for sub in client.get("/push/subscriptions").json()["subscriptions"]:
        _unsubscribe(client, sub["endpoint"])


@pytest.fixture
def vapid(monkeypatch):
    monkeypatch.setenv("ONEBAR_VAPID_PRIVATE_KEY", "test-private-key-not-a-secret")
    monkeypatch.setenv("ONEBAR_VAPID_PUBLIC_KEY", "test-public-key-not-a-secret")


@pytest.fixture
def sent(monkeypatch):
    """Capture what the relay would encrypt and send; nothing leaves the process."""
    calls = []

    def fake_send(record, payload):
        calls.append((record["endpoint"], payload))
        return "ok"

    monkeypatch.setattr(push_relay, "send_to_subscription", fake_send)
    return calls


# --- Configuration endpoint ---------------------------------------------------

def test_push_is_reported_disabled_without_vapid_keys(client, monkeypatch):
    monkeypatch.delenv("ONEBAR_VAPID_PRIVATE_KEY", raising=False)
    monkeypatch.delenv("ONEBAR_VAPID_PUBLIC_KEY", raising=False)
    body = client.get("/push/vapid-public-key").json()
    assert body["enabled"] is False
    assert body["public_key"] is None


def test_the_public_key_is_served_when_configured(client, vapid):
    body = client.get("/push/vapid-public-key").json()
    assert body["enabled"] is True
    assert body["public_key"] == "test-public-key-not-a-secret"


# --- Subscription lifecycle ----------------------------------------------------

def test_subscribing_requires_a_device_header(anon_client):
    assert anon_client.post("/push/subscriptions", json=SUB_A).status_code == 400


def test_plain_http_endpoints_are_refused(client):
    hostile = dict(SUB_A, endpoint="http://push.example/sub-a")
    assert client.post("/push/subscriptions", json=hostile).status_code == 400


def test_resubscribing_refreshes_instead_of_duplicating(client):
    assert client.post("/push/subscriptions", json=SUB_A).status_code == 201
    smaller = dict(SUB_A, watch_area={
        "min_lat": 40.705, "max_lat": 40.710, "min_lon": -74.015, "max_lon": -74.008,
    })
    assert client.post("/push/subscriptions", json=smaller).status_code == 201

    listed = client.get("/push/subscriptions").json()
    assert listed["total"] == 1
    assert listed["subscriptions"][0]["watch_area"]["max_lat"] == 40.710


def test_subscription_endpoints_are_private_to_their_device(client, client_b):
    client.post("/push/subscriptions", json=SUB_A)
    assert client_b.get("/push/subscriptions").json()["total"] == 0


def test_only_the_owning_device_can_unsubscribe(client, client_b):
    client.post("/push/subscriptions", json=SUB_A)

    other = dict(SUB_A, endpoint="https://push.example/unknown")
    assert _unsubscribe(client_b, other["endpoint"]).status_code == 404
    assert _unsubscribe(client_b, SUB_A["endpoint"]).status_code == 403

    assert _unsubscribe(client, SUB_A["endpoint"]).json() == {"removed": True}
    assert client.get("/push/subscriptions").json()["total"] == 0


# --- The fan-out ----------------------------------------------------------------

def test_a_shared_hazard_alerts_nearby_watchers_but_not_its_reporter(client, client_b, vapid, sent):
    client.post("/push/subscriptions", json=SUB_A)
    created = client_b.post("/hazards", json=SHARED_HAZARD)
    assert created.status_code == 201

    assert [endpoint for endpoint, _ in sent] == [SUB_A["endpoint"]]
    payload = sent[0][1]
    assert payload["body"].endswith("Water across West Street")
    assert payload["tag"] == f"hazard-{created.json()['hazard_id']}"


def test_a_private_report_never_alerts_anyone(client, vapid, sent):
    client.post("/push/subscriptions", json=SUB_A)
    client.post("/hazards", json=dict(SHARED_HAZARD, share=False))
    assert sent == []


def test_the_reporter_is_not_woken_by_their_own_report(client, vapid, sent):
    client.post("/push/subscriptions", json=SUB_A)
    client.post("/hazards", json=SHARED_HAZARD)
    assert sent == []


def test_watchers_far_from_the_hazard_stay_silent(client, vapid, sent):
    far = dict(SUB_A, watch_area={
        "min_lat": 51.0, "max_lat": 51.1, "min_lon": -0.2, "max_lon": 0.0,
    })
    client.post("/push/subscriptions", json=far)
    client.post("/hazards", json=SHARED_HAZARD)
    assert sent == []


def test_drill_syncs_never_alert_anyone(client, vapid, sent):
    client.post("/push/subscriptions", json=SUB_A)
    response = client.post("/hazards/sync-api", json={"drill_mode": True})
    assert response.status_code == 200
    assert sent == []


def test_revoked_subscriptions_are_pruned_after_a_failed_send(client, client_b, vapid, monkeypatch):
    client.post("/push/subscriptions", json=SUB_A)
    monkeypatch.setattr(push_relay, "send_to_subscription", lambda record, payload: "gone")

    client_b.post("/hazards", json=SHARED_HAZARD)
    assert client.get("/push/subscriptions").json()["total"] == 0


# --- Geometry ---------------------------------------------------------------------

def test_bbox_covers_polygon_vertices_and_circle_radius():
    polygon_zone = SimpleNamespace(
        coordinates=[
            SimpleNamespace(lat=40.70, lon=-74.02),
            SimpleNamespace(lat=40.72, lon=-74.00),
            SimpleNamespace(lat=40.71, lon=-74.03),
        ],
        center=None, radius_meters=None,
    )
    bbox = push_relay.hazard_bbox(polygon_zone)
    assert bbox["min_lat"] == 40.70 and bbox["max_lat"] == 40.72
    assert bbox["min_lon"] == -74.03 and bbox["max_lon"] == -74.00

    circle_zone = SimpleNamespace(
        coordinates=[], center=SimpleNamespace(lat=40.71, lon=-74.01), radius_meters=1113.2,
    )
    circle = push_relay.hazard_bbox(circle_zone)
    # ~0.01 degrees of latitude per 1113 m, plus a little for the cosine correction.
    assert abs((circle["max_lat"] - circle["min_lat"]) - 0.02) < 1e-6
    assert circle["max_lon"] - circle["min_lon"] > 0.02
