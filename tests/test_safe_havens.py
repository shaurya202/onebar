import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from schemas import LatLon
from safe_havens import SafeHavenStore
from hazard_store import HazardStore


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

    # Add a custom haven
    haven = haven_store.add(
        name="Test Pier Refuge",
        location=LatLon(lat=40.7100, lon=-74.0050),
        haven_type="shelter",
    )

    # Initial check: uncompromised
    candidates_before = haven_store.get_safe_candidates(hazard_store=hazard_store)
    assert any(h.id == haven.id for h in candidates_before)

    # Add a hazard right on top of this haven
    hazard_store.add(
        center=LatLon(lat=40.7100, lon=-74.0050),
        radius_meters=100.0,
        name="Toxic Spill",
        hazard_type="closure",
    )

    # Check: now compromised and excluded from safe candidates
    candidates_after = haven_store.get_safe_candidates(hazard_store=hazard_store)
    assert not any(h.id == haven.id for h in candidates_after)
