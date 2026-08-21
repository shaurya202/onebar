"""
Multi-user behaviour of the hazard map.

The stores are process-global. Before device scoping existed, every hazard one person
drew appeared on — and removed roads from — every other user's map, any anonymous
client could delete anyone's report, and nothing ever expired. These tests pin the
behaviour that replaced it.
"""

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import pytest
from fastapi.testclient import TestClient

from helpers import ADMIN, DEVICE_A, DEVICE_B
from index import app

PRIVATE_HAZARD = {
    "center": {"lat": 40.7085, "lon": -74.0110},
    "radius_meters": 60.0,
    "name": "Water across the road",
    "hazard_type": "flood",
}


@pytest.fixture(scope="module")
def client(isolated_stores):
    with TestClient(app, headers=DEVICE_A) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def client_b(client):
    return TestClient(app, headers=DEVICE_B, client=("198.51.100.7", 40001))


def device_on(address: str, device: str) -> TestClient:
    """A client with its own device id *and* its own network origin.

    Both matter: a device id is minted by the client, so anything that treats several
    of them as independent witnesses has to require something the client cannot mint.
    """
    return TestClient(app, headers={"X-OneBar-Device": device}, client=(address, 40000))


@pytest.fixture(scope="module")
def anon_client(client):
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean_map(client):
    client.delete("/hazards", headers=ADMIN)
    yield


def test_write_without_a_device_header_is_refused(anon_client):
    """An unattributable write to a shared emergency map is the abuse vector itself."""
    response = anon_client.post("/hazards", json=PRIVATE_HAZARD)
    assert response.status_code == 400
    assert response.json()["detail"]["missing_device_header"] is True


def test_a_malformed_device_header_is_treated_as_absent(client):
    bare = TestClient(app, headers={"X-OneBar-Device": "no"})
    assert bare.post("/hazards", json=PRIVATE_HAZARD).status_code == 400


def test_private_reports_are_invisible_to_other_devices(client, client_b):
    created = client.post("/hazards", json=PRIVATE_HAZARD).json()
    assert created["visibility"] == "private"
    assert created["provenance"] == "user"
    assert created["mine"] is True

    mine = client.get("/hazards").json()
    assert any(h["hazard_id"] == created["hazard_id"] for h in mine["hazards"])

    theirs = client_b.get("/hazards").json()
    assert not any(h["hazard_id"] == created["hazard_id"] for h in theirs["hazards"])
    assert client_b.get(f"/hazards/{created['hazard_id']}").status_code == 404


def test_private_reports_do_not_block_other_devices_routes(client, client_b):
    """The important half of scoping: one device's report must not reroute another's."""
    origin = {"lat": 40.7070, "lon": -74.0140}
    destination = {"lat": 40.7100, "lon": -74.0090}

    # A deliberately large private hazard straddling the area between the two points.
    client.post("/hazards", json={
        "center": {"lat": 40.7085, "lon": -74.0115},
        "radius_meters": 250.0,
        "name": "My own big blockage",
    })

    mine = client.post("/route", json={"origin": origin, "destination": destination, "mode": "walk"}).json()
    theirs = client_b.post("/route", json={"origin": origin, "destination": destination, "mode": "walk"}).json()

    assert mine["blocked_edges_avoided"] > 0
    assert theirs["blocked_edges_avoided"] == 0


def test_sharing_a_report_makes_it_visible_and_unauthoritative(client, client_b):
    created = client.post("/hazards", json={**PRIVATE_HAZARD, "share": True}).json()
    assert created["visibility"] == "shared"
    # Shared is not the same as official: a user report never gains authority.
    assert created["provenance"] == "community"

    seen = client_b.get("/hazards").json()["hazards"]
    match = [h for h in seen if h["hazard_id"] == created["hazard_id"]]
    assert match and match[0]["mine"] is False


def test_only_the_reporter_may_delete_a_report(client, client_b):
    created = client.post("/hazards", json={**PRIVATE_HAZARD, "share": True}).json()

    forbidden = client_b.delete(f"/hazards/{created['hazard_id']}")
    assert forbidden.status_code == 403

    assert client.delete(f"/hazards/{created['hazard_id']}").status_code == 200


