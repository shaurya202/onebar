import json
import os
import re
import threading
import time
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse

from device import is_admin, peer_source, require_device, viewer_key
from geocode import (
    ATTRIBUTION,
    geocoding_enabled,
    parse_coordinate,
    reverse_local,
    reverse_remote,
    search_local,
    search_remote,
)
from hazard_feed import fetch_all_external_hazards
from hazard_store import stable_feed_id
from router import encode_polyline, find_fastest_route_to_safety, find_route, path_to_coords
from schemas import (
    GeocodeResponse,
    GeocodeResult,
    HazardCreateRequest,
    HazardListResponse,
    HazardSyncRequest,
    HazardSyncResponse,
    HazardVoteResponse,
    HazardZone,
    LatLon,
    RegionInfoResponse,
    ReverseGeocodeResponse,
    RouteRequest,
    RouteResponse,
    SafeHaven,
    SafeHavenCreateRequest,
    SafeHavenListResponse,
    SafetyRouteRequest,
    SafetyRouteResponse,
)

api_router = APIRouter()

# Pre-built region packs live here; override for a CDN-backed deployment.
_PACK_DIR = os.getenv(
    "ONEBAR_PACK_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "packs"),
)

# How far outside the loaded graph a coordinate may sit and still be routed from.
# Beyond this the honest answer is "we don't have this area", not a snapped route.
COVERAGE_TOLERANCE_M = 2000.0

# Official feeds are the same for every client in a region, so one client's sync
# serves them all for a while. The background poller runs every 90 s per device;
# without this each device hammered NWS, USGS and EONET independently.
_FEED_CACHE_SECONDS = float(os.getenv("ONEBAR_FEED_CACHE_SECONDS", "120"))
# What is cached is the upstream *result*, not the response. Ingestion runs on every
# sync regardless, so a cache hit still reconciles the store — otherwise clearing drill
# data and re-syncing within the window would report hazards that are not on the map.
_feed_cache: dict[tuple, tuple[float, list[dict], list[str]]] = {}
_feed_cache_lock = threading.Lock()


def _require_coverage(gm, point: LatLon, label: str) -> None:
    """Refuse with 422 when a coordinate lies outside the loaded road graph.

    Without this check `nearest_node` snaps any coordinate on Earth onto the loaded
    graph, so a user in another city receives a fully-formed route with plausible
    times and turn instructions that has nothing to do with where they are.
    """
    if gm.contains(point.lon, point.lat, COVERAGE_TOLERANCE_M):
        return
    distance_km = round(gm.distance_outside_m(point.lon, point.lat) / 1000.0, 1)
    raise HTTPException(422, {
        "detail": (
            f"Your {label} is {distance_km} km outside the downloaded map area. "
            "Download coverage for this region to route here."
        ),
        "outside_coverage": True,
        "distance_km": distance_km,
        "bounds": gm.get_summary().get("bounds", {}),
    })


def _require_real_graph(gm) -> None:
    """Refuse to route when no real road network was ever loaded.

    Falling back to the synthetic grid keeps the server up, which is useful. Routing
    along it is not: its edges are invented streets at real Lower Manhattan
    coordinates, so a user genuinely standing there passes the coverage check and
    receives turn-by-turn directions down roads that do not exist.
    """
    if not getattr(gm, "is_synthetic", False):
        return
    raise HTTPException(503, {
        "detail": (
            "No road network is loaded for this deployment, so OneBar cannot compute a "
            "route. This is a server configuration problem, not something you can fix "
            "from the app."
        ),
        "no_map": True,
    })


def _require_mode(gm, mode: str) -> None:
    """Refuse a travel mode the loaded graph cannot honestly serve."""
    supported = gm.supported_modes()
    if mode in supported:
        return
    raise HTTPException(422, {
        "detail": (
            f"The downloaded map for this area contains no {mode}-accessible roads. "
            f"Available modes: {', '.join(supported) if supported else 'none'}."
        ),
        "unsupported_mode": mode,
        "supported_modes": supported,
    })


