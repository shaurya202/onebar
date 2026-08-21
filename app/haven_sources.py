"""
Real safe-haven discovery from OpenStreetMap.

Every haven OneBar shows a user must correspond to something that actually exists and
can be checked. This module is the only place havens are created from external data;
it maps OSM features to `SafeHaven` records carrying the OSM id they came from, so any
claim the app makes about a shelter is traceable back to a source.
"""

import logging
from typing import Any

import osmnx as ox

from schemas import LatLon, SafeHaven

logger = logging.getLogger("onebar.haven_sources")

# OSM tags that correspond to places people are directed to in an emergency.
# `emergency=assembly_point` is the most literal match; hospitals and fire stations
# are staffed; schools and community centres are the buildings municipalities
# actually open as shelters.
# `amenity=clinic` was excluded deliberately: it matches single-practitioner offices
# — psychiatry practices, infusion clinics — which are neither staffed for an
# emergency nor able to shelter anyone. Sending someone there during an evacuation
# would be worse than showing nothing.
HAVEN_TAGS: dict[str, Any] = {
    "amenity": ["hospital", "shelter", "community_centre", "school", "fire_station"],
    "emergency": ["assembly_point", "shelter"],
}

# How an OSM feature maps onto OneBar's haven types.
_TYPE_BY_TAG = {
    "hospital": "hospital",
    "shelter": "shelter",
    "community_centre": "shelter",
    "school": "shelter",
    "fire_station": "shelter",
    "assembly_point": "assembly_point",
}

MAX_HAVENS = 250


def _haven_type(row: dict[str, Any]) -> str:
    for key in ("emergency", "amenity"):
        value = row.get(key)
        if isinstance(value, str) and value in _TYPE_BY_TAG:
            return _TYPE_BY_TAG[value]
    return "shelter"


def _address(row: dict[str, Any]) -> str | None:
    parts = [
        row.get("addr:housenumber"),
        row.get("addr:street"),
        row.get("addr:city"),
        row.get("addr:postcode"),
    ]
    joined = " ".join(str(p) for p in parts if p and str(p) != "nan").strip()
    return joined or None


def fetch_osm_safe_havens(bounds: dict[str, float], tags: dict[str, Any] | None = None) -> list[SafeHaven]:
    """
    Query OSM for emergency-relevant POIs inside `bounds`.

    Returns an empty list on any failure — callers must treat that as "unknown", never
    as "none exist", and must not substitute placeholder data.
    """
    bbox = (
        float(bounds["min_lon"]), float(bounds["min_lat"]),
        float(bounds["max_lon"]), float(bounds["max_lat"]),
    )
    try:
        gdf = ox.features_from_bbox(bbox, tags or HAVEN_TAGS)
    except Exception as e:
        logger.info("OSM haven query failed for %s: %s", bbox, e)
        return []

    if gdf is None or gdf.empty:
        return []

    havens: list[SafeHaven] = []
    for idx, row in gdf.iterrows():
        try:
            record = {k: v for k, v in row.items() if v is not None}
            name = record.get("name")
            if not name or str(name) == "nan":
                # An unnamed building is not something to send a person to by name.
                continue

            geom = row.geometry
            if geom is None or geom.is_empty:
                continue
            point = geom if geom.geom_type == "Point" else geom.centroid

            osm_type, osm_id = (idx if isinstance(idx, tuple) and len(idx) == 2 else ("node", idx))
            osm_ref = f"{osm_type}/{osm_id}"

            havens.append(SafeHaven(
                id=f"haven-osm-{osm_type}-{osm_id}",
                name=str(name),
                type=_haven_type(record),
                location=LatLon(lat=round(float(point.y), 6), lon=round(float(point.x), 6)),
                address=_address(record),
                capacity=None,
                is_compromised=False,
                provenance="official",
                source_url=f"https://www.openstreetmap.org/{osm_ref}",
                osm_id=osm_ref,
                # OSM says the building exists; it does not say the municipality has
                # opened it as a shelter. That requires an authoritative feed.
                verified=False,
            ))
        except Exception as e:
            logger.debug("Skipping unmappable OSM feature %s: %s", idx, e)

    # Prefer staffed, purpose-built havens when trimming to the cap.
    priority = {"hospital": 0, "assembly_point": 1, "shelter": 2, "perimeter_exit": 3}
    havens.sort(key=lambda h: (priority.get(h.type, 9), h.name))
    return havens[:MAX_HAVENS]
