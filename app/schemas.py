from datetime import datetime, timezone
from typing import Literal
from pydantic import BaseModel, Field, model_validator

type EdgeKey = tuple[int, int, int]
type EdgeKeys = list[EdgeKey]


class LatLon(BaseModel):
    lat: float = Field(..., ge=-90.0, le=90.0)
    lon: float = Field(..., ge=-180.0, le=180.0)


class Maneuver(BaseModel):
    type: Literal[
        "depart",
        "straight",
        "slight_left",
        "turn_left",
        "sharp_left",
        "slight_right",
        "turn_right",
        "sharp_right",
        "u_turn",
        "arrive",
    ] = "straight"
    instruction: str
    street_name: str | None = None
    distance_meters: float = 0.0
    travel_time_seconds: float = 0.0
    location: LatLon


class HazardCreateRequest(BaseModel):
    coordinates: list[LatLon] | None = None
    center: LatLon | None = None
    radius_meters: float | None = Field(None, ge=5.0, le=50000.0)
    buffer_meters: float = Field(0.0, ge=0.0, le=1000.0)
    name: str | None = None
    hazard_type: str = "closure"
    source: str | None = None
    severity: str | None = None
    description: str | None = None

    @model_validator(mode="after")
    def check_coords_or_radial(self) -> "HazardCreateRequest":
        if self.coordinates and len(self.coordinates) >= 3:
            return self
        if self.center and self.radius_meters and self.radius_meters > 0:
            return self
        raise ValueError("Must provide either 'coordinates' (min 3 points) or 'center' with 'radius_meters'.")


class HazardZone(BaseModel):
    hazard_id: str
    name: str | None = None
    hazard_type: str = "closure"
    coordinates: list[LatLon]
    center: LatLon | None = None
    radius_meters: float | None = None
    buffer_meters: float = 0.0
    source: str | None = None
    severity: str | None = None
    description: str | None = None
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class HazardListResponse(BaseModel):
    hazards: list[HazardZone]
    total: int


class HazardSyncRequest(BaseModel):
    center: LatLon | None = None
    radius_km: float = Field(15.0, ge=1.0, le=500.0)
    sources: list[str] = Field(default_factory=lambda: ["nws", "usgs", "eonet", "simulation"])
    clear_existing: bool = False


class HazardSyncResponse(BaseModel):
    fetched_count: int
    sources: list[str]
    hazards: list[HazardZone]
    message: str


class SafeHaven(BaseModel):
    id: str
    name: str
    type: Literal["shelter", "hospital", "assembly_point", "perimeter_exit"] = "shelter"
    location: LatLon
    address: str | None = None
    capacity: int | None = None
    is_compromised: bool = False
    compromised_reason: str | None = None


class SafeHavenCreateRequest(BaseModel):
    name: str
    location: LatLon
    type: Literal["shelter", "hospital", "assembly_point", "perimeter_exit"] = "shelter"
    address: str | None = None
    capacity: int | None = None


class SafeHavenListResponse(BaseModel):
    safe_havens: list[SafeHaven]
    total: int


class RouteRequest(BaseModel):
    origin: LatLon
    destination: LatLon
    mode: Literal["drive", "walk"] = "drive"
    encode_polyline: bool = False
    allow_penalty_fallback: bool = True


class RouteResponse(BaseModel):
    success: bool
    coordinates: list[LatLon]
    polyline: str | None = None
    total_travel_time_seconds: float
    total_distance_meters: float
    blocked_edges_avoided: int
    is_fallback: bool = False
    warning: str | None = None
    maneuvers: list[Maneuver] = Field(default_factory=list)


class AlternativeHaven(BaseModel):
    id: str
    name: str
    type: str
    location: LatLon
    travel_time_seconds: float
    distance_meters: float


class SafetyRouteRequest(BaseModel):
    origin: LatLon
    mode: Literal["drive", "walk"] = "drive"
    target_type: Literal["all", "shelter", "hospital", "assembly_point", "perimeter_exit"] = "all"
    encode_polyline: bool = False
    allow_penalty_fallback: bool = True


class SafetyRouteResponse(BaseModel):
    success: bool
    destination_safe_haven: SafeHaven
    coordinates: list[LatLon]
    polyline: str | None = None
    total_travel_time_seconds: float
    total_distance_meters: float
    blocked_edges_avoided: int
    is_fallback: bool = False
    warning: str | None = None
    maneuvers: list[Maneuver] = Field(default_factory=list)
    alternatives: list[AlternativeHaven] = Field(default_factory=list)


class RegionInfoResponse(BaseModel):
    place_name: str | None = None
    bounds: dict[str, float]
    node_count: int
    edge_count: int
    status: str = "ready"