def _feed_record_id(item: dict, drill_device: str | None) -> str:
    """The storage id for one ingested feed item.

    A stable id derived from the issuing source turns a re-sync into an update. Without
    it the 90-second background poll re-inserted every standing alert, and one flood
    watch became dozens of overlapping copies.

    Drill fixtures are namespaced by device: they are private to whoever started the
    drill, and two devices running the same drill generate identical names, so a shared
    id would let one device's sync take ownership of the other's hazards and leave that
    user's map silently empty.
    """
    base = stable_feed_id(
        item.get("source"), item.get("source_url"), item.get("name"), item.get("observed_at"),
    )
    return f"{base}-{drill_device[:16]}" if drill_device else base


def _rate_limit(request: Request, bucket: str, key: str | None = None) -> None:
    """Consume one unit from a rate-limit bucket, or refuse with 429.

    Charged twice: once against the device, and once against the caller's network
    origin. The device header is minted by the client, so rotating it mints a fresh
    allowance — a per-device limit alone stops an honest user from spamming and stops a
    script from nothing at all. The network bucket is far more generous, so a household
    or a café behind one address is never affected.
    """
    limiter = getattr(request.app.state, "rate_limiter", None)
    if limiter is None:
        return

    source = peer_source(request)
    checks = [(bucket, key or source)]
    if f"{bucket}.peer" in limiter.limits:
        checks.append((f"{bucket}.peer", source))

    for name, identity in checks:
        retry_after = limiter.check(name, identity)
        if retry_after > 0:
            raise HTTPException(
                429,
                {
                    "detail": (
                        "Too many requests from this device. "
                        f"Try again in {int(retry_after) + 1} seconds."
                    ),
                    "retry_after_seconds": int(retry_after) + 1,
                },
                headers={"Retry-After": str(int(retry_after) + 1)},
            )


@api_router.get("/health", tags=["meta"])
def health():
    return {"status": "ok", "timestamp": datetime.now(UTC).isoformat(), "app": "OneBar"}


@api_router.get("/region", response_model=RegionInfoResponse, tags=["meta"])
def region(request: Request):
    return request.app.state.graph_manager.get_summary()


# --- Hazard Zone Endpoints ---------------------------------------------------

@api_router.post("/hazards", response_model=HazardZone, status_code=201, tags=["hazards"])
def add_hazard(body: HazardCreateRequest, request: Request):
    device = require_device(request)
    _rate_limit(request, "hazard_write", device)
    return request.app.state.hazard_store.add(
        coordinates=body.coordinates,
        name=body.name,
        hazard_type=body.hazard_type,
        center=body.center,
        radius_meters=body.radius_meters,
        buffer_meters=body.buffer_meters,
        source=body.source or "manual",
        severity=body.severity or "moderate",
        description=body.description,
        # A hazard posted through the public API is a user report, never an official
        # alert. Only the feed ingestion path may claim "official"; a report the user
        # chose to share becomes "community", which is visible to others but carries
        # no authority and can be denied by them.
        provenance="community" if body.share else "user",
        visibility="shared" if body.share else "private",
        reporter=device,
        ttl_hours=body.ttl_hours,
    )


@api_router.get("/hazards", response_model=HazardListResponse, tags=["hazards"])
def list_hazards(request: Request):
    hazards = request.app.state.hazard_store.list(viewer=viewer_key(request))
    return HazardListResponse(hazards=hazards, total=len(hazards))


@api_router.get("/hazards/{hazard_id}", response_model=HazardZone, tags=["hazards"])
def get_hazard(hazard_id: str, request: Request):
    zone = request.app.state.hazard_store.get(hazard_id, viewer=viewer_key(request))
    if not zone:
        raise HTTPException(404, "Hazard not found.")
    return zone


@api_router.post("/hazards/{hazard_id}/confirm", response_model=HazardVoteResponse, tags=["hazards"])
def confirm_hazard(hazard_id: str, request: Request):
    """Vouch for a shared community report — someone else can see it is still there."""
    return _vote(hazard_id, request, "confirm")


@api_router.post("/hazards/{hazard_id}/deny", response_model=HazardVoteResponse, tags=["hazards"])
def deny_hazard(hazard_id: str, request: Request):
    """Report a shared community hazard as no longer present."""
    return _vote(hazard_id, request, "deny")


