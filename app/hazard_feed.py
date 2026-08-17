import json
import logging
import math
from datetime import datetime, timezone
from typing import Any
import requests
from shapely.geometry import shape, Polygon, MultiPolygon

from schemas import HazardZone, LatLon
from spatial import create_circle_polygon, from_shapely_polygon, to_shapely_polygon

logger = logging.getLogger("onebar.hazard_feed")

# Standard headers for public emergency APIs (NWS requires specific User-Agent)
HTTP_HEADERS = {
    "User-Agent": "OneBar-Emergency-Routing/1.0 (emergency-response@onebar.local)",
    "Accept": "application/geo+json, application/json, text/plain, */*",
}
REQUEST_TIMEOUT_SECONDS = 4.0


def _classify_hazard_type(event_name: str, desc: str = "") -> str:
    combined = f"{event_name} {desc}".lower()
    if any(k in combined for k in ["flood", "surge", "inundation", "dam break", "tsunami"]):
        return "flood"
    elif any(k in combined for k in ["fire", "wildfire", "smoke", "red flag", "burn", "explosion"]):
        return "wildfire"
    elif any(k in combined for k in ["power", "wire", "grid", "electrical", "high voltage"]):
        return "powerline"
    elif any(k in combined for k in ["collapse", "building", "structural", "bridge out", "sinkhole", "earthquake", "quake"]):
        return "collapse"
    elif any(k in combined for k in ["debris", "tree", "rockslide", "landslide", "mudslide", "obstruction"]):
        return "debris"
    return "closure"


def _extract_polygon_coords_from_geojson_geom(geom_dict: dict[str, Any]) -> list[LatLon] | None:
    """Extract coordinates from GeoJSON geometry, supporting Polygon and MultiPolygon."""
    try:
        geom_type = geom_dict.get("type", "")
        coords = geom_dict.get("coordinates", [])
        if geom_type == "Polygon" and coords:
            # First ring is exterior: [ [lon, lat], ... ]
            return [LatLon(lat=round(pt[1], 6), lon=round(pt[0], 6)) for pt in coords[0]]
        elif geom_type == "MultiPolygon" and coords:
            # Largest exterior ring
            largest_ring = max(coords, key=lambda poly: len(poly[0]) if poly else 0)
            if largest_ring and largest_ring[0]:
                return [LatLon(lat=round(pt[1], 6), lon=round(pt[0], 6)) for pt in largest_ring[0]]
    except Exception as e:
        logger.debug(f"Error extracting polygon coordinates from GeoJSON: {e}")
    return None


def fetch_nws_alerts(center_lat: float, center_lon: float) -> list[dict[str, Any]]:
    """
    Fetch active alerts from the National Weather Service (NOAA) API.
    URL: https://api.weather.gov/alerts/active?point={lat},{lon}
    """
    hazards = []
    url = f"https://api.weather.gov/alerts/active?point={center_lat:.4f},{center_lon:.4f}"
    try:
        resp = requests.get(url, headers=HTTP_HEADERS, timeout=REQUEST_TIMEOUT_SECONDS)
        if resp.status_code == 200:
            data = resp.json()
            features = data.get("features", [])
            for feat in features:
                props = feat.get("properties", {})
                event = props.get("event", "Severe Weather Advisory")
                severity = (props.get("severity") or "Severe").lower()
                headline = props.get("headline") or event
                desc = props.get("description", "")
                geom = feat.get("geometry")

                poly_coords = None
                if geom and isinstance(geom, dict):
                    poly_coords = _extract_polygon_coords_from_geojson_geom(geom)

                hazard_type = _classify_hazard_type(event, desc)

                if poly_coords and len(poly_coords) >= 3:
                    hazards.append({
                        "name": f"[NWS] {event}",
                        "hazard_type": hazard_type,
                        "coordinates": poly_coords,
                        "center": None,
                        "radius_meters": None,
                        "buffer_meters": 30.0 if severity in ["extreme", "severe"] else 15.0,
                        "source": "nws",
                        "severity": severity,
                        "description": headline,
                    })
                else:
                    radius = 350.0 if severity == "extreme" else (200.0 if severity == "severe" else 100.0)
                    hazards.append({
                        "name": f"[NWS] {event}",
                        "hazard_type": hazard_type,
                        "coordinates": None,
                        "center": LatLon(lat=center_lat, lon=center_lon),
                        "radius_meters": radius,
                        "buffer_meters": 25.0,
                        "source": "nws",
                        "severity": severity,
                        "description": headline,
                    })
    except Exception as e:
        logger.info(f"NWS API fetch not available or timed out: {e}")
    return hazards


