from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

type EdgeKey = tuple[int, int, int]
type EdgeKeys = list[EdgeKey]

# Where a hazard or safe haven came from. This is a safety-critical field: it is the
# only thing distinguishing a live National Weather Service alert from a drill fixture,
# so it is required on every record and never inferred.
#   official  — issued by an authority (NWS/USGS/EONET) or mapped in OpenStreetMap
#   community — reported by another user, unverified
#   user      — drawn by this device's own user
#   drill     — simulated. Must never be presented as real.
type Provenance = Literal["official", "community", "user", "drill"]


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


# A hazard removes edges from the routing graph, so its size is a safety limit, not a
# performance one: one polygon covering a whole city denies evacuation routing to
# everybody in it. These bounds are generous for anything a person can actually observe
# — a 5 km ring is far larger than a flooded junction or a collapsed building — and are
# enforced on the ring as well as the radius, which was previously unbounded.
MAX_HAZARD_VERTICES = 512
MAX_HAZARD_EXTENT_DEG = 0.05          # ~5.5 km of latitude


class HazardCreateRequest(BaseModel):
    coordinates: list[LatLon] | None = Field(None, max_length=MAX_HAZARD_VERTICES)
    center: LatLon | None = None
    radius_meters: float | None = Field(None, ge=5.0, le=5000.0)
    buffer_meters: float = Field(0.0, ge=0.0, le=1000.0)
    # Length caps, because shared reports are rendered on other people's devices and
    # stored on a server anyone can write to. A label is a label, not a payload.
    name: str | None = Field(None, max_length=120)
    hazard_type: str = Field("closure", max_length=40)
    source: str | None = Field(None, max_length=60)
    severity: str | None = Field(None, max_length=40)
    description: str | None = Field(None, max_length=500)
    # A report stays on the reporting device unless it is explicitly shared. Pushing
    # every drawn polygon into a map other people route against, with no way to
    # correct it, is not a feature — it is an unmoderated broadcast channel.
    share: bool = False
    # How long the report should stand before it expires, in hours. Emergency
    # conditions change; a road reported blocked yesterday is not evidence today.
    ttl_hours: float | None = Field(None, gt=0.0, le=168.0)

    @model_validator(mode="after")
    def check_coords_or_radial(self) -> "HazardCreateRequest":
        if self.coordinates and len(self.coordinates) >= 3:
            lats = [c.lat for c in self.coordinates]
            lons = [c.lon for c in self.coordinates]
            if (max(lats) - min(lats) > MAX_HAZARD_EXTENT_DEG
                    or max(lons) - min(lons) > MAX_HAZARD_EXTENT_DEG):
                raise ValueError(
                    "That area is too large to report as a single hazard. A report this "
                    "size would block routing across the whole region for everyone."
                )
            return self
        if self.center and self.radius_meters and self.radius_meters > 0:
            return self
        raise ValueError("Must provide either 'coordinates' (min 3 points) or 'center' with 'radius_meters'.")


class HazardZone(BaseModel):
    hazard_id: str
    name: str | None = None
    hazard_type: str = "closure"
    coordinates: list[LatLon]
    # The buffered ring actually used for blocking decisions. The server has always
    # computed this internally; exposing it lets the offline client block exactly the
    # same edges instead of reimplementing Polygon.buffer() and drifting.
    effective_coordinates: list[LatLon] = Field(default_factory=list)
    center: LatLon | None = None
    radius_meters: float | None = None
    buffer_meters: float = 0.0
    source: str | None = None
    severity: str | None = None
    description: str | None = None
    provenance: Provenance = "user"
    source_url: str | None = None
    observed_at: str | None = None
    created_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    # "private" reports are visible only to the device that made them and are never
    # applied to anybody else's routing. "shared" reports are visible to everyone in
    # the region and are subject to confirmation, denial and expiry.
    visibility: Literal["private", "shared"] = "shared"
    confirmations: int = 0
    denials: int = 0
    # When this report stops being applied to routing. Null means it does not expire
    # on a timer — used for official alerts, which are retired by their own feed.
    expires_at: str | None = None
    # Computed per request from the caller's device header; never stored. The reporter
    # identifier itself is never returned to any client, including its own reporter.
    mine: bool = False
    my_vote: Literal["confirm", "deny"] | None = None


class HazardListResponse(BaseModel):
    hazards: list[HazardZone]
    total: int


class HazardVoteResponse(BaseModel):
    hazard: HazardZone | None
    retired: bool = False
    message: str


class HazardSyncRequest(BaseModel):
    center: LatLon | None = None
    radius_km: float = Field(15.0, ge=1.0, le=500.0)
    sources: list[str] = Field(default_factory=lambda: ["nws", "usgs", "eonet"])
    clear_existing: bool = False
    # Simulated hazards are opt-in and never a fallback for an empty feed. An empty
    # result is the truthful answer and must be reported as such.
    drill_mode: bool = False