def test_a_private_report_looks_absent_rather_than_forbidden_to_others(client, client_b):
    """Refusing with 403 would confirm the report exists; 404 leaks nothing."""
    created = client.post("/hazards", json=PRIVATE_HAZARD).json()
    assert client_b.delete(f"/hazards/{created['hazard_id']}").status_code == 404


def test_community_reports_can_be_confirmed_by_someone_else(client, client_b):
    created = client.post("/hazards", json={**PRIVATE_HAZARD, "share": True}).json()

    confirmed = client_b.post(f"/hazards/{created['hazard_id']}/confirm").json()
    assert confirmed["hazard"]["confirmations"] == 1
    assert confirmed["hazard"]["my_vote"] == "confirm"
    assert confirmed["retired"] is False

    # A second vote from the same device replaces the first rather than stacking.
    again = client_b.post(f"/hazards/{created['hazard_id']}/confirm").json()
    assert again["hazard"]["confirmations"] == 1


def test_a_reporter_cannot_confirm_their_own_report(client):
    created = client.post("/hazards", json={**PRIVATE_HAZARD, "share": True}).json()
    response = client.post(f"/hazards/{created['hazard_id']}/confirm").json()
    assert response["hazard"]["confirmations"] == 0
    assert "someone else" in response["message"].lower()


def test_official_alerts_are_not_put_to_a_vote(client):
    """An NWS warning does not stop being true because three people say otherwise."""
    drill = client.post("/hazards/sync-api", json={
        "center": {"lat": 40.7085, "lon": -74.0110},
        "sources": [], "drill_mode": True,
    }).json()
    assert drill["fetched_count"] > 0
    hazard_id = drill["hazards"][0]["hazard_id"]

    response = client.post(f"/hazards/{hazard_id}/deny").json()
    assert response["retired"] is False
    assert "community reports" in response["message"].lower()
    assert client.get(f"/hazards/{hazard_id}").status_code == 200


def test_denials_from_different_places_retire_a_community_report(client):
    created = client.post("/hazards", json={**PRIVATE_HAZARD, "share": True}).json()
    hazard_id = created["hazard_id"]

    first = device_on("203.0.113.9", "test-device-cccccccc")
    second = device_on("198.51.100.4", "test-device-dddddddd")
    third = device_on("192.0.2.55", "test-device-eeeeeeee")

    assert first.post(f"/hazards/{hazard_id}/deny").json()["retired"] is False
    assert second.post(f"/hazards/{hazard_id}/deny").json()["retired"] is False

    final = third.post(f"/hazards/{hazard_id}/deny").json()
    assert final["retired"] is True
    assert final["hazard"] is None
    assert client.get(f"/hazards/{hazard_id}").status_code == 404


def test_one_host_cannot_retire_a_report_by_minting_device_ids(client):
    """
    Three "independent" denials used to be three lines of a script.

    Device identifiers are chosen by the client, so a single actor could supply all
    three and hard-delete a real report of a real blockage. Retiring now needs agreement
    from more than one network origin — erring toward leaving a report standing, since
    it expires on its own within hours anyway and removing a true one is the dangerous
    direction.
    """
    created = client.post("/hazards", json={**PRIVATE_HAZARD, "share": True}).json()
    hazard_id = created["hazard_id"]

    for suffix in ("11111111", "22222222", "33333333", "44444444"):
        sybil = device_on("203.0.113.42", f"test-device-{suffix}")
        response = sybil.post(f"/hazards/{hazard_id}/deny").json()
        assert response["retired"] is False, "one host retired a report on its own"

    assert client.get(f"/hazards/{hazard_id}").status_code == 200

    # One genuinely separate voice is enough to tip it.
    elsewhere = device_on("198.51.100.77", "test-device-55555555")
    assert elsewhere.post(f"/hazards/{hazard_id}/deny").json()["retired"] is True


