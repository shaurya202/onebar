# Annotations are evaluated lazily. HazardStore defines methods named `list` and `get`,
# which shadow the builtins for the rest of the class body, so an eagerly evaluated
# `list[HazardZone]` annotation on any member declared below them raises
# "TypeError: 'function' object is not subscriptable" at import time. Python 3.14
# postpones annotations by default (PEP 649) and hides that; the shipped runtime is
# 3.12 (see Dockerfile), where this import is the only thing keeping the module
# importable.
from __future__ import annotations

import json
import os
import threading
from datetime import UTC, datetime, timedelta
from hashlib import blake2s
from uuid import uuid4

from shapely.geometry import LineString
from shapely.strtree import STRtree

from schemas import EdgeKey, EdgeKeys, HazardZone, LatLon
from spatial import (
    blocked_edges_for_polygon,
    buffer_polygon,
    create_circle_polygon,
    from_shapely_polygon,
    to_shapely_polygon,
)

# Emergency information goes stale fast. A road reported impassable yesterday is not
# evidence about today, and a stale report still removes edges from everybody's
# routing graph — so every user-originated hazard carries an expiry and stops being
# applied once it passes. Official alerts are exempt: they are retired by the feed
# that issued them, and carry the issuer's own expiry when one is published.
DEFAULT_PRIVATE_TTL_HOURS = 24.0
DEFAULT_COMMUNITY_TTL_HOURS = 6.0
# Each independent confirmation buys a shared report more time, up to a hard ceiling.
CONFIRM_EXTENSION_HOURS = 2.0
COMMUNITY_MAX_TTL_HOURS = 24.0
# A report this many people say is wrong, with more denials than confirmations, is
# retired automatically rather than waiting for a moderator who may not exist.
DENY_RETIRE_THRESHOLD = 3
# ...and from at least this many distinct network sources. Device identifiers are
# minted by the client, so three "independent" denials are three lines of a script
# unless something outside the client's control has to differ. Removing a report that
# is true is the dangerous direction, so this errs toward leaving it standing; a wrong
# report expires on its own within hours anyway.
DENY_DISTINCT_SOURCES = 2

# An official alert whose issuer publishes no expiry still must not block roads for
# ever. Re-syncing refreshes this window, so a standing alert stays as long as the feed
# keeps returning it and ages out within one window once the feed drops it.
DEFAULT_OFFICIAL_MAX_AGE_HOURS = 6.0
# Drill fixtures are scoped to the device that asked for them and are short-lived.
DEFAULT_DRILL_TTL_HOURS = 2.0


