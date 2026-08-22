"""
On-demand region packs.

Building a pack means minutes of upstream API usage and megabytes of disk, so the
endpoint ships switched off and is rate limited when on. The build itself runs as a
background task; these tests swap the network half for a stub and pin the job
lifecycle: request -> building -> ready -> downloadable -> catalogued.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

import pytest
from fastapi.testclient import TestClient

import pack_builder
from helpers import DEVICE_A
from index import app


@pytest.fixture(scope="module")
def client(isolated_stores):
    with TestClient(app, headers=DEVICE_A) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def _clean_pack_dir(isolated_stores):
    pack_dir = isolated_stores / "packs"
    pack_dir.mkdir(exist_ok=True)
    yield
    for f in pack_dir.iterdir():
        f.unlink()


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv("ONEBAR_ON_DEMAND_PACKS", "1")


@pytest.fixture
def instant_build(monkeypatch):
    """Replace the network half of a build with a tiny valid-looking blob."""
    calls = []

    def fake_build(region_id, name, place=None, point=None, radius_m=None, include_havens=True):
        calls.append({"region_id": region_id, "point": point, "radius_m": radius_m})
        entry = {
            "id": region_id, "name": name,
            "bounds": {"min_lat": 40.7, "max_lat": 40.71, "min_lon": -74.02, "max_lon": -74.01},
            "bytes": 4 + 5, "node_count": 42, "edge_count": 84, "haven_count": 0,
            "sha256": "0" * 64, "format_version": 1,
        }
        # catalogue_entry recomputes from the graph; emulate it cheaply instead.
        return b"OBP1xxxxx", dict(entry)

    monkeypatch.setattr(pack_builder, "build_region_pack", fake_build)
    return calls


REQUEST_BODY = {"point": {"lat": 40.7085, "lon": -74.0110}, "radius_km": 3}


def _await_job(client, job_id: str, timeout_s: float = 10.0) -> dict:
    """Poll like a real client would: the build runs after the response returns."""
    import time
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        status = client.get(f"/packs/jobs/{job_id}").json()
        if status["status"] in ("ready", "error"):
            return status
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not settle within {timeout_s}s")


def test_on_demand_builds_are_disabled_by_default(client):
    response = client.post("/packs/request", json=REQUEST_BODY)
    assert response.status_code == 403
    assert response.json()["detail"]["on_demand_disabled"] is True


def test_a_request_without_a_device_header_is_refused(client, enabled):
    bare = TestClient(app)
    assert bare.post("/packs/request", json=REQUEST_BODY).status_code == 400


def test_an_unrealistic_radius_is_refused(client, enabled):
    big = client.post("/packs/request", json=dict(REQUEST_BODY, radius_km=50)).status_code
    small = client.post("/packs/request", json=dict(REQUEST_BODY, radius_km=0.1)).status_code
    assert (big, small) == (422, 422)


def test_the_full_job_lifecycle_from_request_to_download(client, enabled, instant_build):
    created = client.post("/packs/request", json=REQUEST_BODY)
    assert created.status_code == 202
    job = _await_job(client, created.json()["job_id"])
    assert job["status"] == "ready"

    pack = client.get(job["download_url"])
    assert pack.status_code == 200
    assert pack.content.startswith(b"OBP1")

    catalogue = client.get("/packs/index.json").json()
    assert any(r["id"] == job["region_id"] for r in catalogue["regions"])


def test_rebuilding_an_existing_area_is_immediate_and_does_not_refetch(
    client, enabled, instant_build,
):
    first_job = client.post("/packs/request", json=REQUEST_BODY).json()
    _await_job(client, first_job["job_id"])
    builds_after_first = len(instant_build)

    region_id = first_job["region_id"]
    second = client.post("/packs/request", json=REQUEST_BODY).json()
    assert second["status"] == "ready"
    assert second["region_id"] == region_id
    assert len(instant_build) == builds_after_first


def test_a_failed_build_reports_its_reason_instead_of_hanging(
    client, enabled, monkeypatch,
):
    def failing_build(**kwargs):
        raise RuntimeError("Overpass timed out")

    monkeypatch.setattr(pack_builder, "build_region_pack", failing_build)
    job = client.post("/packs/request", json=REQUEST_BODY).json()

    status = _await_job(client, job["job_id"])
    assert status["status"] == "error"
    assert "timed out" in status["error"]


def test_unknown_jobs_are_not_found(client, enabled):
    assert client.get("/packs/jobs/deadbeef").status_code == 404