def _vote(hazard_id: str, request: Request, kind: str) -> HazardVoteResponse:
    device = require_device(request)
    _rate_limit(request, "hazard_vote", device)
    # The network origin travels with the vote so retiring a report needs agreement
    # from more than one of them.
    zone, retired, message = request.app.state.hazard_store.vote(
        hazard_id, device, kind, source=peer_source(request)
    )
    if zone is None and not retired:
        raise HTTPException(404, message)
    return HazardVoteResponse(hazard=zone, retired=retired, message=message)


@api_router.delete("/hazards/drill", tags=["hazards"])
def clear_drill_hazards(request: Request):
    """
    Retire this device's simulated hazards.

    Scoped to the caller, matching how drills are created: a drill belongs to the device
    that started it, so leaving one must not clear a drill another team is running.
    Operators can clear every drill in the deployment with the admin token.
    """
    reporter = None if is_admin(request) else require_device(request)
    return {"cleared": request.app.state.hazard_store.clear_provenance("drill", reporter=reporter)}


@api_router.delete("/hazards/{hazard_id}", tags=["hazards"])
def delete_hazard(hazard_id: str, request: Request):
    """Delete one hazard. Only its own reporter, or an operator, may do so."""
    outcome = request.app.state.hazard_store.remove(
        hazard_id, requester=viewer_key(request), admin=is_admin(request)
    )
    if outcome == "not_found":
        raise HTTPException(404, "Hazard not found.")
    if outcome == "forbidden":
        raise HTTPException(
            403,
            "This report was not made by this device. Mark it as clear instead of deleting it.",
        )
    return {"removed": True, "hazard_id": hazard_id}


@api_router.delete("/hazards", tags=["hazards"])
def clear_hazards(request: Request):
    """
    Wipe every hazard on the server.

    The stores are process-global, so before this guard any anonymous client could
    erase the hazard map for every other user of the deployment. Ordinary users no
    longer need it — a device deletes its own reports one at a time, and community
    reports are retired by denial or expiry — so it stays an operator action.
    """
    if not os.getenv("ONEBAR_ADMIN_TOKEN"):
        raise HTTPException(
            403,
            "Bulk hazard deletion is disabled. Set ONEBAR_ADMIN_TOKEN to enable it.",
        )
    if not is_admin(request):
        raise HTTPException(403, "Bulk hazard deletion requires an operator token.")
    return {"cleared": request.app.state.hazard_store.clear()}