def test_reports_expire_and_stop_affecting_routing(client):
    """A report from yesterday is not evidence about today, and must stop blocking."""
    created = client.post("/hazards", json={
        **PRIVATE_HAZARD,
        "ttl_hours": 1.0 / 3600.0,     # one second
    }).json()
    assert created["expires_at"] is not None

    assert client.get(f"/hazards/{created['hazard_id']}").status_code == 200
    time.sleep(1.1)
    assert client.get(f"/hazards/{created['hazard_id']}").status_code == 404
    assert client.get("/hazards").json()["total"] == 0


def test_a_drill_stays_on_the_device_that_started_it(client, client_b):
    """
    Simulated hazards used to be written into shared state with no expiry.

    One client running a drill therefore put four fabricated hazards — at coordinates of
    its own choosing — onto every other device's map and routing graph, permanently,
    with no way for those users to tell why their shelters had turned red.
    """
    drill = client.post("/hazards/sync-api", json={
        "center": {"lat": 40.7085, "lon": -74.0110},
        "sources": [], "drill_mode": True,
    }).json()
    assert drill["fetched_count"] > 0

    for zone in drill["hazards"]:
        assert zone["provenance"] == "drill"
        assert zone["visibility"] == "private"
        # Short-lived as well as scoped: a drill nobody remembers to end must not
        # outlive the exercise.
        assert zone["expires_at"] is not None

    assert client.get("/hazards").json()["total"] >= drill["fetched_count"]
    assert client_b.get("/hazards").json()["total"] == 0


def test_leaving_a_drill_does_not_clear_someone_elses(client, client_b):
    payload = {"center": {"lat": 40.7085, "lon": -74.0110}, "sources": [], "drill_mode": True}
    client.post("/hazards/sync-api", json=payload)

    import api
    with api._feed_cache_lock:
        api._feed_cache.clear()
    client_b.post("/hazards/sync-api", json=payload)

    mine = client.get("/hazards").json()["total"]
    theirs = client_b.get("/hazards").json()["total"]
    assert mine > 0 and theirs > 0

    assert client.delete("/hazards/drill").json()["cleared"] == mine
    assert client.get("/hazards").json()["total"] == 0
    assert client_b.get("/hazards").json()["total"] == theirs


def test_official_alerts_use_the_issuers_expiry_and_otherwise_age_out(client):
    """
    Two things must both be true, and they pull in opposite directions.

    We must not invent an end time for somebody else's warning — but an alert whose
    issuer has stopped publishing it must not block roads for ever either. So the
    issuer's own expiry wins when it publishes one, and otherwise the record survives
    only as long as re-syncing keeps refreshing it.
    """
    from hazard_store import HazardStore
    from schemas import LatLon

    store = HazardStore(persistence_file=None)

    published = store.add(
        center=LatLon(lat=40.7085, lon=-74.0110), radius_meters=100.0,
        name="[NWS] Flood Watch", provenance="official",
        expires_at="2099-01-01T00:00:00+00:00",
    )
    assert published.expires_at == "2099-01-01T00:00:00+00:00"

    unpublished = store.add(
        center=LatLon(lat=40.7085, lon=-74.0110), radius_meters=100.0,
        name="[USGS] Earthquake", provenance="official",
    )
    assert unpublished.expires_at is not None, "an official alert must not block forever"

    # Re-syncing the same alert refreshes the window rather than stacking a second copy.
    refreshed = store.add(
        hazard_id=unpublished.hazard_id,
        center=LatLon(lat=40.7085, lon=-74.0110), radius_meters=100.0,
        name="[USGS] Earthquake", provenance="official",
    )
    assert refreshed.hazard_id == unpublished.hazard_id
    assert refreshed.expires_at >= unpublished.expires_at
    assert len(store.list()) == 2


