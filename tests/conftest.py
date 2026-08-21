"""
Shared pytest fixtures.

The suite previously drove the real FastAPI lifespan with no isolation, so every run
rewrote the repo-root hazards_store.json and safe_havens_store.json. Those files were
tracked in git, and test residue — nine duplicate "Custom Pier Evacuation Point"
entries — ended up committed and shipped as production shelter data. Every store path
is now redirected into a tmp directory.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest

from helpers import ADMIN_TOKEN

FIXTURE_GRAPH = os.path.join(os.path.dirname(__file__), "fixtures", "test_region.graphml")

# Bounds of FIXTURE_GRAPH — a real 380 m slice of Lower Manhattan with genuine
# drivable streets, so drive-mode tests exercise roads rather than footpaths.
FIXTURE_BOUNDS = {
    "min_lat": 40.70509, "max_lat": 40.71190,
    "min_lon": -74.01550, "max_lon": -74.00649,
}


@pytest.fixture(scope="session")
def region_bounds():
    """Bounds of the checked-in test graph, so tests can pick in-coverage points."""
    return dict(FIXTURE_BOUNDS)


@pytest.fixture(scope="module")
def isolated_stores(tmp_path_factory):
    """Redirect all persistence and pin the graph to the committed test fixture."""
    tmp = tmp_path_factory.mktemp("onebar_state")
    keys = (
        "ONEBAR_HAZARDS_FILE", "ONEBAR_HAVENS_FILE", "ONEBAR_CACHE",
        "ONEBAR_HAVEN_DISCOVERY", "ONEBAR_DEVICE_SALT", "ONEBAR_GEOCODING",
        "ONEBAR_ADMIN_TOKEN",
    )
    previous = {k: os.environ.get(k) for k in keys}

    os.environ["ONEBAR_HAZARDS_FILE"] = str(tmp / "hazards_store.json")
    os.environ["ONEBAR_HAVENS_FILE"] = str(tmp / "safe_havens_store.json")
    # Pin the graph so results don't depend on whatever cache a developer has locally.
    os.environ["ONEBAR_CACHE"] = FIXTURE_GRAPH
    # Keep startup off the network so the suite is hermetic.
    os.environ["ONEBAR_HAVEN_DISCOVERY"] = "0"
    os.environ["ONEBAR_GEOCODING"] = "0"
    # Fix the salt so owner keys are stable and no salt file is written next to the
    # store — one more thing a test run must not leave behind.
    os.environ["ONEBAR_DEVICE_SALT"] = "test-salt-not-a-secret"
    os.environ["ONEBAR_ADMIN_TOKEN"] = ADMIN_TOKEN

    yield tmp

    for key, value in previous.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


@pytest.fixture(autouse=True)
def _reset_shared_limits():
    """Keep per-device counters and the feed cache from leaking between tests.

    Both are process-global by design, so without this a test that exhausts a bucket
    would fail an unrelated test that runs after it — and a cached feed response
    would be served to a test expecting a fresh fetch.
    """
    import api

    with api._feed_cache_lock:
        api._feed_cache.clear()
    from index import app as _app

    limiter = getattr(_app.state, "rate_limiter", None)
    if limiter is not None:
        limiter.reset()
    yield
    if limiter is not None:
        limiter.reset()
