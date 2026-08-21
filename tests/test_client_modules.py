"""
The browser modules that carry real logic, run under Node.

There is no bundler and no frontend test runner here — `static/` ships verbatim as the
Capacitor webDir — so rather than add one, this drives the real ES modules through
tools/client_tests.mjs, the same trick tests/test_route_parity.py uses for the routing
engine. The alternative is a second copy of the logic in the test, which is worse than
no test: it can agree with itself while disagreeing with what ships.
"""

import json
import os
import shutil
import subprocess

import pytest

REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
CLI = os.path.join(REPO_ROOT, "tools", "client_tests.mjs")
PACK = os.path.join(os.path.dirname(__file__), "fixtures", "packs", "test-region.obp")

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not os.path.exists(PACK),
    reason="Node or the test region pack is unavailable",
)


@pytest.fixture(scope="module")
def client_results():
    proc = subprocess.run(
        ["node", CLI, PACK],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    assert proc.stdout, f"client test host produced no output: {proc.stderr}"
    return json.loads(proc.stdout)["results"]


def test_every_client_module_check_passes(client_results):
    failures = [r for r in client_results if not r["pass"]]
    assert not failures, "\n".join(f"{r['name']}: {r['detail']}" for r in failures)


def test_the_offline_search_index_was_actually_exercised(client_results):
    """Guard against the pack silently going missing and the suite passing vacuously."""
    names = {r["name"] for r in client_results}
    assert "index has streets" in names
    assert "finds a street by prefix" in names


def test_offline_search_finds_real_street_names(client_results):
    hit = next(r for r in client_results if r["name"] == "finds a street by prefix")
    # The fixture pack is a real slice of Lower Manhattan; these come out of the road
    # graph, not a fixture list, so this also proves the pack carries street names.
    assert "Broadway" in hit["detail"]


def test_sms_separator_differs_by_platform(client_results):
    """The wrong separator silently drops the message body — worth pinning exactly."""
    by_name = {r["name"]: r["detail"] for r in client_results}
    assert by_name["android uses ? before the body"].startswith("sms:+15550101,5550102?body=")
    assert by_name["ios uses & before the body"].startswith("sms:+15550101&body=")
