"""
Destination search.

The top bar has always been drawn as a search field wrapped around a static label —
there was no search in the app at all. This module supplies it, in two layers that are
kept visibly distinct because they have different reliability:

* **Local** — street names from the loaded road graph and the names of known safe
  havens. Requires no network, is guaranteed to be inside routable coverage, and is
  the only layer that still works during the event OneBar exists for.
* **Remote** — a Nominatim geocoder for addresses and places the road graph cannot
  name. Optional, rate limited, and bounded to the loaded region.

Failure is reported as failure. A geocoder that is unreachable returns no results and
says so; it never guesses a coordinate, because a confidently wrong destination during
an evacuation is worse than an empty list.
"""

import logging
import os
import threading
import time
from typing import Any

import requests

from schemas import GeocodeResult, LatLon

logger = logging.getLogger("onebar.geocode")

NOMINATIM_URL = os.getenv("ONEBAR_GEOCODER_URL", "https://nominatim.openstreetmap.org/search")
NOMINATIM_REVERSE_URL = os.getenv(
    "ONEBAR_GEOCODER_REVERSE_URL", "https://nominatim.openstreetmap.org/reverse"
)
ATTRIBUTION = "Search results © OpenStreetMap contributors"

# The Nominatim usage policy caps automated use at one request per second and requires
# an identifying User-Agent. Both are enforced here rather than left to the operator.
_MIN_INTERVAL_SECONDS = 1.1
_REQUEST_TIMEOUT_SECONDS = 6.0
_HEADERS = {
    "User-Agent": "OneBar-Emergency-Routing/0.4 (offline evacuation routing; contact: ops@onebar.local)",
    "Accept": "application/json",
}

_throttle_lock = threading.Lock()
_last_request_at = 0.0
_cache: dict[str, tuple[float, list[GeocodeResult]]] = {}
_CACHE_SECONDS = 300.0


def geocoding_enabled() -> bool:
    return os.getenv("ONEBAR_GEOCODING", "1") not in ("0", "false", "False")


def parse_coordinate(query: str) -> LatLon | None:
    """Accept a pasted coordinate pair as a destination.

    People share positions as raw numbers constantly during an emergency; refusing to
    understand `40.7128, -74.0060` would be a needless dead end.
    """
    cleaned = query.replace(";", ",").replace("/", ",").strip()
    parts = [p.strip() for p in cleaned.split(",") if p.strip()]
    if len(parts) != 2:
        parts = [p for p in cleaned.split() if p]
        if len(parts) != 2:
            return None
    try:
        lat, lon = float(parts[0]), float(parts[1])
    except ValueError:
        return None
    if -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0:
        return LatLon(lat=lat, lon=lon)
    return None


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    from math import asin, cos, radians, sin, sqrt
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return 6371000.0 * 2 * asin(sqrt(a))


def _with_distance(hit: GeocodeResult, near: LatLon | None) -> GeocodeResult:
    if near is None:
        return hit.model_copy(update={"distance_meters": None})
    distance = _haversine_m(near.lat, near.lon, hit.location.lat, hit.location.lon)
    return hit.model_copy(update={"distance_meters": round(distance, 1)})


def search_local(
    graph_manager: Any,
    havens: list[Any],
    query: str,
    limit: int = 8,
    near: LatLon | None = None,
) -> list[GeocodeResult]:
    """Match a query against street names in the loaded graph and known haven names."""
    needle = query.strip().lower()
    if len(needle) < 2:
        return []

    scored: list[tuple[tuple[int, float, int], GeocodeResult]] = []

    def consider(name: str, subtitle: str, lat: float, lon: float, kind: str) -> None:
        haystack = name.lower()
        if needle not in haystack:
            return
        # A name that starts with the query is almost always what was meant, and on a
        # tie a named shelter beats a street: during an evacuation it is the more useful
        # answer. That tie-break has to be *in* the sort key — relying on insertion
        # order made it a coincidence of how the two loops happened to be ordered.
        rank = 0 if haystack.startswith(needle) else 1
        distance = _haversine_m(near.lat, near.lon, lat, lon) if near else 0.0
        scored.append((
            (rank, 0 if kind == "shelter" else 1, distance, len(name)),
            GeocodeResult(
                name=name,
                subtitle=subtitle,
                location=LatLon(lat=round(lat, 6), lon=round(lon, 6)),
                kind=kind,
                # A local hit is inside the *graph*, which is what makes it routable.
                # Havens can sit outside it, so this is checked rather than assumed.
                in_coverage=graph_manager.contains(lon, lat, 2000.0),
                source="offline",
                distance_meters=round(distance, 1) if near else None,
            ),
        ))

    for haven in havens:
        consider(
            haven.name,
            haven.address or haven.type.replace("_", " ").title(),
            haven.location.lat,
            haven.location.lon,
            "shelter",
        )

    for name, lat, lon in graph_manager.street_index():
        consider(name, "Street in downloaded map", lat, lon, "street")

    scored.sort(key=lambda item: item[0])

    seen: set[str] = set()
    out: list[GeocodeResult] = []
    for _, result in scored:
        key = result.name.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(result)
        if len(out) >= limit:
            break
    return out


