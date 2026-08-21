import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from hazard_store import HazardStore
from safe_havens import SafeHavenStore
from schemas import LatLon


def test_safe_haven_store_init_and_list(tmp_path):
    temp_file = str(tmp_path / "test_havens.json")
    store = SafeHavenStore(persistence_file=temp_file)
    havens = store.list()
    assert len(havens) >= 3


def test_safe_haven_compromise_detection(tmp_path):
    haven_file = str(tmp_path / "havens.json")
    hazard_file = str(tmp_path / "hazards.json")

    haven_store = SafeHavenStore(persistence_file=haven_file)
    hazard_store = HazardStore(persistence_file=hazard_file)

    # A shelter somebody added on their own phone. It is private to that device, so
    # every read here has to identify itself as that device.
    device = "device-a"
    haven = haven_store.add(
        name="Test Pier Refuge",
        location=LatLon(lat=40.7100, lon=-74.0050),
        haven_type="shelter",
        reporter=device,
    )
    assert haven.provenance == "user"
    assert haven.visibility == "private"
    assert haven.verified is False

    # Initial check: uncompromised
    candidates_before = haven_store.get_safe_candidates(hazard_store=hazard_store, viewer=device)
    assert any(h.id == haven.id for h in candidates_before)

    # Add a hazard right on top of this haven
    hazard_store.add(
        center=LatLon(lat=40.7100, lon=-74.0050),
        radius_meters=100.0,
        name="Toxic Spill",
        hazard_type="closure",
    )

    # Check: now compromised and excluded from safe candidates
    candidates_after = haven_store.get_safe_candidates(hazard_store=hazard_store, viewer=device)
    assert not any(h.id == haven.id for h in candidates_after)


def test_a_client_cannot_publish_a_shelter_to_everybody(tmp_path):
    """
    A fabricated hazard costs other people a detour; a fabricated shelter is somewhere
    they are sent to.

    `add()` used to omit `provenance`, so a shelter anyone could POST inherited the
    schema default of "official" and entered global state — and the client rendered it
    as "VERIFIED SAFE HAVEN".
    """
    store = SafeHavenStore(persistence_file=str(tmp_path / "havens.json"))
    haven = store.add(
        name="Definitely A Real Shelter",
        location=LatLon(lat=40.7100, lon=-74.0050),
        reporter="device-a",
    )

    assert haven.provenance == "user"
    assert haven.verified is False
    assert haven.mine is True

    # Nobody else sees it, and it is never offered to them as a destination.
    assert not any(h.id == haven.id for h in store.list(viewer="device-b"))
    assert not any(h.id == haven.id for h in store.list())
    assert any(h.id == haven.id for h in store.list(viewer="device-a"))


def test_only_the_adding_device_may_remove_a_shelter(tmp_path):
    store = SafeHavenStore(persistence_file=str(tmp_path / "havens.json"))
    haven = store.add(name="My Garage", location=LatLon(lat=40.71, lon=-74.005), reporter="device-a")

    assert store.remove(haven.id, requester="device-b") == "not_found"
    assert store.remove(haven.id, requester="device-a") == "removed"
    assert store.remove(haven.id, requester="device-a") == "not_found"


def test_discovered_havens_belong_to_nobody_and_cannot_be_deleted(tmp_path):
    """A seeded or OSM-discovered haven has no reporter, so no device may remove it."""
    store = SafeHavenStore(persistence_file=str(tmp_path / "havens.json"))
    seeded = store.list()[0]
    assert store.remove(seeded.id, requester="device-a") == "forbidden"
    assert store.remove(seeded.id, admin=True) == "removed"


def test_ownership_survives_a_restart(tmp_path):
    path = str(tmp_path / "havens.json")
    store = SafeHavenStore(persistence_file=path)
    haven = store.add(name="My Garage", location=LatLon(lat=40.71, lon=-74.005), reporter="device-a")

    reopened = SafeHavenStore(persistence_file=path)
    assert any(h.id == haven.id for h in reopened.list(viewer="device-a"))
    assert not any(h.id == haven.id for h in reopened.list(viewer="device-b"))
    assert reopened.remove(haven.id, requester="device-a") == "removed"