@api_router.post("/hazards/sync-api", response_model=HazardSyncResponse, tags=["hazards"])
def sync_external_hazards(body: HazardSyncRequest, request: Request):
    """
    Pull live hazard feeds from external emergency APIs (NOAA NWS Alerts, USGS
    Earthquakes, NASA EONET) and synchronise them with the hazard store.

    Official alerts are server-owned: clients trigger a refresh but never author the
    result, and repeat syncs update the same records rather than stacking duplicates.
    """
    device = viewer_key(request)
    _rate_limit(request, "feed_sync", device)

    if body.drill_mode:
        # Simulated hazards are scoped to the device that asked for them. They used to
        # be written into shared state with no expiry, so one client running a drill put
        # four fabricated hazards — at coordinates of its own choosing — onto every
        # other device's map and routing graph, permanently, with no way for those
        # users to tell why their shelters had gone red.
        device = require_device(request)

    gm = request.app.state.graph_manager
    summary = gm.get_summary()
    bounds = summary.get("bounds") if summary else None

    # Center coordinates
    if body.center:
        center_lat, center_lon = body.center.lat, body.center.lon
    elif bounds and bounds.get("min_lat") != 0:
        center_lat = (bounds["min_lat"] + bounds["max_lat"]) / 2
        center_lon = (bounds["min_lon"] + bounds["max_lon"]) / 2
    else:
        center_lat, center_lon = 40.7128, -74.0060

    if body.clear_existing:
        # Clearing wipes shared state including other devices' reports, so it is an
        # operator action even though the sync itself is not.
        if not is_admin(request):
            raise HTTPException(403, "Clearing existing hazards requires an operator token.")
        request.app.state.hazard_store.clear()

    cache_key = (
        round(center_lat, 2), round(center_lon, 2), round(body.radius_km, 1),
        tuple(sorted(body.sources)), body.drill_mode,
    )
    feed_items = active_sources = None
    if not body.clear_existing:
        with _feed_cache_lock:
            cached = _feed_cache.get(cache_key)
        if cached and time.monotonic() - cached[0] < _FEED_CACHE_SECONDS:
            feed_items, active_sources = cached[1], cached[2]

    if feed_items is None:
        feed_items, active_sources = fetch_all_external_hazards(
            center_lat=center_lat,
            center_lon=center_lon,
            bounds=bounds,
            sources=body.sources,
            drill_mode=body.drill_mode,
        )
        with _feed_cache_lock:
            _feed_cache[cache_key] = (time.monotonic(), feed_items, active_sources)
            if len(_feed_cache) > 128:
                _feed_cache.clear()

    created_zones: list[HazardZone] = []
    for item in feed_items:
        zone = request.app.state.hazard_store.add(
            # A stable id derived from the issuing source turns a re-sync into an
            # update. Without it the 90-second background poll re-inserted every
            # standing alert, and one flood watch became dozens of overlapping copies.
            hazard_id=_feed_record_id(item, device if body.drill_mode else None),
            coordinates=item.get("coordinates"),
            name=item.get("name"),
            hazard_type=item.get("hazard_type", "closure"),
            center=item.get("center"),
            radius_meters=item.get("radius_meters"),
            buffer_meters=item.get("buffer_meters", 0.0),
            source=item.get("source"),
            severity=item.get("severity"),
            description=item.get("description"),
            provenance=item.get("provenance", "official"),
            source_url=item.get("source_url"),
            observed_at=item.get("observed_at"),
            expires_at=item.get("expires_at"),
            visibility="private" if body.drill_mode else "shared",
            reporter=device if body.drill_mode else None,
        )
        created_zones.append(zone)

    if not created_zones:
        # The correct, and usually reassuring, answer. Never padded with simulated data.
        message = "No active alerts reported for this area."
    else:
        source_names = ", ".join(s.upper() for s in active_sources)
        message = f"Pulled {len(created_zones)} hazard zone(s) from {source_names}."
        if body.drill_mode:
            message = f"DRILL MODE — {message} Simulated hazards are not real events."

    return HazardSyncResponse(
        fetched_count=len(created_zones),
        sources=active_sources,
        hazards=created_zones,
        message=message,
        drill_mode=body.drill_mode,
    )


# --- Safe Havens Endpoints ---------------------------------------------------

@api_router.get("/safe-havens", response_model=SafeHavenListResponse, tags=["safe_havens"])
def list_safe_havens(request: Request):
    havens = request.app.state.safe_haven_store.list(
        hazard_store=request.app.state.hazard_store,
        graph_manager=request.app.state.graph_manager,
        viewer=viewer_key(request),
    )
    return SafeHavenListResponse(safe_havens=havens, total=len(havens))


@api_router.post("/safe-havens", response_model=SafeHaven, status_code=201, tags=["safe_havens"])
def add_safe_haven(body: SafeHavenCreateRequest, request: Request):
    """Add a shelter. It is visible to, and routable by, the adding device alone.

    Unlike a hazard there is no sharing switch. A hazard someone invents costs other
    people a detour; a shelter someone invents is a destination they are sent to, and no
    stranger can check whether a building is open. Publishing one requires an
    authoritative source, which means the OSM discovery path or a verified feed.
    """
    device = require_device(request)
    _rate_limit(request, "hazard_write", device)
    return request.app.state.safe_haven_store.add(
        name=body.name,
        location=body.location,
        haven_type=body.type,
        address=body.address,
        capacity=body.capacity,
        reporter=device,
    )


@api_router.delete("/safe-havens/{haven_id}", tags=["safe_havens"])
def delete_safe_haven(haven_id: str, request: Request):
    """Delete a shelter this device added. Discovered havens belong to nobody."""
    outcome = request.app.state.safe_haven_store.remove(
        haven_id, requester=viewer_key(request), admin=is_admin(request)
    )
    if outcome == "not_found":
        raise HTTPException(404, "Safe haven not found.")
    if outcome == "forbidden":
        raise HTTPException(403, "This shelter was not added by this device.")
    return {"removed": True, "id": haven_id}


# --- Destination search ------------------------------------------------------