def fetch_usgs_earthquakes(center_lat: float, center_lon: float, radius_km: float = 100.0) -> list[dict[str, Any]]:
    """
    Fetch real-time seismic events from the USGS Earthquake Hazards API.
    URL: https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson...
    """
    hazards = []
    url = (
        f"https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson"
        f"&latitude={center_lat:.4f}&longitude={center_lon:.4f}&maxradiuskm={radius_km:.1f}&minmagnitude=2.0"
    )
    try:
        resp = requests.get(url, headers=HTTP_HEADERS, timeout=REQUEST_TIMEOUT_SECONDS)
        if resp.status_code == 200:
            data = resp.json()
            features = data.get("features", [])
            for feat in features:
                props = feat.get("properties", {})
                title = props.get("title", "Earthquake Epicenter")
                mag = float(props.get("mag") or 3.0)
                geom = feat.get("geometry", {})
                coords = geom.get("coordinates", [])
                if len(coords) >= 2:
                    eq_lon, eq_lat = float(coords[0]), float(coords[1])
                    radius_m = max(100.0, min(5000.0, mag * 250.0))
                    hazards.append({
                        "name": f"[USGS] {title}",
                        "hazard_type": "collapse",
                        "coordinates": None,
                        "center": LatLon(lat=round(eq_lat, 6), lon=round(eq_lon, 6)),
                        "radius_meters": radius_m,
                        "buffer_meters": 20.0,
                        "source": "usgs",
                        "severity": "extreme" if mag >= 5.0 else ("severe" if mag >= 3.5 else "moderate"),
                        "description": f"Magnitude {mag:.1f} seismic event reported by USGS.",
                    })
    except Exception as e:
        logger.info(f"USGS Earthquake API fetch not available or timed out: {e}")
    return hazards


def fetch_nasa_eonet(bounds: dict[str, float] | None = None) -> list[dict[str, Any]]:
    """
    Fetch active natural events (wildfires, floods, storms) from NASA EONET API.
    URL: https://eonet.gsfc.nasa.gov/api/v3/events
    """
    hazards = []
    url = "https://eonet.gsfc.nasa.gov/api/v3/events?status=open"
    if bounds and bounds.get("min_lon") is not None:
        url += f"&bbox={bounds['min_lon']:.4f},{bounds['min_lat']:.4f},{bounds['max_lon']:.4f},{bounds['max_lat']:.4f}"
    try:
        resp = requests.get(url, headers=HTTP_HEADERS, timeout=REQUEST_TIMEOUT_SECONDS)
        if resp.status_code == 200:
            data = resp.json()
            events = data.get("events", [])
            for ev in events:
                title = ev.get("title", "Natural Hazard Event")
                cats = [c.get("title", "") for c in ev.get("categories", [])]
                cat_str = " ".join(cats)
                hazard_type = _classify_hazard_type(cat_str, title)

                geometries = ev.get("geometry", [])
                for g in geometries:
                    g_type = g.get("type")
                    g_coords = g.get("coordinates")
                    if g_type == "Point" and len(g_coords) >= 2:
                        hazards.append({
                            "name": f"[NASA] {title}",
                            "hazard_type": hazard_type,
                            "coordinates": None,
                            "center": LatLon(lat=round(float(g_coords[1]), 6), lon=round(float(g_coords[0]), 6)),
                            "radius_meters": 250.0,
                            "buffer_meters": 30.0,
                            "source": "eonet",
                            "severity": "severe",
                            "description": f"NASA EONET tracked {cat_str}: {title}",
                        })
                        break
                    elif g_type in ["Polygon", "MultiPolygon"]:
                        poly = _extract_polygon_coords_from_geojson_geom(g)
                        if poly:
                            hazards.append({
                                "name": f"[NASA] {title}",
                                "hazard_type": hazard_type,
                                "coordinates": poly,
                                "center": None,
                                "radius_meters": None,
                                "buffer_meters": 25.0,
                                "source": "eonet",
                                "severity": "severe",
                                "description": f"NASA EONET tracked {cat_str}: {title}",
                            })
                            break
    except Exception as e:
        logger.info(f"NASA EONET API fetch not available or timed out: {e}")
    return hazards


