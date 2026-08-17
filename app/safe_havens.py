import os
import json
import logging
from typing import Literal
from uuid import uuid4
from shapely.geometry import Point

from schemas import LatLon, SafeHaven
from spatial import haversine

logger = logging.getLogger("onebar.safe_havens")


# Default verified emergency shelters & critical medical hubs for Lower Manhattan / NYC
DEFAULT_NYC_SAFE_HAVENS = [
    {
        "id": "haven-shelter-stuyvesant",
        "name": "Stuyvesant High Emergency Evacuation Shelter",
        "type": "shelter",
        "location": {"lat": 40.7178, "lon": -74.0138},
        "address": "345 Chambers St, New York, NY 10282",
        "capacity": 1200,
    },
    {
        "id": "haven-hospital-downtown",
        "name": "NewYork-Presbyterian Lower Manhattan Hospital",
        "type": "hospital",
        "location": {"lat": 40.7108, "lon": -74.0049},
        "address": "170 William St, New York, NY 10038",
        "capacity": 450,
    },
    {
        "id": "haven-shelter-pace",
        "name": "Pace Community Emergency Relief Center",
        "type": "shelter",
        "location": {"lat": 40.7112, "lon": -74.0055},
        "address": "1 Pace Plaza, New York, NY 10038",
        "capacity": 800,
    },
    {
        "id": "haven-assembly-battery-pier",
        "name": "Battery Park Pier A Maritime Evacuation Point",
        "type": "assembly_point",
        "location": {"lat": 40.7042, "lon": -74.0172},
        "address": "22 Battery Pl, New York, NY 10004",
        "capacity": 2500,
    },
    {
        "id": "haven-shelter-murry",
        "name": "Murry Bergtraum Emergency Center",
        "type": "shelter",
        "location": {"lat": 40.7122, "lon": -73.9995},
        "address": "411 Pearl St, New York, NY 10038",
        "capacity": 650,
    },
    {
        "id": "haven-assembly-city-hall",
        "name": "City Hall Park Emergency Triage & Rally Hub",
        "type": "assembly_point",
        "location": {"lat": 40.7126, "lon": -74.0068},
        "address": "Broadway & Murray St, New York, NY 10007",
        "capacity": 1500,
    },
]