@api_router.get("/geocode", response_model=GeocodeResponse, tags=["search"])
def geocode(
    request: Request,
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(8, ge=1, le=20),
    lat: float | None = Query(None, ge=-90.0, le=90.0),
    lon: float | None = Query(None, ge=-180.0, le=180.0),
):
    """
    Search for a destination.

    Results from the downloaded map come first and are marked as such: they need no
    network and are guaranteed to sit inside routable coverage. Network results are
    appended when a geocoder is reachable, and their absence is reported rather than
    hidden — an unreachable geocoder must never look like "no such place".
    """
    _rate_limit(request, "geocode", viewer_key(request))

    gm = request.app.state.graph_manager
    near = LatLon(lat=lat, lon=lon) if lat is not None and lon is not None else None
    bounds = gm.get_summary().get("bounds")

    results: list[GeocodeResult] = []
    if (coordinate := parse_coordinate(q)) is not None:
        results.append(GeocodeResult(
            name=f"{coordinate.lat:.5f}, {coordinate.lon:.5f}",
            subtitle="Coordinates",
            location=coordinate,
            kind="coordinate",
            source="offline",
            in_coverage=gm.contains(coordinate.lon, coordinate.lat, COVERAGE_TOLERANCE_M),
        ))

    havens = request.app.state.safe_haven_store.list(
        hazard_store=request.app.state.hazard_store,
        graph_manager=gm,
        viewer=viewer_key(request),
    )
    results.extend(search_local(gm, havens, q, limit=limit, near=near))

    message = None
    if len(results) < limit:
        remote = search_remote(q, bounds=bounds, limit=limit - len(results), near=near)
        # A street that is already in the downloaded map does not need a second,
        # differently-worded entry from the geocoder. The offline hit is the better one
        # anyway: it is guaranteed routable.
        seen_names = {r.name.strip().lower() for r in results}
        seen_places = {(round(r.location.lat, 4), round(r.location.lon, 4)) for r in results}
        for hit in remote:
            key = (round(hit.location.lat, 4), round(hit.location.lon, 4))
            if hit.name.strip().lower() in seen_names or key in seen_places:
                continue
            hit.in_coverage = gm.contains(hit.location.lon, hit.location.lat, COVERAGE_TOLERANCE_M)
            seen_names.add(hit.name.strip().lower())
            seen_places.add(key)
            results.append(hit)
        if not remote and not geocoding_enabled():
            message = "Address search is turned off for this deployment; showing map results only."

    if not results:
        message = (
            "Nothing matched in your downloaded map, and the address search did not "
            "return a result. Check the spelling, or drop a pin on the map instead."
        )

    return GeocodeResponse(results=results[:limit], query=q, attribution=ATTRIBUTION, message=message)


@api_router.get("/geocode/reverse", response_model=ReverseGeocodeResponse, tags=["search"])
def reverse_geocode(
    request: Request,
    lat: float = Query(..., ge=-90.0, le=90.0),
    lon: float = Query(..., ge=-180.0, le=180.0),
):
    """Name a dropped pin, preferring the offline road graph over the network."""
    _rate_limit(request, "geocode", viewer_key(request))
    gm = request.app.state.graph_manager
    location = LatLon(lat=lat, lon=lon)
    in_coverage = gm.contains(lon, lat, COVERAGE_TOLERANCE_M)

    if (name := reverse_local(gm, lat, lon)):
        return ReverseGeocodeResponse(
            location=location, name=f"Near {name}", source="offline", in_coverage=in_coverage
        )
    if (name := reverse_remote(lat, lon)):
        return ReverseGeocodeResponse(
            location=location, name=name, source="network", in_coverage=in_coverage
        )
    return ReverseGeocodeResponse(location=location, name=None, source=None, in_coverage=in_coverage)


# --- Routing Endpoints -------------------------------------------------------