def _throttle() -> None:
    """Hold to the geocoder's one-request-per-second policy.

    The sleep happens outside the lock. Holding it while sleeping serialised every
    caller behind the slowest one *and* pinned a request thread the whole time, so a
    burst of searches could starve the thread pool that also serves /route — the one
    endpoint that must never wait on a geocoder.
    """
    global _last_request_at
    with _throttle_lock:
        now = time.monotonic()
        earliest = max(now, _last_request_at + _MIN_INTERVAL_SECONDS)
        _last_request_at = earliest
        wait = earliest - now
    if wait > 0:
        time.sleep(wait)


def search_remote(
    query: str,
    bounds: dict[str, float] | None = None,
    limit: int = 5,
    near: LatLon | None = None,
) -> list[GeocodeResult]:
    """Geocode via Nominatim. Returns [] on any failure — never a guess."""
    if not geocoding_enabled() or len(query.strip()) < 3:
        return []

    # The cache holds the geocoder's answer, which does not depend on who asked.
    # Distances do, so they are stripped here and recomputed per caller below —
    # including `near` in the key instead would have made the cache almost never hit,
    # and leaving them in served one user's distances to the next.
    cache_key = f"{query.strip().lower()}|{limit}|{bounds}"
    cached = _cache.get(cache_key)
    if cached and time.monotonic() - cached[0] < _CACHE_SECONDS:
        return [_with_distance(hit, near) for hit in cached[1]]

    params: dict[str, Any] = {"q": query, "format": "jsonv2", "limit": limit, "addressdetails": 1}
    if bounds and bounds.get("min_lat") != bounds.get("max_lat"):
        params["viewbox"] = (
            f"{bounds['min_lon']},{bounds['min_lat']},{bounds['max_lon']},{bounds['max_lat']}"
        )
        # Bounded search keeps results inside the area OneBar can actually route in.
        params["bounded"] = 1

    try:
        _throttle()
        resp = requests.get(
            NOMINATIM_URL, params=params, headers=_HEADERS, timeout=_REQUEST_TIMEOUT_SECONDS
        )
        resp.raise_for_status()
        payload = resp.json()
    except Exception as e:
        logger.info("Geocoder unavailable for %r: %s", query, e)
        return []

    results: list[GeocodeResult] = []
    for item in payload if isinstance(payload, list) else []:
        try:
            lat, lon = float(item["lat"]), float(item["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        display = str(item.get("display_name", "")).strip()
        if not display:
            continue
        head, _, tail = display.partition(", ")
        results.append(GeocodeResult(
            name=head or display,
            subtitle=tail or str(item.get("type", "")).replace("_", " "),
            location=LatLon(lat=round(lat, 6), lon=round(lon, 6)),
            kind="address",
            source="network",
            in_coverage=False,
            distance_meters=None,
        ))

    _cache[cache_key] = (time.monotonic(), results)
    if len(_cache) > 256:
        _cache.clear()
    return [_with_distance(hit, near) for hit in results]


def reverse_local(graph_manager: Any, lat: float, lon: float) -> str | None:
    """Name the nearest street to a dropped pin, using only the loaded graph.

    Resolved through the nearest graph *node* and the streets meeting at it. Scanning
    `street_index()` instead compares against one representative point per street — the
    midpoint of its longest segment — so a pin at the far end of a long avenue could be
    named after a short side street whose midpoint happened to be closer.
    """
    if not graph_manager.contains(lon, lat, 250.0):
        # Beyond a couple of hundred metres the nearest named street is not a
        # description of where the pin is; say nothing rather than something misleading.
        return None
    try:
        node = graph_manager.nearest_node(lon, lat)
        graph = graph_manager.get_graph()
        names: list[str] = []
        for _u, _v, data in list(graph.edges(node, data=True)) + list(graph.in_edges(node, data=True)):
            raw = data.get("name")
            if not raw:
                continue
            for candidate in (raw if isinstance(raw, list) else [raw]):
                candidate = str(candidate).strip()
                if candidate and candidate not in names:
                    names.append(candidate)
        if names:
            # A junction is better described by both of its streets than by one.
            return " & ".join(names[:2])
    except Exception as e:
        logger.debug("Reverse lookup failed for %s,%s: %s", lat, lon, e)

    best_name, best_distance = None, float("inf")
    for name, n_lat, n_lon in graph_manager.street_index():
        distance = _haversine_m(lat, lon, n_lat, n_lon)
        if distance < best_distance:
            best_name, best_distance = name, distance
    return best_name if best_name and best_distance <= 250.0 else None


def reverse_remote(lat: float, lon: float) -> str | None:
    if not geocoding_enabled():
        return None
    try:
        _throttle()
        resp = requests.get(
            NOMINATIM_REVERSE_URL,
            params={"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 17},
            headers=_HEADERS,
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        display = str(resp.json().get("display_name", "")).strip()
        return display or None
    except Exception as e:
        logger.info("Reverse geocoder unavailable for %s,%s: %s", lat, lon, e)
        return None