class SafeHavenStore:
    def __init__(self, persistence_file: str | None = "safe_havens_store.json") -> None:
        self.persistence_file = persistence_file
        self._havens: dict[str, SafeHaven] = {}
        self._load()

    def _load(self) -> None:
        if self.persistence_file and os.path.exists(self.persistence_file):
            try:
                with open(self.persistence_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                for item in data:
                    haven = SafeHaven(**item)
                    self._havens[haven.id] = haven
                return
            except Exception as e:
                logger.warning(f"Failed to load safe havens from {self.persistence_file}: {e}")

        # Seed defaults
        for d in DEFAULT_NYC_SAFE_HAVENS:
            haven = SafeHaven(
                id=d["id"],
                name=d["name"],
                type=d["type"],
                location=LatLon(**d["location"]),
                address=d.get("address"),
                capacity=d.get("capacity"),
                is_compromised=False,
            )
            self._havens[haven.id] = haven

    def _save(self) -> None:
        if not self.persistence_file:
            return
        try:
            data = [
                {
                    "id": h.id,
                    "name": h.name,
                    "type": h.type,
                    "location": {"lat": h.location.lat, "lon": h.location.lon},
                    "address": h.address,
                    "capacity": h.capacity,
                    "is_compromised": h.is_compromised,
                    "compromised_reason": h.compromised_reason,
                }
                for h in self._havens.values()
            ]
            temp_file = f"{self.persistence_file}.tmp"
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            os.replace(temp_file, self.persistence_file)
        except Exception as e:
            logger.warning(f"Failed to save safe havens: {e}")

    def list(self, hazard_store=None) -> list[SafeHaven]:
        """Return all safe havens with real-time hazard compromise evaluation."""
        result = []
        for haven in self._havens.values():
            h_copy = haven.model_copy()
            if hazard_store:
                self._evaluate_compromise(h_copy, hazard_store)
            result.append(h_copy)
        return result

    def get(self, haven_id: str, hazard_store=None) -> SafeHaven | None:
        haven = self._havens.get(haven_id)
        if not haven:
            return None
        h_copy = haven.model_copy()
        if hazard_store:
            self._evaluate_compromise(h_copy, hazard_store)
        return h_copy

    def add(
        self,
        name: str,
        location: LatLon,
        haven_type: Literal["shelter", "hospital", "assembly_point", "perimeter_exit"] = "shelter",
        address: str | None = None,
        capacity: int | None = None,
    ) -> SafeHaven:
        hid = f"haven-{uuid4()}"
        haven = SafeHaven(
            id=hid,
            name=name,
            type=haven_type,
            location=location,
            address=address,
            capacity=capacity,
            is_compromised=False,
        )
        self._havens[hid] = haven
        self._save()
        return haven

    def get_safe_candidates(
        self,
        hazard_store=None,
        target_type: str = "all",
    ) -> list[SafeHaven]:
        """Return only active, uncompromised safe havens matching target_type."""
        all_havens = self.list(hazard_store=hazard_store)
        candidates = []
        for h in all_havens:
            if h.is_compromised:
                continue
            if target_type != "all" and h.type != target_type:
                continue
            candidates.append(h)
        return candidates

    def seed_for_region(self, center_lat: float, center_lon: float, bounds: dict[str, float] | None = None) -> None:
        """If current center is far from NYC defaults, seed realistic regional safe havens around center."""
        first = next(iter(self._havens.values()), None)
        if first:
            dist_to_nyc = haversine(center_lat, center_lon, 40.7128, -74.0060)
            if dist_to_nyc < 25000:  # Within 25km of NYC, keep NYC defaults
                return

        # Seed custom regional havens around center
        d_lat = 0.003
        d_lon = 0.0035

        regional = [
            {
                "id": "haven-regional-shelter-north",
                "name": "Regional Emergency Evacuation Shelter (North)",
                "type": "shelter",
                "location": {"lat": round(center_lat + d_lat * 1.5, 6), "lon": round(center_lon + d_lon * 1.2, 6)},
                "address": "Community High Gymnasium, Safe Zone North",
                "capacity": 950,
            },
            {
                "id": "haven-regional-hospital-west",
                "name": "Emergency Medical Center & Triage",
                "type": "hospital",
                "location": {"lat": round(center_lat + d_lat * 0.4, 6), "lon": round(center_lon - d_lon * 1.8, 6)},
                "address": "Civic Health Center West",
                "capacity": 500,
            },
            {
                "id": "haven-regional-assembly-south",
                "name": "Municipal Safe Haven & Relief Hub",
                "type": "assembly_point",
                "location": {"lat": round(center_lat - d_lat * 1.6, 6), "lon": round(center_lon - d_lon * 0.6, 6)},
                "address": "Central Park Evacuation Field South",
                "capacity": 2000,
            },
        ]

        self._havens.clear()
        for d in regional:
            haven = SafeHaven(
                id=d["id"],
                name=d["name"],
                type=d["type"],
                location=LatLon(**d["location"]),
                address=d.get("address"),
                capacity=d.get("capacity"),
                is_compromised=False,
            )
            self._havens[haven.id] = haven
        self._save()

    def _evaluate_compromise(self, haven: SafeHaven, hazard_store) -> None:
        """Check if haven location intersects any active hazard polygon."""
        pt = Point(haven.location.lon, haven.location.lat)
        # Check against each hazard in store
        for item in hazard_store._hazards.values():
            poly = item.get("polygon")
            zone = item.get("zone")
            if poly and (poly.contains(pt) or poly.distance(pt) < 0.0003):  # ~30m buffer
                haven.is_compromised = True
                haven.compromised_reason = f"Threatened by active hazard: {zone.name or zone.hazard_type.upper()}"
                return
        haven.is_compromised = False
        haven.compromised_reason = None