@api_router.post("/route", response_model=RouteResponse, tags=["routing"])
def route(body: RouteRequest, request: Request):
    gm = request.app.state.graph_manager
    graph = gm.get_graph()
    spatial_index, linestrings, edge_keys = gm.get_spatial_data()

    _require_real_graph(gm)
    _require_mode(gm, body.mode)
    _require_coverage(gm, body.origin, "starting point")
    _require_coverage(gm, body.destination, "destination")

    orig = gm.nearest_node(body.origin.lon, body.origin.lat, mode=body.mode)
    dest = gm.nearest_node(body.destination.lon, body.destination.lat, mode=body.mode)
    # Scoped to the caller: one device's private report must never remove edges from
    # another device's route.
    blocked = request.app.state.hazard_store.blocked_edges(
        spatial_index, linestrings, edge_keys, viewer=viewer_key(request)
    )

    result = find_route(
        graph, orig, dest, blocked,
        mode=body.mode, allow_fallback=body.allow_penalty_fallback,
        orig_coord=body.origin, dest_coord=body.destination,
        max_speed_mps=gm.max_speed_mps,
    )
    if not result["success"]:
        raise HTTPException(409, result["error"])

    coords = path_to_coords(graph, result["path"], body.origin, body.destination)
    return RouteResponse(
        success=True,
        coordinates=coords,
        polyline=encode_polyline(coords) if body.encode_polyline else None,
        total_travel_time_seconds=result["time"],
        total_distance_meters=result["distance"],
        blocked_edges_avoided=result["blocked"],
        is_fallback=result["is_fallback"],
        warning=result["warning"],
        maneuvers=result.get("maneuvers", []),
    )


@api_router.post("/route/safety", response_model=SafetyRouteResponse, tags=["routing"])
def route_to_safety(body: SafetyRouteRequest, request: Request):
    """
    Automatically construct the fastest route to safety (evaluating all available
    uncompromised safe havens and exits avoiding all dynamic hazard zones).
    """
    gm = request.app.state.graph_manager
    graph = gm.get_graph()
    spatial_index, linestrings, edge_keys = gm.get_spatial_data()
    viewer = viewer_key(request)

    _require_real_graph(gm)
    _require_mode(gm, body.mode)
    _require_coverage(gm, body.origin, "location")

    blocked = request.app.state.hazard_store.blocked_edges(
        spatial_index, linestrings, edge_keys, viewer=viewer
    )
    candidates = request.app.state.safe_haven_store.get_safe_candidates(
        hazard_store=request.app.state.hazard_store,
        target_type=body.target_type,
        graph_manager=gm,
        viewer=viewer,
    )

    result = find_fastest_route_to_safety(
        graph=graph,
        graph_manager=gm,
        orig_coord=body.origin,
        safe_candidates=candidates,
        blocked_edges=blocked,
        mode=body.mode,
        allow_fallback=body.allow_penalty_fallback,
        encode_polyline_flag=body.encode_polyline,
    )

    if not result["success"]:
        raise HTTPException(409, result["error"])

    return SafetyRouteResponse(
        success=True,
        destination_safe_haven=result["destination_safe_haven"],
        coordinates=result["coordinates"],
        polyline=result["polyline"],
        total_travel_time_seconds=result["total_travel_time_seconds"],
        total_distance_meters=result["total_distance_meters"],
        blocked_edges_avoided=result["blocked_edges_avoided"],
        is_fallback=result["is_fallback"],
        warning=result["warning"],
        maneuvers=result.get("maneuvers", []),
        alternatives=result.get("alternatives", []),
    )


# --- Offline region packs ----------------------------------------------------

@api_router.get("/packs/index.json", tags=["packs"])
def pack_index(request: Request):
    """
    Catalogue of downloadable region packs.

    Packs are pre-built artifacts produced by tools/build_pack.py, never generated
    per request. Serving an empty list is valid — it means this deployment has not
    published any coverage yet.
    """
    index_path = os.path.join(_PACK_DIR, "index.json")
    if not os.path.exists(index_path):
        return {"regions": []}
    with open(index_path, encoding="utf-8") as f:
        return json.load(f)


@api_router.get("/packs/{region_id}.obp", tags=["packs"])
def download_pack(region_id: str):
    """Serve one region pack. Cached aggressively — packs are immutable per version."""
    # Region ids come from our own catalogue, but this endpoint is public, so the
    # path is constrained rather than trusted.
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", region_id):
        raise HTTPException(400, "Invalid region id.")

    pack_path = os.path.join(_PACK_DIR, f"{region_id}.obp")
    if not os.path.exists(pack_path):
        raise HTTPException(404, "Region pack not found.")

    return FileResponse(
        pack_path,
        media_type="application/octet-stream",
        filename=f"{region_id}.obp",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
