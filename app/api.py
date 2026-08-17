from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Request

from schemas import (
    HazardCreateRequest,
    HazardListResponse,
    HazardSyncRequest,
    HazardSyncResponse,
    HazardZone,
    RegionInfoResponse,
    RouteRequest,
    RouteResponse,
    SafeHaven,
    SafeHavenCreateRequest,
    SafeHavenListResponse,
    SafetyRouteRequest,
    SafetyRouteResponse,
)
from hazard_feed import fetch_all_external_hazards
from router import encode_polyline, find_fastest_route_to_safety, find_route, path_to_coords

api_router = APIRouter()


@api_router.get("/health", tags=["meta"])
def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat(), "app": "OneBar"}


@api_router.get("/region", response_model=RegionInfoResponse, tags=["meta"])
def region(request: Request):
    return request.app.state.graph_manager.get_summary()


# --- Hazard Zone Endpoints ---------------------------------------------------

@api_router.post("/hazards", response_model=HazardZone, status_code=201, tags=["hazards"])
def add_hazard(body: HazardCreateRequest, request: Request):
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
    )


@api_router.get("/hazards", response_model=HazardListResponse, tags=["hazards"])
def list_hazards(request: Request):
    hazards = request.app.state.hazard_store.list()
    return HazardListResponse(hazards=hazards, total=len(hazards))


@api_router.get("/hazards/{hazard_id}", response_model=HazardZone, tags=["hazards"])
def get_hazard(hazard_id: str, request: Request):
    zone = request.app.state.hazard_store.get(hazard_id)
    if not zone:
        raise HTTPException(404, "Hazard not found.")
    return zone


@api_router.delete("/hazards/{hazard_id}", tags=["hazards"])
def delete_hazard(hazard_id: str, request: Request):
    if not request.app.state.hazard_store.remove(hazard_id):
        raise HTTPException(404, "Hazard not found.")
    return {"removed": True, "hazard_id": hazard_id}


@api_router.delete("/hazards", tags=["hazards"])
def clear_hazards(request: Request):
    return {"cleared": request.app.state.hazard_store.clear()}


@api_router.post("/hazards/sync-api", response_model=HazardSyncResponse, tags=["hazards"])
def sync_external_hazards(body: HazardSyncRequest, request: Request):
    """
    Pull live hazard feeds from external emergency APIs (NOAA NWS Alerts, USGS Earthquakes,
    NASA EONET, Crisis Incident Feeds) and synchronize them directly with the hazard store.
    """
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
        request.app.state.hazard_store.clear()

    feed_items, active_sources = fetch_all_external_hazards(
        center_lat=center_lat,
        center_lon=center_lon,
        bounds=bounds,
        sources=body.sources,
        include_simulation_if_empty=True,
    )

    created_zones: list[HazardZone] = []
    for item in feed_items:
        zone = request.app.state.hazard_store.add(
            coordinates=item.get("coordinates"),
            name=item.get("name"),
            hazard_type=item.get("hazard_type", "closure"),
            center=item.get("center"),
            radius_meters=item.get("radius_meters"),
            buffer_meters=item.get("buffer_meters", 0.0),
            source=item.get("source"),
            severity=item.get("severity"),
            description=item.get("description"),
        )
        created_zones.append(zone)

    source_names = ", ".join(s.upper() for s in active_sources) if active_sources else "APIs"
    return HazardSyncResponse(
        fetched_count=len(created_zones),
        sources=active_sources,
        hazards=created_zones,
        message=f"Successfully pulled {len(created_zones)} hazard zone(s) from {source_names}.",
    )


# --- Safe Havens Endpoints ---------------------------------------------------

@api_router.get("/safe-havens", response_model=SafeHavenListResponse, tags=["safe_havens"])
def list_safe_havens(request: Request):
    havens = request.app.state.safe_haven_store.list(hazard_store=request.app.state.hazard_store)
    return SafeHavenListResponse(safe_havens=havens, total=len(havens))


@api_router.post("/safe-havens", response_model=SafeHaven, status_code=201, tags=["safe_havens"])
def add_safe_haven(body: SafeHavenCreateRequest, request: Request):
    return request.app.state.safe_haven_store.add(
        name=body.name,
        location=body.location,
        haven_type=body.type,
        address=body.address,
        capacity=body.capacity,
    )


# --- Routing Endpoints -------------------------------------------------------

@api_router.post("/route", response_model=RouteResponse, tags=["routing"])
def route(body: RouteRequest, request: Request):
    gm = request.app.state.graph_manager
    graph = gm.get_graph()
    spatial_index, linestrings, edge_keys = gm.get_spatial_data()

    orig = gm.nearest_node(body.origin.lon, body.origin.lat)
    dest = gm.nearest_node(body.destination.lon, body.destination.lat)
    blocked = request.app.state.hazard_store.blocked_edges(spatial_index, linestrings, edge_keys)

    result = find_route(
        graph, orig, dest, blocked,
        mode=body.mode, allow_fallback=body.allow_penalty_fallback,
        orig_coord=body.origin, dest_coord=body.destination,
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

    blocked = request.app.state.hazard_store.blocked_edges(spatial_index, linestrings, edge_keys)
    candidates = request.app.state.safe_haven_store.get_safe_candidates(
        hazard_store=request.app.state.hazard_store,
        target_type=body.target_type,
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