def test_repeated_feed_syncs_do_not_duplicate_alerts(client):
    """
    The background poller runs every 90 seconds on every device.

    Each sync used to insert a fresh copy of every standing alert, so one flood watch
    became dozens of overlapping polygons within the hour.
    """
    payload = {"center": {"lat": 40.7085, "lon": -74.0110}, "sources": [], "drill_mode": True}
    first = client.post("/hazards/sync-api", json=payload).json()
    assert first["fetched_count"] > 0
    after_first = client.get("/hazards").json()["total"]

    # Bypass the response cache so the ingestion path really runs a second time.
    import api
    with api._feed_cache_lock:
        api._feed_cache.clear()

    client.post("/hazards/sync-api", json=payload)
    assert client.get("/hazards").json()["total"] == after_first


def test_drill_data_can_always_be_cleared(client):
    """Simulated hazards have no reporter, so ownership must not strand them."""
    client.post("/hazards/sync-api", json={
        "center": {"lat": 40.7085, "lon": -74.0110}, "sources": [], "drill_mode": True,
    })
    assert client.get("/hazards").json()["total"] > 0

    response = client.delete("/hazards/drill")
    assert response.status_code == 200
    assert response.json()["cleared"] > 0
    assert client.get("/hazards").json()["total"] == 0


def test_clearing_existing_hazards_during_sync_requires_an_operator(client):
    """`clear_existing` wipes other devices' reports, so it is not a user action."""
    response = client.post("/hazards/sync-api", json={
        "center": {"lat": 40.7085, "lon": -74.0110},
        "sources": [], "clear_existing": True,
    })
    assert response.status_code == 403
    assert "operator token" in response.json()["detail"].lower()


def test_write_rate_limit_refuses_a_flood(client):
    """Hazards remove edges from everyone's graph, so flooding the map denies routing."""
    limiter = app.state.rate_limiter
    limiter.reset()
    limit = limiter.limits["hazard_write"].count

    codes = [
        client.post("/hazards", json={**PRIVATE_HAZARD, "ttl_hours": 1.0}).status_code
        for _ in range(limit + 3)
    ]
    assert codes.count(201) == limit
    assert 429 in codes

    too_many = client.post("/hazards", json=PRIVATE_HAZARD)
    assert too_many.status_code == 429
    assert too_many.headers.get("retry-after")
    limiter.reset()


def test_the_rate_limit_is_per_device(client, client_b):
    limiter = app.state.rate_limiter
    limiter.reset()
    limit = limiter.limits["hazard_write"].count

    for _ in range(limit):
        client.post("/hazards", json={**PRIVATE_HAZARD, "ttl_hours": 1.0})
    assert client.post("/hazards", json=PRIVATE_HAZARD).status_code == 429
    # One device exhausting its allowance must not lock anybody else out.
    assert client_b.post("/hazards", json=PRIVATE_HAZARD).status_code == 201
    limiter.reset()


def test_a_client_supplied_lifetime_cannot_outlive_the_ceiling(client):
    """`ttl_hours` comes from the request body; the schema alone allowed a week."""
    shared = client.post("/hazards", json={
        **PRIVATE_HAZARD, "share": True, "ttl_hours": 168.0,
    }).json()

    from datetime import UTC, datetime
    expires = datetime.fromisoformat(shared["expires_at"])
    hours = (expires - datetime.now(UTC)).total_seconds() / 3600.0
    assert hours <= 24.5, f"a shared report was granted {hours:.1f} hours"


def test_an_oversized_report_is_refused(client):
    """One polygon over the whole region denies routing to everybody in it."""
    huge = client.post("/hazards", json={
        "name": "everything",
        "share": True,
        "coordinates": [
            {"lat": 40.60, "lon": -74.10}, {"lat": 40.80, "lon": -74.10},
            {"lat": 40.80, "lon": -73.90}, {"lat": 40.60, "lon": -73.90},
        ],
    })
    assert huge.status_code == 422

    too_many_points = client.post("/hazards", json={
        "name": "many points",
        "coordinates": [{"lat": 40.708 + i * 1e-6, "lon": -74.011} for i in range(600)],
    })
    assert too_many_points.status_code == 422