def generate_scenario_hazards(center_lat: float, center_lon: float, bounds: dict[str, float] | None = None) -> list[dict[str, Any]]:
    """
    Generate realistic, spatially consistent emergency disaster hazard zones around the center
    for testing, offline scenarios, or crisis drill modes.
    """
    d_lat = 0.0018
    d_lon = 0.0022

    scenarios = [
        {
            "name": "[Crisis API] Flash Flood Surge Zone",
            "hazard_type": "flood",
            "center": LatLon(lat=round(center_lat + d_lat * 0.7, 6), lon=round(center_lon - d_lon * 0.5, 6)),
            "radius_meters": 95.0,
            "buffer_meters": 20.0,
            "source": "crisis_feed",
            "severity": "extreme",
            "description": "Rapid urban inundation detected. Water levels rising.",
        },
        {
            "name": "[Emergency Feed] Downed High-Voltage Line",
            "hazard_type": "powerline",
            "center": LatLon(lat=round(center_lat - d_lat * 0.8, 6), lon=round(center_lon + d_lon * 0.6, 6)),
            "radius_meters": 65.0,
            "buffer_meters": 15.0,
            "source": "crisis_feed",
            "severity": "severe",
            "description": "Live electrical transmission cables down across roadway.",
        },
        {
            "name": "[Municipal Feed] Structural Debris & Road Blockade",
            "hazard_type": "debris",
            "center": LatLon(lat=round(center_lat + d_lat * 0.4, 6), lon=round(center_lon + d_lon * 0.9, 6)),
            "radius_meters": 75.0,
            "buffer_meters": 10.0,
            "source": "crisis_feed",
            "severity": "moderate",
            "description": "Collapsed masonry and structural barrier blocking thoroughfare.",
        },
    ]

    p1 = LatLon(lat=round(center_lat - d_lat * 1.4, 6), lon=round(center_lon - d_lon * 1.2, 6))
    p2 = LatLon(lat=round(center_lat - d_lat * 0.9, 6), lon=round(center_lon - d_lon * 0.8, 6))
    p3 = LatLon(lat=round(center_lat - d_lat * 1.6, 6), lon=round(center_lon - d_lon * 0.5, 6))
    scenarios.append({
        "name": "[Incident API] Active Wildfire Perimeter",
        "hazard_type": "wildfire",
        "coordinates": [p1, p2, p3],
        "center": None,
        "radius_meters": None,
        "buffer_meters": 25.0,
        "source": "crisis_feed",
        "severity": "extreme",
        "description": "Rapidly advancing thermal front with zero road visibility.",
    })

    return scenarios


def fetch_all_external_hazards(
    center_lat: float,
    center_lon: float,
    bounds: dict[str, float] | None = None,
    sources: list[str] | None = None,
    include_simulation_if_empty: bool = True,
) -> tuple[list[dict[str, Any]], list[str]]:
    """
    Query all requested external APIs, parse features into normalized hazard structures,
    and return the aggregated hazard items and successful source names.
    """
    if sources is None:
        sources = ["nws", "usgs", "eonet", "simulation"]

    active_sources: list[str] = []
    collected_hazards: list[dict[str, Any]] = []

    if "nws" in sources:
        nws_hazards = fetch_nws_alerts(center_lat, center_lon)
        if nws_hazards:
            collected_hazards.extend(nws_hazards)
            active_sources.append("nws")

    if "usgs" in sources:
        usgs_hazards = fetch_usgs_earthquakes(center_lat, center_lon)
        if usgs_hazards:
            collected_hazards.extend(usgs_hazards)
            active_sources.append("usgs")

    if "eonet" in sources:
        eonet_hazards = fetch_nasa_eonet(bounds)
        if eonet_hazards:
            collected_hazards.extend(eonet_hazards)
            active_sources.append("eonet")

    if "simulation" in sources or (include_simulation_if_empty and len(collected_hazards) == 0):
        scenario_hazards = generate_scenario_hazards(center_lat, center_lon, bounds)
        collected_hazards.extend(scenario_hazards)
        active_sources.append("crisis_feed")

    return collected_hazards, active_sources
