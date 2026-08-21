import json
import logging
import os
from typing import Literal
from uuid import uuid4

from shapely.geometry import Point

from haven_sources import fetch_osm_safe_havens
from schemas import LatLon, SafeHaven

logger = logging.getLogger("onebar.safe_havens")


# Fallback seed used only when no region has been loaded and no OSM data is available
# (e.g. the synthetic offline grid). These are real Lower Manhattan buildings, but they
# are not confirmed as open shelters — hence verified=False. Any real deployment
# replaces these via seed_for_region().
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
        # haven id -> opaque device key of whoever added it. Discovered and default
        # havens have no reporter and belong to nobody.
        self._reporters: dict[str, str] = {}
        self._load()

    def _load(self) -> None:
        if self.persistence_file and os.path.exists(self.persistence_file):
            try:
                with open(self.persistence_file, encoding="utf-8") as f:
                    data = json.load(f)
                for item in data:
                    reporter = item.pop("reporter", None)
                    # A record written before provenance existed would otherwise
                    # inherit the schema default of "official" — turning a shelter
                    # somebody typed into one the app presents as issued by an
                    # authority. Only a haven that came from OSM may claim that.
                    if "provenance" not in item:
                        item["provenance"] = "official" if item.get("osm_id") else "user"
                        item["verified"] = False
                    haven = SafeHaven(**item)
                    self._havens[haven.id] = haven
                    if reporter:
                        self._reporters[haven.id] = reporter
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
                provenance="official",
                verified=False,
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
                    "provenance": h.provenance,
                    "source_url": h.source_url,
                    "osm_id": h.osm_id,
                    "verified": h.verified,
                    "visibility": h.visibility,
                    "reporter": self._reporters.get(h.id),
                }
                for h in self._havens.values()
            ]
            temp_file = f"{self.persistence_file}.tmp"
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            os.replace(temp_file, self.persistence_file)
        except Exception as e:
            logger.warning(f"Failed to save safe havens: {e}")

    # Metres a haven may sit from the nearest graph node and still be routable to.
    REACHABLE_TOLERANCE_M = 400.0

    def list(self, hazard_store=None, graph_manager=None, viewer: str | None = None) -> list[SafeHaven]:
        """Return all safe havens with live hazard-compromise and reachability status.

        `viewer` scopes which hazards count: a hazard one device drew privately must
        mark that shelter compromised for that device and for nobody else.
        """
        result = []
        for haven in self._havens.values():
            if not self._is_visible(haven, viewer):
                continue
            h_copy = haven.model_copy(update={
                "mine": viewer is not None and self._reporters.get(haven.id) == viewer,
            })
            if hazard_store:
                self._evaluate_compromise(h_copy, hazard_store, viewer)
            if graph_manager is not None:
                h_copy.reachable = graph_manager.contains(
                    h_copy.location.lon, h_copy.location.lat, self.REACHABLE_TOLERANCE_M
                )
            result.append(h_copy)
        return result

    def _is_visible(self, haven: SafeHaven, viewer: str | None) -> bool:
        """A haven added on one phone is a note to that phone, not a public shelter."""
        if haven.visibility != "private":
            return True
        return viewer is not None and self._reporters.get(haven.id) == viewer

    def get(self, haven_id: str, hazard_store=None, viewer: str | None = None) -> SafeHaven | None:
        haven = self._havens.get(haven_id)
        if not haven or not self._is_visible(haven, viewer):
            return None
        h_copy = haven.model_copy(update={
            "mine": viewer is not None and self._reporters.get(haven_id) == viewer,
        })
        if hazard_store:
            self._evaluate_compromise(h_copy, hazard_store, viewer)
        return h_copy

    def add(
        self,
        name: str,
        location: LatLon,
        haven_type: Literal["shelter", "hospital", "assembly_point", "perimeter_exit"] = "shelter",
        address: str | None = None,
        capacity: int | None = None,
        reporter: str | None = None,
    ) -> SafeHaven:
        """Add a shelter supplied by a client.

        Two things this must never do, both of which it used to do by omission:

        * inherit the schema's `provenance="official"` default, which made a shelter
          somebody typed indistinguishable from a mapped hospital; and
        * enter shared state, which let any anonymous client publish a destination that
          every other device would then be routed to. A fabricated hazard sends people
          around a road that is fine; a fabricated shelter sends them somewhere that may
          not exist.
        """
        hid = f"haven-{uuid4()}"
        haven = SafeHaven(
            id=hid,
            name=name,
            type=haven_type,
            location=location,
            address=address,
            capacity=capacity,
            is_compromised=False,
            provenance="user",
            verified=False,
            visibility="private",
            mine=True,
        )
        self._havens[hid] = haven
        if reporter:
            self._reporters[hid] = reporter
        self._save()
        return haven

    def remove(self, haven_id: str, requester: str | None = None, admin: bool = False) -> str:
        """Delete one haven. Returns "removed", "not_found" or "forbidden"."""
        haven = self._havens.get(haven_id)
        if haven is None:
            return "not_found"
        if not admin:
            if not self._is_visible(haven, requester):
                return "not_found"
            reporter = self._reporters.get(haven_id)
            if reporter is None or reporter != requester:
                return "forbidden"
        del self._havens[haven_id]
        self._reporters.pop(haven_id, None)
        self._save()
        return "removed"

    def get_safe_candidates(
        self,
        hazard_store=None,
        target_type: str = "all",
        graph_manager=None,
        viewer: str | None = None,
    ) -> list[SafeHaven]:
        """Return active, uncompromised, reachable safe havens matching target_type."""
        all_havens = self.list(hazard_store=hazard_store, graph_manager=graph_manager, viewer=viewer)
        candidates = []
        for h in all_havens:
            if h.is_compromised or not h.reachable:
                continue
            if target_type != "all" and h.type != target_type:
                continue
            candidates.append(h)
        return candidates

    def seed_for_region(self, center_lat: float, center_lon: float, bounds: dict[str, float] | None = None) -> None:
        """
        Populate havens for the loaded region from real OpenStreetMap features.

        This replaces an earlier implementation that invented havens at fixed lat/lon
        offsets with plausible-sounding names ("Civic Health Center West"). Those were
        fabrications presented to users as shelters, which is not acceptable in an
        emergency product. Every haven now corresponds to a mapped OSM feature and
        carries the OSM id it came from.

        If the OSM query fails — offline, rate-limited — we keep whatever is already
        stored and seed nothing. An empty shelter list is honest; an invented one is not.
        """
        if not bounds or bounds.get("min_lat") == bounds.get("max_lat"):
            return

        # Discovery hits the network. Tests and air-gapped deployments turn it off so
        # startup stays hermetic and deterministic.
        if os.getenv("ONEBAR_HAVEN_DISCOVERY", "1") == "0":
            return

        existing_osm = [h for h in self._havens.values() if h.provenance == "official" and h.osm_id]
        if existing_osm and self._covers(existing_osm, bounds):
            return

        discovered = fetch_osm_safe_havens(bounds)
        if not discovered:
            logger.warning(
                "No OSM safe havens could be fetched for bounds %s; leaving the haven "
                "list unchanged rather than seeding placeholders.", bounds
            )
            return

        # Replace the *discovered* set, keep everything a person put there. Assigning
        # the whole dict deleted every shelter a user had added on their own device —
        # silently, on the next restart, with no way to get it back.
        kept = {
            hid: haven for hid, haven in self._havens.items()
            if haven.visibility == "private" or hid in self._reporters
        }
        self._havens = {h.id: h for h in discovered}
        self._havens.update(kept)
        # Ownership entries for havens that no longer exist would otherwise accumulate.
        self._reporters = {hid: owner for hid, owner in self._reporters.items() if hid in self._havens}
        self._save()

    @staticmethod
    def _covers(havens: list[SafeHaven], bounds: dict[str, float]) -> bool:
        """True when at least one stored haven already sits inside the region bounds."""
        return any(
            bounds["min_lat"] <= h.location.lat <= bounds["max_lat"]
            and bounds["min_lon"] <= h.location.lon <= bounds["max_lon"]
            for h in havens
        )

    def _evaluate_compromise(self, haven: SafeHaven, hazard_store, viewer: str | None = None) -> None:
        """Check if haven location intersects any active hazard polygon."""
        pt = Point(haven.location.lon, haven.location.lat)
        for zone, poly in hazard_store.iter_polygons(viewer):
            if poly and (poly.contains(pt) or poly.distance(pt) < 0.0003):  # ~30m buffer
                haven.is_compromised = True
                haven.compromised_reason = f"Threatened by active hazard: {zone.name or zone.hazard_type.upper()}"
                return
        haven.is_compromised = False
        haven.compromised_reason = None