class HazardSyncResponse(BaseModel):
    fetched_count: int
    sources: list[str]
    hazards: list[HazardZone]
    message: str
    drill_mode: bool = False


class SafeHaven(BaseModel):
    id: str
    name: str
    type: Literal["shelter", "hospital", "assembly_point", "perimeter_exit"] = "shelter"
    location: LatLon
    address: str | None = None
    capacity: int | None = None
    is_compromised: bool = False
    compromised_reason: str | None = None
    provenance: Provenance = "official"
    source_url: str | None = None
    osm_id: str | None = None
    # True only when cross-checked against an authoritative shelter list (e.g. FEMA
    # NSS / Red Cross). An OSM-derived haven is real but not operationally confirmed.
    verified: bool = False
    # False when the haven lies outside the loaded road graph, so no honest route to
    # it can be computed. Such havens are listed but never offered as a destination.
    reachable: bool = True
    # A shelter someone added on their own phone is visible to that phone alone. A
    # fabricated hazard reroutes people; a fabricated shelter is somewhere they are sent
    # *to*, so this is deliberately stricter than the hazard model: there is no sharing
    # switch, because there is no way for a stranger to verify a building is open.
    visibility: Literal["private", "shared"] = "shared"
    mine: bool = False


class SafeHavenCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    location: LatLon
    type: Literal["shelter", "hospital", "assembly_point", "perimeter_exit"] = "shelter"
    address: str | None = Field(None, max_length=200)
    capacity: int | None = Field(None, ge=0, le=1_000_000)


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
    # True when no real road network could be loaded and a placeholder grid is standing
    # in. Routing is refused in that state: directions along invented streets are the
    # same class of fabrication as an invented shelter.
    synthetic: bool = False
    # Per-mode routability. A graph of nothing but footways cannot honestly serve a
    # drive request, and the client must be able to disable that mode rather than
    # silently routing a car down a staircase.
    drivable_edge_count: int = 0
    walkable_edge_count: int = 0
    supported_modes: list[str] = Field(default_factory=list)


class GeocodeResult(BaseModel):
    name: str
    subtitle: str | None = None
    location: LatLon
    kind: Literal["street", "shelter", "address", "coordinate"] = "address"
    # Which layer produced this hit. Surfaced in the UI because the two have very
    # different guarantees: an offline hit is inside routable coverage and works with
    # no signal, a network hit is neither.
    source: Literal["offline", "network"] = "offline"
    in_coverage: bool = False
    distance_meters: float | None = None


class GeocodeResponse(BaseModel):
    results: list[GeocodeResult] = Field(default_factory=list)
    query: str
    attribution: str | None = None
    # Populated when there is something the user needs to know about *why* the list
    # looks the way it does — an unreachable geocoder, or simply no matches.
    message: str | None = None


class ReverseGeocodeResponse(BaseModel):
    location: LatLon
    name: str | None = None
    source: Literal["offline", "network"] | None = None
    in_coverage: bool = False


class CoverageError(BaseModel):
    """Returned with HTTP 422 when a coordinate falls outside the loaded graph."""
    detail: str
    outside_coverage: bool = True
    distance_km: float
    bounds: dict[str, float]


# --- Push notifications ------------------------------------------------------

class WatchArea(BaseModel):
    """The rectangle a subscribed device asked to be alerted about."""
    min_lat: float = Field(..., ge=-90.0, le=90.0)
    max_lat: float = Field(..., ge=-90.0, le=90.0)
    min_lon: float = Field(..., ge=-180.0, le=180.0)
    max_lon: float = Field(..., ge=-180.0, le=180.0)

    @model_validator(mode="after")
    def _min_below_max(self):
        if self.min_lat > self.max_lat or self.min_lon > self.max_lon:
            raise ValueError("min corner must not exceed max corner")
        return self


class PushKeys(BaseModel):
    p256dh: str = Field(..., min_length=1, max_length=512)
    auth: str = Field(..., min_length=1, max_length=512)


class PushSubscriptionRequest(BaseModel):
    endpoint: str = Field(..., min_length=1, max_length=1024)
    keys: PushKeys
    watch_area: WatchArea | None = None


class PushUnsubscribeRequest(BaseModel):
    endpoint: str = Field(..., min_length=1, max_length=1024)


class PushSubscriptionResponse(BaseModel):
    endpoint: str
    watch_area: WatchArea | None
    created_at: str


class PushListResponse(BaseModel):
    subscriptions: list[PushSubscriptionResponse]
    total: int


class VapidPublicKeyResponse(BaseModel):
    enabled: bool
    public_key: str | None = None


# --- On-demand region packs ---------------------------------------------------

class PackBuildRequest(BaseModel):
    point: LatLon
    radius_km: float = Field(5.0, ge=0.5, le=20.0)
    name: str | None = Field(None, max_length=120)


class PackJobResponse(BaseModel):
    job_id: str
    status: Literal["building", "ready", "error"]
    region_id: str | None = None
    name: str | None = None
    error: str | None = None
    download_url: str | None = None