def _env_hours(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def stable_feed_id(source: str | None, source_url: str | None, name: str | None, observed_at: str | None) -> str:
    """A deterministic id for an alert pulled from an external feed.

    Feed syncs run on a timer, so without this the same NWS alert was inserted afresh
    every ninety seconds and the map filled with duplicates of one warning.

    The key is the issuer's own identifier where there is one, and *only* that: folding
    in the headline and the effective time meant an alert whose text was revised — which
    is routine for a running weather warning — hashed to a new id and appeared a second
    time alongside its earlier self.
    """
    if source_url:
        material = f"{source or ''}|{source_url}"
    else:
        material = "|".join(str(part or "") for part in (source, name, observed_at))
    return f"feed-{blake2s(material.encode('utf-8'), digest_size=12).hexdigest()}"


def _now() -> datetime:
    return datetime.now(UTC)


def _normalise_votes(raw) -> dict[str, dict]:
    """Accept both the old {owner: kind} shape and the current one."""
    out: dict[str, dict] = {}
    for owner, value in (raw or {}).items():
        if isinstance(value, dict):
            kind = str(value.get("kind", "confirm"))
            source = value.get("source")
        else:
            kind, source = str(value), None
        out[str(owner)] = {"kind": kind, "source": source}
    return out


def _count(votes: dict[str, dict], kind: str) -> int:
    return sum(1 for v in votes.values() if v.get("kind") == kind)


def _distinct_sources(votes: dict[str, dict], kind: str) -> int:
    """How many distinct network origins a verdict came from.

    A vote whose source is unknown counts as its own origin, so an older record or a
    deployment behind a proxy that strips the peer address degrades toward "each vote is
    independent" rather than toward "no vote counts".
    """
    sources = set()
    for owner, vote in votes.items():
        if vote.get("kind") != kind:
            continue
        sources.add(vote.get("source") or f"unknown:{owner}")
    return len(sources)


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


class HazardStore:
    def __init__(self, persistence_file: str | None = "hazards_store.json") -> None:
        self.persistence_file = persistence_file
        # Each entry: {"zone": HazardZone, "polygon": Polygon, "reporter": str | None,
        #              "votes": {owner_key: "confirm" | "deny"}}
        self._hazards: dict[str, dict] = {}
        # The store is a process-global singleton served by a thread pool, and several
        # paths mutate the dict while another request iterates it. Without this, two
        # concurrent requests could raise "dictionary changed size during iteration"
        # and answer an evacuation request with HTTP 500.
        self._lock = threading.RLock()
        if self.persistence_file:
            self._load()

    # --- persistence ---------------------------------------------------------

    def _load(self) -> None:
        if not self.persistence_file or not os.path.exists(self.persistence_file):
            return
        try:
            with open(self.persistence_file, encoding="utf-8") as f:
                data = json.load(f)
            for item in data:
                coords = [LatLon(**c) for c in item["coordinates"]]
                center = LatLon(**item["center"]) if item.get("center") else None
                radius = item.get("radius_meters")
                buf = float(item.get("buffer_meters", 0.0))

                if center and radius:
                    raw_poly = create_circle_polygon(center.lat, center.lon, radius)
                else:
                    raw_poly = to_shapely_polygon(coords)

                eff_poly = buffer_polygon(raw_poly, buf) if buf > 0 else raw_poly
                # Votes were once a bare {owner: kind} map; entries are now
                # {owner: {"kind": ..., "source": ...}} so a retirement can require
                # more than one network origin. Old records upgrade in place.
                votes = _normalise_votes(item.get("votes"))

                zone = HazardZone(
                    hazard_id=item["hazard_id"],
                    name=item.get("name"),
                    hazard_type=item.get("hazard_type", "closure"),
                    coordinates=coords,
                    effective_coordinates=from_shapely_polygon(eff_poly),
                    center=center,
                    radius_meters=radius,
                    buffer_meters=buf,
                    source=item.get("source"),
                    severity=item.get("severity"),
                    description=item.get("description"),
                    # Records written before provenance existed cannot be assumed
                    # authoritative — default to the conservative value.
                    provenance=item.get("provenance", "user"),
                    source_url=item.get("source_url"),
                    observed_at=item.get("observed_at"),
                    created_at=item.get("created_at", _now().isoformat()),
                    # Likewise for visibility: a record from before scoping existed
                    # has no known reporter, so treat it as shared rather than
                    # attributing it to whoever happens to ask next.
                    visibility=item.get("visibility", "shared"),
                    confirmations=_count(votes, "confirm"),
                    denials=_count(votes, "deny"),
                    # A record written before expiry existed has none, and without a
                    # backfill it never expires, belongs to nobody, is visible to
                    # everyone and cannot be deleted through any endpoint an ordinary
                    # user has — a road closure drawn a year ago blocking evacuation
                    # routing region-wide, permanently.
                    expires_at=self._migrated_expiry(item),
                )

                self._hazards[zone.hazard_id] = {
                    "zone": zone,
                    "polygon": eff_poly,
                    "reporter": item.get("reporter"),
                    "votes": votes,
                }
        except Exception as e:
            print(f"Warning: Failed to load hazards from {self.persistence_file}: {e}")

    def _save(self) -> None:
        if not self.persistence_file:
            return
        try:
            items = list(self._hazards.values())
            data = [
                {
                    "hazard_id": item["zone"].hazard_id,
                    "name": item["zone"].name,
                    "hazard_type": item["zone"].hazard_type,
                    "coordinates": [{"lat": c.lat, "lon": c.lon} for c in item["zone"].coordinates],
                    "center": {"lat": item["zone"].center.lat, "lon": item["zone"].center.lon} if item["zone"].center else None,
                    "radius_meters": item["zone"].radius_meters,
                    "buffer_meters": item["zone"].buffer_meters,
                    "source": item["zone"].source,
                    "severity": item["zone"].severity,
                    "description": item["zone"].description,
                    "provenance": item["zone"].provenance,
                    "source_url": item["zone"].source_url,
                    "observed_at": item["zone"].observed_at,
                    "created_at": item["zone"].created_at,
                    "visibility": item["zone"].visibility,
                    "expires_at": item["zone"].expires_at,
                    # The reporter is stored as an opaque keyed hash (see device.py),
                    # never as the raw identifier the client sent.
                    "reporter": item.get("reporter"),
                    "votes": item.get("votes") or {},
                }
                for item in items
            ]
            # A per-write temp name: a fixed ".tmp" path is a shared mutable file,
            # and two concurrent saves could interleave and publish a truncated store.
            temp_file = f"{self.persistence_file}.{os.getpid()}.{threading.get_ident()}.tmp"
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            os.replace(temp_file, self.persistence_file)
        except Exception as e:
            print(f"Warning: Failed to save hazards to {self.persistence_file}: {e}")

    # --- lifetime ------------------------------------------------------------

    @classmethod
    def _migrated_expiry(cls, item: dict) -> str | None:
        """The expiry for a stored record, inventing one only where none can exist."""
        if item.get("expires_at"):
            return item["expires_at"]
        provenance = item.get("provenance", "user")
        hours = cls._default_ttl_hours(provenance, item.get("visibility", "shared"))
        if hours is None:
            return None
        # Measured from when the report was made, not from now: a year-old record must
        # not be granted a fresh 24 hours every time the process restarts.
        created = _parse_iso(item.get("created_at")) or _now()
        return (created + timedelta(hours=hours)).isoformat()

    @staticmethod
    def _default_ttl_hours(provenance: str, visibility: str) -> float | None:
        if provenance == "official":
            # Not a guess at when the alert ends — the issuer's own expiry is used
            # whenever it publishes one. This is a bound on how long we keep applying an
            # alert nobody is publishing any more, refreshed by every re-sync.
            return _env_hours("ONEBAR_OFFICIAL_MAX_AGE_H", DEFAULT_OFFICIAL_MAX_AGE_HOURS)
        if provenance == "drill":
            return _env_hours("ONEBAR_DRILL_TTL_H", DEFAULT_DRILL_TTL_HOURS)
        if visibility == "private":
            return _env_hours("ONEBAR_USER_HAZARD_TTL_H", DEFAULT_PRIVATE_TTL_HOURS)
        return _env_hours("ONEBAR_COMMUNITY_TTL_H", DEFAULT_COMMUNITY_TTL_HOURS)

    @staticmethod
    def _clamp_ttl_hours(hours: float | None, provenance: str, visibility: str) -> float | None:
        """Hold a client-supplied lifetime to the same ceiling a confirmed report has.

        `ttl_hours` comes from the request body. Without this a shared report could ask
        for a week, outliving every rule about how long a community report may stand.
        """
        if hours is None:
            return None
        if provenance in ("official", "drill"):
            return hours
        ceiling = (
            _env_hours("ONEBAR_USER_HAZARD_TTL_H", DEFAULT_PRIVATE_TTL_HOURS)
            if visibility == "private"
            else _env_hours("ONEBAR_COMMUNITY_MAX_TTL_H", COMMUNITY_MAX_TTL_HOURS)
        )
        return min(hours, ceiling)

    def _is_expired(self, item: dict, now: datetime | None = None) -> bool:
        expires = _parse_iso(item["zone"].expires_at)
        if expires is None:
            return False
        return expires <= (now or _now())

    def purge_expired(self) -> int:
        """Drop hazards past their expiry. Called before every read and write."""
        now = _now()
        with self._lock:
            stale = [hid for hid, item in list(self._hazards.items()) if self._is_expired(item, now)]
            for hid in stale:
                del self._hazards[hid]
            if stale:
                self._save()
        return len(stale)

    # --- visibility ----------------------------------------------------------

    @staticmethod
    def _is_visible(item: dict, viewer: str | None) -> bool:
        """A private report is visible to, and routed around by, its reporter alone."""
        if item["zone"].visibility != "private":
            return True
        return viewer is not None and item.get("reporter") == viewer

    def _decorate(self, item: dict, viewer: str | None) -> HazardZone:
        """Return a per-request copy carrying the caller's own relationship to it.

        A copy, not the stored object: `mine` differs per caller, and writing it onto
        the shared instance would leak one device's ownership to the next request.
        """
        votes = item.get("votes") or {}
        mine = votes.get(viewer) if viewer else None
        return item["zone"].model_copy(update={
            "mine": viewer is not None and item.get("reporter") == viewer,
            "my_vote": mine.get("kind") if isinstance(mine, dict) else None,
            "confirmations": _count(votes, "confirm"),
            "denials": _count(votes, "deny"),
        })

    def _visible_items(self, viewer: str | None) -> list[dict]:
        self.purge_expired()
        with self._lock:
            # A snapshot: callers iterate this while other requests are mutating.
            return [item for item in list(self._hazards.values()) if self._is_visible(item, viewer)]

    # --- mutation ------------------------------------------------------------

    def add(
        self,
        coordinates: list[LatLon] | None = None,
        name: str | None = None,
        hazard_type: str = "closure",
        center: LatLon | None = None,
        radius_meters: float | None = None,
        buffer_meters: float = 0.0,
        source: str | None = None,
        severity: str | None = None,
        description: str | None = None,
        provenance: str = "user",
        source_url: str | None = None,
        observed_at: str | None = None,
        hazard_id: str | None = None,
        reporter: str | None = None,
        visibility: str = "shared",
        ttl_hours: float | None = None,
        expires_at: str | None = None,
    ) -> HazardZone:
        self.purge_expired()
        hid = hazard_id or str(uuid4())

        if center and radius_meters:
            raw_poly = create_circle_polygon(center.lat, center.lon, radius_meters)
            final_coords = from_shapely_polygon(raw_poly)
        elif coordinates:
            raw_poly = to_shapely_polygon(coordinates)
            final_coords = coordinates
        else:
            raise ValueError("Must provide either coordinates or center with radius_meters.")

        eff_poly = buffer_polygon(raw_poly, buffer_meters) if buffer_meters > 0 else raw_poly

        if expires_at is None:
            hours = (
                self._clamp_ttl_hours(ttl_hours, provenance, visibility)
                if ttl_hours is not None
                else self._default_ttl_hours(provenance, visibility)
            )
            if hours is not None:
                expires_at = (_now() + timedelta(hours=hours)).isoformat()

        zone = HazardZone(
            hazard_id=hid,
            name=name,
            hazard_type=hazard_type,
            coordinates=final_coords,
            effective_coordinates=from_shapely_polygon(eff_poly),
            center=center,
            radius_meters=radius_meters,
            buffer_meters=buffer_meters,
            source=source,
            severity=severity,
            description=description,
            provenance=provenance,
            source_url=source_url,
            observed_at=observed_at,
            created_at=_now().isoformat(),
            visibility=visibility,
            expires_at=expires_at,
        )

        # Re-syncing a feed replaces the existing record rather than duplicating it,
        # but must not silently discard community votes on a shared report.
        with self._lock:
            existing = self._hazards.get(hid)
            self._hazards[hid] = {
                "zone": zone,
                "polygon": eff_poly,
                "reporter": reporter if reporter is not None else (existing or {}).get("reporter"),
                "votes": (existing or {}).get("votes", {}),
            }
            self._save()
            return self._decorate(self._hazards[hid], reporter)

    def remove(self, hazard_id: str, requester: str | None = None, admin: bool = False) -> str:
        """Delete one hazard.

        Returns "removed", "not_found" or "forbidden". Ownership is enforced here
        rather than at the endpoint so no future caller can route around it: before
        this check any anonymous client could delete anyone's report, including live
        official alerts.
        """
        with self._lock:
            item = self._hazards.get(hazard_id)
            if item is None:
                return "not_found"
            if not admin:
                if not self._is_visible(item, requester):
                    return "not_found"
                if item.get("reporter") is None or item.get("reporter") != requester:
                    return "forbidden"
            del self._hazards[hazard_id]
            self._save()
            return "removed"

    def vote(
        self, hazard_id: str, voter: str, kind: str, source: str | None = None,
    ) -> tuple[HazardZone | None, bool, str]:
        """Record a confirm/deny on a shared community report.

        Returns `(zone, retired, message)`. `zone` is None when the report no longer
        exists — either because it was not found or because this vote retired it.

        `source` is the caller's network origin. Retiring a report needs denials from
        more than one of them: device identifiers are minted by the client, so without
        it three "independent" people saying a road is clear is three lines of a script,
        and the road it clears may be the one that is actually flooded.
        """
        self.purge_expired()
        with self._lock:
            item = self._hazards.get(hazard_id)
            if item is None or not self._is_visible(item, voter):
                return None, False, "That report no longer exists."

            zone = item["zone"]
            if zone.provenance != "community":
                # An NWS warning is not put to a vote, and neither is a drill fixture.
                return self._decorate(item, voter), False, (
                    "Only community reports can be confirmed or denied."
                )
            if item.get("reporter") == voter:
                return self._decorate(item, voter), False, (
                    "You reported this. Confirmation has to come from someone else."
                )

            votes = item.setdefault("votes", {})
            votes[voter] = {"kind": "confirm" if kind == "confirm" else "deny", "source": source}
            confirmations = _count(votes, "confirm")
            denials = _count(votes, "deny")

            if (denials >= DENY_RETIRE_THRESHOLD
                    and denials > confirmations
                    and _distinct_sources(votes, "deny") >= DENY_DISTINCT_SOURCES):
                del self._hazards[hazard_id]
                self._save()
                return None, True, "Report retired — more people reported it clear than blocked."

            if kind == "confirm":
                created = _parse_iso(zone.created_at) or _now()
                ceiling = created + timedelta(hours=_env_hours("ONEBAR_COMMUNITY_MAX_TTL_H", COMMUNITY_MAX_TTL_HOURS))
                current = _parse_iso(zone.expires_at) or _now()
                extended = min(current + timedelta(hours=CONFIRM_EXTENSION_HOURS), ceiling)
                if extended > current:
                    item["zone"] = zone.model_copy(update={"expires_at": extended.isoformat()})

            item["zone"] = item["zone"].model_copy(update={
                "confirmations": confirmations, "denials": denials,
            })
            self._save()
            return self._decorate(item, voter), False, (
                "Thanks — confirmed." if kind == "confirm" else "Thanks — marked as clear."
            )

    def clear(self) -> int:
        with self._lock:
            count = len(self._hazards)
            self._hazards.clear()
            self._save()
            return count

    def clear_provenance(self, provenance: str, reporter: str | None = None) -> int:
        """Drop hazards of one provenance, optionally only a given reporter's.

        Drill fixtures belong to the device that started the drill, so exiting a drill
        must not clear somebody else's — including, on a shared deployment, a drill a
        different team is in the middle of running.
        """
        with self._lock:
            doomed = [
                hid for hid, item in list(self._hazards.items())
                if item["zone"].provenance == provenance
                and (reporter is None or item.get("reporter") == reporter)
            ]
            for hid in doomed:
                del self._hazards[hid]
            if doomed:
                self._save()
            return len(doomed)

    # --- reads ---------------------------------------------------------------

    def get(self, hazard_id: str, viewer: str | None = None) -> HazardZone | None:
        self.purge_expired()
        item = self._hazards.get(hazard_id)
        if item is None or not self._is_visible(item, viewer):
            return None
        return self._decorate(item, viewer)

    def list(self, viewer: str | None = None) -> list[HazardZone]:
        return [self._decorate(item, viewer) for item in self._visible_items(viewer)]

    def iter_polygons(self, viewer: str | None = None):
        """Yield (HazardZone, effective Polygon) pairs the given viewer can see.

        Public accessor so callers such as SafeHavenStore do not have to reach into
        the private `_hazards` dict and break when its shape changes.
        """
        for item in self._visible_items(viewer):
            yield item["zone"], item["polygon"]

    def blocked_edges(
        self,
        spatial_index: STRtree | None,
        linestrings: list[LineString],
        edge_keys: EdgeKeys,
        viewer: str | None = None,
    ) -> set[EdgeKey]:
        if spatial_index is None or not linestrings:
            return set()
        result: set[EdgeKey] = set()
        for item in self._visible_items(viewer):
            result |= blocked_edges_for_polygon(item["polygon"], spatial_index, linestrings, edge_keys)
        return result
