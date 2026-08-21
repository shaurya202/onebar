"""
The frontend, booted.

`static/js/app.js` runs a lot of code at module load — it wires roughly ninety DOM
elements, starts the connectivity poll and opens the first-run flow. There is no build
step (`static/` is the Capacitor webDir verbatim), so a renamed id or a declaration
used before it is initialised is not a build failure or a caught exception: it is a
blank screen on a phone during an emergency.

tools/boot_check.mjs boots the real page in jsdom and drives it. It found exactly that
class of bug the first time it ran — `initDisplaySettings()` reached a `const` declared
further down the module, which threw at load and left the app dead.
"""

import json
import os
import shutil
import subprocess

import pytest

REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
CLI = os.path.join(REPO_ROOT, "tools", "boot_check.mjs")
JSDOM = os.path.join(REPO_ROOT, "node_modules", "jsdom", "package.json")

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not os.path.exists(JSDOM),
    reason="Node or jsdom is unavailable (run: npm install)",
)


def run_boot_check(*args):
    proc = subprocess.run(
        ["node", CLI, *args], capture_output=True, text=True, cwd=REPO_ROOT,
    )
    assert proc.stdout, f"boot check produced no output: {proc.stderr}"
    return json.loads(proc.stdout)["checks"]


@pytest.fixture(scope="module")
def first_run():
    return run_boot_check()


@pytest.fixture(scope="module")
def returning_user():
    return run_boot_check("--onboarded")


@pytest.fixture(scope="module")
def online_session():
    """The same page driven against a canned API, so the route flow runs end to end."""
    return run_boot_check("--onboarded", "--online")


@pytest.fixture(scope="module")
def offline_capable_session():
    """A device with a region pack actually installed, and a reachable server.

    The interesting case: OneBar claims to be client-authoritative for routing, so with
    coverage on the device it must route locally *even though* the network is available.
    """
    return run_boot_check("--onboarded", "--online", "--pack")


def _assert_all_pass(checks):
    failures = [c for c in checks if not c["pass"]]
    assert not failures, "\n".join(f"{c['name']}: {c['detail']}" for c in failures)


def test_first_run_boots_and_walks_the_whole_flow(first_run):
    _assert_all_pass(first_run)


def test_returning_user_boots_and_the_dialogs_behave(returning_user):
    _assert_all_pass(returning_user)


def test_the_app_module_actually_loaded(first_run):
    """Guard against a harness that passes because it never ran the app at all."""
    boot = next(c for c in first_run if c["name"] == "app.js boots without throwing")
    assert boot["pass"], boot["detail"]
    names = {c["name"] for c in first_run}
    assert "the first-run flow opens on a fresh install" in names
    assert "the search box is a real input" in names


def test_dialog_focus_is_trapped_and_restored(returning_user):
    """Focus management existed nowhere; the SOS dialog is where it matters most."""
    by_name = {c["name"]: c for c in returning_user}
    for name in (
        "focus moves into the dialog",
        "Escape closes the dialog",
        "focus returns to what opened it",
    ):
        assert by_name[name]["pass"], f"{name}: {by_name[name]['detail']}"


def test_reports_are_private_until_explicitly_shared(returning_user):
    by_name = {c["name"]: c for c in returning_user}
    assert by_name["a report is private unless the user shares it"]["pass"]


def test_the_whole_route_flow_works_against_a_canned_api(online_session):
    _assert_all_pass(online_session)


def test_evacuating_without_a_position_refuses_rather_than_guessing(online_session):
    """
    The screen used to fall back to a hardcoded New York coordinate.

    Routing someone from a position that is not theirs, without saying so, is the worst
    thing this button can do.
    """
    by_name = {c["name"]: c for c in online_session}
    assert by_name["evacuating without a position refuses instead of guessing"]["pass"]
    assert by_name["and says what is missing"]["pass"], by_name["and says what is missing"]["detail"]


def test_a_route_renders_with_turn_by_turn_guidance(online_session):
    by_name = {c["name"]: c for c in online_session}
    for name in (
        "an evacuation route renders",
        "turn-by-turn steps are listed",
        "the guidance HUD shows the first instruction",
        "the destination shelter is named",
    ):
        assert by_name[name]["pass"], f"{name}: {by_name[name]['detail']}"


def test_every_request_is_attributed_to_this_device(online_session):
    """Writes are refused without it, and reads need it to return the caller's own reports."""
    by_name = {c["name"]: c for c in online_session}
    assert by_name["requests carry the device header"]["pass"]
    assert by_name["the device id looks like the server will accept it"]["pass"]


def test_a_downloaded_pack_takes_routing_off_the_network(offline_capable_session):
    """
    The premise of the product, asserted rather than assumed.

    Both routing paths must reach the on-device engine when a pack covers the origin —
    the evacuate button, and the custom planner, which had no offline path at all and so
    needed a connection for every searched address, tapped shelter and restored trip.
    """
    _assert_all_pass(offline_capable_session)

    by_name = {c["name"]: c for c in offline_capable_session}
    for name in (
        "the routing worker was used",
        "the server was not asked to route",
        "the custom planner routes from the pack too",
        "and did not fall back to the server",
    ):
        assert by_name[name]["pass"], f"{name}: {by_name[name]['detail']}"


def test_the_journey_survives_a_restart(offline_capable_session):
    by_name = {c["name"]: c for c in offline_capable_session}
    assert by_name["the journey is persisted for a restart"]["pass"],         by_name["the journey is persisted for a restart"]["detail"]
    assert by_name["the persisted journey keeps the travel mode"]["pass"]


def test_a_mapped_shelter_is_not_called_verified(offline_capable_session):
    """OpenStreetMap says a building exists, not that anybody has opened it."""
    by_name = {c["name"]: c for c in offline_capable_session}
    assert by_name["an unverified shelter is not called verified"]["pass"],         by_name["an unverified shelter is not called verified"]["detail"]
