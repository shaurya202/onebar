"""
What the app does when it does not have what it needs.

OneBar's stated convention is to prefer graceful degradation over hard failure — with
one exception: "degrading into invented hazards or shelters is never acceptable. Where
the honest answer is 'no data', say so and refuse."

An invented *road network* is the same class of thing. These tests pin the boundary
between the two, and the migration behaviour for records written before the fields that
now bound them existed.
"""

import json
import os
import sys
from datetime import UTC, datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import pytest
from fastapi.testclient import TestClient

from hazard_store import HazardStore
from helpers import DEVICE_A
from safe_havens import SafeHavenStore
from schemas import LatLon

# --- the synthetic road network ----------------------------------------------

@pytest.fixture(scope="module")
def synthetic_client(tmp_path_factory):
    """A deployment that could not load any road network at all."""
    tmp = tmp_path_factory.mktemp("onebar_synthetic")
    keys = ("ONEBAR_HAZARDS_FILE", "ONEBAR_HAVENS_FILE", "ONEBAR_CACHE",
            "ONEBAR_HAVEN_DISCOVERY", "ONEBAR_PLACE", "ONEBAR_BBOX", "ONEBAR_POINT")
    previous = {k: os.environ.get(k) for k in keys}

    os.environ["ONEBAR_HAZARDS_FILE"] = str(tmp / "hazards.json")
    os.environ["ONEBAR_HAVENS_FILE"] = str(tmp / "havens.json")
    # A cache path that does not exist, and a place that cannot be geocoded offline,
    # so the loader exhausts both real options and falls through to the grid.
    os.environ["ONEBAR_CACHE"] = str(tmp / "missing.graphml")
    os.environ["ONEBAR_PLACE"] = "Nowhere At All, Nonexistent Country ZZ"
    os.environ["ONEBAR_HAVEN_DISCOVERY"] = "0"
    for key in ("ONEBAR_BBOX", "ONEBAR_POINT"):
        os.environ.pop(key, None)

    from index import app
    with TestClient(app, headers=DEVICE_A) as client:
        yield client

    for key, value in previous.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def test_a_synthetic_graph_says_it_is_not_a_map(synthetic_client):
    region = synthetic_client.get("/region").json()
    if not region.get("synthetic"):
        pytest.skip("this environment reached OSM, so no fallback graph was built")

    assert region["status"] == "no_map"
    # It must not go on claiming to be the place that was asked for.
    assert region["place_name"] is None


def test_a_synthetic_graph_refuses_to_route(synthetic_client):
    """
    Its edges are invented streets at real Lower Manhattan coordinates.

    A user genuinely standing there passes the coverage check, so without this the app
    hands them turn-by-turn directions down roads that do not exist — the same
    fabrication the hazard and shelter paths are built to prevent.
    """
    if not synthetic_client.get("/region").json().get("synthetic"):
        pytest.skip("this environment reached OSM, so no fallback graph was built")

    route = synthetic_client.post("/route", json={
        "origin": {"lat": 40.7128, "lon": -74.0060},
        "destination": {"lat": 40.7148, "lon": -74.0020},
        "mode": "drive",
    })
    assert route.status_code == 503
    assert route.json()["detail"]["no_map"] is True

    safety = synthetic_client.post("/route/safety", json={
        "origin": {"lat": 40.7128, "lon": -74.0060}, "mode": "walk",
    })
    assert safety.status_code == 503


def test_a_real_graph_is_not_flagged_synthetic(client):
    assert client.get("/region").json()["synthetic"] is False


@pytest.fixture(scope="module")
def client(isolated_stores):
    from index import app
    with TestClient(app, headers=DEVICE_A) as test_client:
        yield test_client


# --- records written before the fields that now bound them --------------------

def test_a_hazard_from_before_expiry_existed_does_not_live_for_ever(tmp_path):
    """
    Otherwise it belongs to nobody, is visible to everybody, blocks every route, and
    no endpoint an ordinary user can reach will delete it.
    """
    path = tmp_path / "hazards.json"
    long_ago = (datetime.now(UTC) - timedelta(days=400)).isoformat()
    path.write_text(json.dumps([{
        "hazard_id": "legacy-1",
        "name": "Road closure from last year",
        "hazard_type": "closure",
        "coordinates": [
            {"lat": 40.7080, "lon": -74.0130},
            {"lat": 40.7095, "lon": -74.0100},
            {"lat": 40.7065, "lon": -74.0095},
        ],
        "created_at": long_ago,
    }]), encoding="utf-8")

    store = HazardStore(persistence_file=str(path))
    # Backfilled from when it was created, not from now — otherwise a restart grants a
    # year-old record a fresh 24 hours, for ever.
    assert store.purge_expired() == 1
    assert store.list() == []


