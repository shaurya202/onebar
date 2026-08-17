import json
import os
from datetime import datetime, timezone
from uuid import uuid4

from shapely.geometry import LineString, Polygon
from shapely.strtree import STRtree

from schemas import EdgeKey, EdgeKeys, HazardZone, LatLon
from spatial import (
    blocked_edges_for_polygon,
    buffer_polygon,
    create_circle_polygon,
    from_shapely_polygon,
    to_shapely_polygon,
)


class HazardStore:
    def __init__(self, persistence_file: str | None = "hazards_store.json") -> None:
        self.persistence_file = persistence_file
        # Each entry: {"zone": HazardZone, "polygon": Polygon}
        self._hazards: dict[str, dict] = {}
        if self.persistence_file:
            self._load()

    def _load(self) -> None:
        if not self.persistence_file or not os.path.exists(self.persistence_file):
            return
        try:
            with open(self.persistence_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            for item in data:
                coords = [LatLon(**c) for c in item["coordinates"]]
                center = LatLon(**item["center"]) if item.get("center") else None
                radius = item.get("radius_meters")
                buf = float(item.get("buffer_meters", 0.0))

                zone = HazardZone(
                    hazard_id=item["hazard_id"],
                    name=item.get("name"),
                    hazard_type=item.get("hazard_type", "closure"),
                    coordinates=coords,
                    center=center,
                    radius_meters=radius,
                    buffer_meters=buf,
                    source=item.get("source"),
                    severity=item.get("severity"),
                    description=item.get("description"),
                    created_at=item.get("created_at", datetime.now(timezone.utc).isoformat()),
                )

                if center and radius:
                    raw_poly = create_circle_polygon(center.lat, center.lon, radius)
                else:
                    raw_poly = to_shapely_polygon(coords)

                eff_poly = buffer_polygon(raw_poly, buf) if buf > 0 else raw_poly
                self._hazards[zone.hazard_id] = {"zone": zone, "polygon": eff_poly}
        except Exception as e:
            print(f"Warning: Failed to load hazards from {self.persistence_file}: {e}")

    def _save(self) -> None:
        if not self.persistence_file:
            return
        try:
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
                    "created_at": item["zone"].created_at,
                }
                for item in self._hazards.values()
            ]
            temp_file = f"{self.persistence_file}.tmp"
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            os.replace(temp_file, self.persistence_file)
        except Exception as e:
            print(f"Warning: Failed to save hazards to {self.persistence_file}: {e}")

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
    ) -> HazardZone:
        hid = str(uuid4())

        if center and radius_meters:
            raw_poly = create_circle_polygon(center.lat, center.lon, radius_meters)
            final_coords = from_shapely_polygon(raw_poly)
        elif coordinates:
            raw_poly = to_shapely_polygon(coordinates)
            final_coords = coordinates
        else:
            raise ValueError("Must provide either coordinates or center with radius_meters.")

        eff_poly = buffer_polygon(raw_poly, buffer_meters) if buffer_meters > 0 else raw_poly

        zone = HazardZone(
            hazard_id=hid,
            name=name,
            hazard_type=hazard_type,
            coordinates=final_coords,
            center=center,
            radius_meters=radius_meters,
            buffer_meters=buffer_meters,
            source=source,
            severity=severity,
            description=description,
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        self._hazards[hid] = {"zone": zone, "polygon": eff_poly}
        self._save()
        return zone

    def remove(self, hazard_id: str) -> bool:
        if hazard_id in self._hazards:
            del self._hazards[hazard_id]
            self._save()
            return True
        return False

    def get(self, hazard_id: str) -> HazardZone | None:
        item = self._hazards.get(hazard_id)
        return item["zone"] if item else None

    def list(self) -> list[HazardZone]:
        return [item["zone"] for item in self._hazards.values()]

    def clear(self) -> int:
        count = len(self._hazards)
        self._hazards.clear()
        self._save()
        return count

    def blocked_edges(
        self,
        spatial_index: STRtree | None,
        linestrings: list[LineString],
        edge_keys: EdgeKeys,
    ) -> set[EdgeKey]:
        if spatial_index is None or not linestrings:
            return set()
        result: set[EdgeKey] = set()
        for item in self._hazards.values():
            result |= blocked_edges_for_polygon(item["polygon"], spatial_index, linestrings, edge_keys)
        return result
