import math

from shapely.geometry import LineString, Polygon
from shapely.strtree import STRtree

from schemas import EdgeKey, EdgeKeys, LatLon


def to_shapely_polygon(coordinates: list[LatLon | dict[str, float]]) -> Polygon:
    """Convert LatLon list or dict list to a Shapely Polygon (lon, lat order for Shapely)."""
    points = [
        (p["lon"], p["lat"]) if isinstance(p, dict) else (p.lon, p.lat)
        for p in coordinates
    ]
    if points and points[0] != points[-1]:
        points.append(points[0])
    return Polygon(points)


def create_circle_polygon(center_lat: float, center_lon: float, radius_meters: float, num_points: int = 32) -> Polygon:
    """Generate a circular Polygon from center coordinates and radius in meters."""
    R = 6371000.0  # Earth radius in meters
    coords = []
    for i in range(num_points):
        angle = 2 * math.pi * i / num_points
        dx = radius_meters * math.cos(angle)
        dy = radius_meters * math.sin(angle)
        d_lat = (dy / R) * (180.0 / math.pi)
        d_lon = (dx / (R * math.cos(math.radians(center_lat)))) * (180.0 / math.pi)
        coords.append((center_lon + d_lon, center_lat + d_lat))
    coords.append(coords[0])  # Close polygon
    return Polygon(coords)


def buffer_polygon(polygon: Polygon, buffer_meters: float) -> Polygon:
    """Expand a polygon outwards by buffer_meters (approximate degree conversion)."""
    if buffer_meters <= 0:
        return polygon
    # ~111,320 meters per degree latitude
    deg_buffer = buffer_meters / 111320.0
    buffered = polygon.buffer(deg_buffer)
    if isinstance(buffered, Polygon):
        return buffered
    return polygon


def from_shapely_polygon(polygon: Polygon) -> list[LatLon]:
    return [LatLon(lat=round(y, 6), lon=round(x, 6)) for x, y in polygon.exterior.coords]


def blocked_edges_for_polygon(
    polygon: Polygon,
    spatial_index: STRtree,
    linestrings: list[LineString],
    edge_keys: EdgeKeys,
) -> set[EdgeKey]:
    """Two-phase spatial query: bbox candidates -> exact intersection."""
    if not linestrings or spatial_index is None:
        return set()
    candidates = spatial_index.query(polygon).tolist()
    return {edge_keys[i] for i in candidates if i < len(linestrings) and linestrings[i].intersects(polygon)}


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in meters."""
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def calculate_bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate compass forward azimuth (bearing) from (lat1, lon1) to (lat2, lon2) in degrees [0, 360)."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_lambda = math.radians(lon2 - lon1)

    y = math.sin(delta_lambda) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(delta_lambda)
    theta = math.atan2(y, x)
    return (math.degrees(theta) + 360.0) % 360.0


def get_turn_type(bearing1: float, bearing2: float) -> str:
    """Determine turn maneuver classification from previous bearing to new bearing."""
    diff = (bearing2 - bearing1 + 180.0) % 360.0 - 180.0
    if abs(diff) <= 20.0:
        return "straight"
    elif 20.0 < diff <= 60.0:
        return "slight_right"
    elif 60.0 < diff <= 120.0:
        return "turn_right"
    elif 120.0 < diff <= 160.0:
        return "sharp_right"
    elif -60.0 <= diff < -20.0:
        return "slight_left"
    elif -120.0 <= diff < -60.0:
        return "turn_left"
    elif -160.0 <= diff < -120.0:
        return "sharp_left"
    else:
        return "u_turn"


def format_bearing_cardinal(bearing: float) -> str:
    """Convert bearing degrees to cardinal direction abbreviation."""
    dirs = ["North", "Northeast", "East", "Southeast", "South", "Southwest", "West", "Northwest"]
    idx = round(bearing / 45.0) % 8
    return dirs[idx]