def test_a_rotating_device_id_still_hits_a_limit(client):
    """
    The per-device limiter alone stopped nothing.

    A device id is minted by the client, so rotating it per request minted a fresh
    allowance — 200 shared reports went in without a single 429, and every one of them
    removed edges from every other device's routing graph.
    """
    limiter = app.state.rate_limiter
    limiter.reset()
    peer_limit = limiter.limits["hazard_write.peer"].count

    codes = []
    for i in range(peer_limit + 5):
        rotating = TestClient(
            app,
            headers={"X-OneBar-Device": f"rotating-device-{i:08d}"},
            client=("203.0.113.200", 40000),
        )
        codes.append(rotating.post("/hazards", json={**PRIVATE_HAZARD, "ttl_hours": 1.0}).status_code)

    assert 429 in codes, "rotating the device header bypassed every limit"
    assert codes.count(201) <= peer_limit
    limiter.reset()


def test_free_text_fields_are_bounded(client):
    """Shared reports render on other people's devices; a label is not a payload."""
    response = client.post("/hazards", json={**PRIVATE_HAZARD, "name": "x" * 500})
    assert response.status_code == 422

    long_description = client.post("/hazards", json={**PRIVATE_HAZARD, "description": "y" * 5000})
    assert long_description.status_code == 422


def test_a_cached_feed_still_reconciles_the_store(client):
    """
    A cache hit must not report hazards that are not on the map.

    Upstream *results* are cached, not the response: ingestion runs on every sync, so
    clearing drill data and re-syncing inside the cache window puts it back rather than
    describing a map that no longer exists.
    """
    payload = {"center": {"lat": 40.7085, "lon": -74.0110}, "sources": [], "drill_mode": True}
    first = client.post("/hazards/sync-api", json=payload).json()
    assert first["fetched_count"] > 0

    assert client.delete("/hazards/drill").json()["cleared"] > 0
    assert client.get("/hazards").json()["total"] == 0

    # Same request, inside the cache window.
    second = client.post("/hazards/sync-api", json=payload).json()
    assert second["fetched_count"] == first["fetched_count"]
    assert client.get("/hazards").json()["total"] == second["fetched_count"]


def test_a_client_cannot_publish_a_shelter_through_the_api(client, client_b):
    """
    The API used to hand back `provenance: "official"` for anything posted to it.

    A fabricated hazard costs other people a detour; a fabricated shelter is somewhere
    they are sent to, and the UI labelled it "VERIFIED SAFE HAVEN".
    """
    created = client.post("/safe-havens", json={
        "name": "Riverside Emergency Shelter (not real)",
        "location": {"lat": 40.7062, "lon": -74.0142},
        "type": "shelter",
        "capacity": 5000,
    }).json()

    assert created["provenance"] == "user"
    assert created["verified"] is False
    assert created["visibility"] == "private"

    theirs = [h["id"] for h in client_b.get("/safe-havens").json()["safe_havens"]]
    assert created["id"] not in theirs

    mine = [h["id"] for h in client.get("/safe-havens").json()["safe_havens"]]
    assert created["id"] in mine


def test_an_injected_shelter_cannot_become_another_devices_destination(client, client_b):
    """The whole point of scoping shelters: it must not change where anyone else goes."""
    origin = {"lat": 40.7070, "lon": -74.0140}
    before = client_b.post("/route/safety", json={"origin": origin, "mode": "walk"})

    client.post("/safe-havens", json={
        "name": "Closest Fake Shelter",
        "location": {"lat": 40.7071, "lon": -74.0141},   # metres from the origin
        "type": "shelter",
    })

    after = client_b.post("/route/safety", json={"origin": origin, "mode": "walk"})
    if before.status_code == 200 and after.status_code == 200:
        assert after.json()["destination_safe_haven"]["name"] != "Closest Fake Shelter"


def test_only_the_adding_device_can_delete_a_shelter(client, client_b):
    created = client.post("/safe-havens", json={
        "name": "My Garage", "location": {"lat": 40.7090, "lon": -74.0100},
    }).json()

    # Private to its owner, so to anyone else it simply is not there.
    assert client_b.delete(f"/safe-havens/{created['id']}").status_code == 404
    assert client.delete(f"/safe-havens/{created['id']}").status_code == 200
    assert client.delete(f"/safe-havens/{created['id']}").status_code == 404