def test_a_recent_legacy_hazard_is_kept_but_bounded(tmp_path):
    path = tmp_path / "hazards.json"
    path.write_text(json.dumps([{
        "hazard_id": "legacy-2",
        "name": "Reported an hour ago",
        "hazard_type": "flood",
        "coordinates": [
            {"lat": 40.7080, "lon": -74.0130},
            {"lat": 40.7095, "lon": -74.0100},
            {"lat": 40.7065, "lon": -74.0095},
        ],
        "created_at": (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
    }]), encoding="utf-8")

    store = HazardStore(persistence_file=str(path))
    zones = store.list()
    assert len(zones) == 1
    assert zones[0].expires_at is not None
    assert zones[0].provenance == "user"


def test_a_shelter_from_before_provenance_existed_is_not_called_official(tmp_path):
    """The schema default is "official"; a record that predates the field must not inherit it."""
    path = tmp_path / "havens.json"
    path.write_text(json.dumps([
        {
            "id": "legacy-typed",
            "name": "Someone's Typed Shelter",
            "type": "shelter",
            "location": {"lat": 40.7100, "lon": -74.0050},
        },
        {
            "id": "legacy-osm",
            "name": "NewYork-Presbyterian",
            "type": "hospital",
            "location": {"lat": 40.7105, "lon": -74.0080},
            "osm_id": "node/12345",
        },
    ]), encoding="utf-8")

    store = SafeHavenStore(persistence_file=str(path))
    by_id = {h.id: h for h in store.list()}

    assert by_id["legacy-typed"].provenance == "user"
    assert by_id["legacy-typed"].verified is False
    # One that carries an OSM id really did come from the map.
    assert by_id["legacy-osm"].provenance == "official"


def test_reseeding_a_region_keeps_shelters_the_user_added(tmp_path, monkeypatch):
    """
    Assigning the discovered set over the whole dict deleted them.

    Silently, on the next restart, with no way to get them back — and it retriggers on
    any change to the configured region.
    """
    import safe_havens

    store = SafeHavenStore(persistence_file=str(tmp_path / "havens.json"))
    mine = store.add(
        name="My Garage", location=LatLon(lat=40.7090, lon=-74.0100), reporter="device-a",
    )

    discovered = safe_havens.SafeHaven(
        id="haven-osm-node-9", name="Discovered Hospital", type="hospital",
        location=LatLon(lat=40.7105, lon=-74.0080), provenance="official",
        osm_id="node/9", verified=False,
    )
    monkeypatch.setattr(safe_havens, "fetch_osm_safe_havens", lambda bounds, tags=None: [discovered])
    monkeypatch.delenv("ONEBAR_HAVEN_DISCOVERY", raising=False)

    store.seed_for_region(40.708, -74.010, {
        "min_lat": 40.705, "max_lat": 40.712, "min_lon": -74.016, "max_lon": -74.006,
    })

    ids = {h.id for h in store.list(viewer="device-a")}
    assert discovered.id in ids, "discovery should have run"
    assert mine.id in ids, "the user's own shelter was deleted by re-seeding"


# --- the shipped image --------------------------------------------------------

def _dockerfile():
    with open(os.path.join(os.path.dirname(__file__), "..", "Dockerfile"), encoding="utf-8") as f:
        return f.read()


def test_the_image_carries_every_file_served_from_the_project_root():
    """
    `/privacy` reads PRIVACY.md from the project root, not from app/ or static/.

    Both app stores require the policy URL to resolve and the first-run screen links to
    it, so a missing COPY is a 500 on a page the app is obliged to show.
    """
    dockerfile = _dockerfile()
    assert "COPY PRIVACY.md" in dockerfile


def test_the_image_runs_a_single_worker():
    """
    The stores are per-process singletons that persist by rewriting one JSON file.

    With two workers a report filed against one is invisible to the other, and the next
    save from either erases it from disk — reports vanish at random.
    """
    dockerfile = _dockerfile()
    assert '"--workers", "1"' in dockerfile
    assert '"--workers", "2"' not in dockerfile
