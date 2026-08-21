import os

import networkx as nx
import osmnx as ox
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

from schemas import EdgeKeys
from spatial import haversine

# OSM `highway` values a car may legally use. Anything else — footway, steps,
# cycleway, path, pedestrian — is walk-only, and routing a vehicle onto it is a
# safety defect, not a routing inefficiency.
DRIVABLE_HIGHWAYS = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "living_street", "service", "road", "busway",
}

# Roads a pedestrian must not be routed onto.
DRIVE_ONLY_HIGHWAYS = {"motorway", "motorway_link", "trunk", "trunk_link"}


class GraphManager:
    def __init__(
        self,
        place_name: str | None = None,
        bbox: tuple[float, float, float, float] | None = None,
        point: tuple[float, float] | None = None,
        radius: float = 5000,
        cache_file: str = "region_graph.graphml",
    ):
        self.place_name = place_name
        self.bbox = bbox
        self.point = point
        self.radius = radius
        self.cache_file = cache_file
        self.graph: nx.MultiDiGraph | None = None
        self.linestrings: list[LineString] = []
        self.edge_keys: EdgeKeys = []
        self.spatial_index: STRtree | None = None
        self._node_ids: list[int] = []
        self._node_tree: STRtree | None = None
        self.drivable_edge_count: int = 0
        self.walkable_edge_count: int = 0
        self.max_speed_mps: float = 33.3
        self._street_index: list[tuple[str, float, float]] | None = None
        # True when no real road network could be loaded and the fallback grid is
        # standing in for one. Every routing entry point checks it.
        self.is_synthetic: bool = False

        self._load()
        self._index()
        self._classify_modes()

    def _load(self) -> None:
        """Load from cache, then OSMnx, then fall back to a synthetic grid."""
        if os.path.exists(self.cache_file):
            try:
                self.graph = ox.load_graphml(self.cache_file)
                self._ensure_speeds()
                return
            except Exception as e:
                print(f"Cache load failed ({e}), fetching fresh graph.")

        try:
            if self.bbox:
                self.graph = ox.graph_from_bbox(self.bbox, network_type="all", simplify=True)
            elif self.point:
                self.graph = ox.graph_from_point(self.point, dist=self.radius, network_type="all", simplify=True)
            else:
                name = self.place_name or "Battery Park, New York, USA"
                self.place_name = name
                self.graph = ox.graph_from_place(name, network_type="all", simplify=True)

            self._ensure_speeds()

            try:
                ox.save_graphml(self.graph, self.cache_file)
            except Exception as se:
                print(f"Notice: Could not cache graphml ({se})")
        except Exception as e:
            print(f"Graph download failed ({e}). Using synthetic fallback grid.")
            self._synthetic_grid()

    def _synthetic_grid(self) -> None:
        """A 5×5 grid of invented streets, so the process starts with no road network.

        It exists so the server boots, serves the app and can be inspected — not so it
        can route. Its edges are 200 m of nothing at coordinates in Lower Manhattan, and
        a route along them is turn-by-turn directions down streets that do not exist.
        `is_synthetic` marks it and the routing endpoints refuse; the same rule the rest
        of this codebase applies to invented hazards and invented shelters.
        """
        self.is_synthetic = True
        # Nothing here corresponds to the requested place, so stop claiming it does.
        self.place_name = None
        G = nx.MultiDiGraph()
        G.graph["crs"] = "epsg:4326"
        base_lat, base_lon, step = 40.7128, -74.0060, 0.002

        node_id, grid = 1, {}
        for r in range(5):
            for c in range(5):
                G.add_node(node_id, x=base_lon + c * step, y=base_lat + r * step)
                grid[(r, c)] = node_id
                node_id += 1

        for (r, c), curr in grid.items():
            for dr, dc in [(0, 1), (1, 0), (0, -1), (-1, 0)]:
                nbr = grid.get((r + dr, c + dc))
                if nbr:
                    u, v = G.nodes[curr], G.nodes[nbr]
                    G.add_edge(curr, nbr, key=0, length=200.0, travel_time=200.0 / 13.88,
                               highway="residential", speed_kph=50.0,
                               geometry=LineString([(u["x"], u["y"]), (v["x"], v["y"])]))

        self.graph = G

    def _ensure_speeds(self) -> None:
        """
        Guarantee every edge carries `speed_kph` and `travel_time`.

        This must run after loading from the .graphml cache as well as after a fresh
        download. It previously ran only on the download path, so any cached graph
        silently lost its per-road speeds and every drive route fell back to a flat
        50 km/h — an arterial and an alley cost the same per metre.
        """
        if self.graph is None:
            return
        try:
            self.graph = ox.add_edge_speeds(self.graph, fallback=50)
            self.graph = ox.add_edge_travel_times(self.graph)
        except Exception as speed_err:
            print(f"Notice: speed calculation skipped ({speed_err})")

    @staticmethod
    def _highway_tags(data: dict) -> set[str]:
        hw = data.get("highway")
        if isinstance(hw, list):
            return {str(h) for h in hw}
        return {str(hw)} if hw else set()

    def _classify_modes(self) -> None:
        """
        Count edges usable per travel mode, record the true maximum edge speed, and
        build a per-mode node index.

        The per-mode index matters: snapping to the nearest node overall can land on a
        footpath junction with no drivable edge at all, which leaves a drive request
        with an isolated start node and no route. Origins must snap to a node the
        chosen mode can actually leave.
        """
        drivable = walkable = 0
        max_speed_kph = 0.0
        drive_nodes: set[int] = set()
        walk_nodes: set[int] = set()

        for u, v, data in self.graph.edges(data=True):
            tags = self._highway_tags(data)
            if not tags or (tags & DRIVABLE_HIGHWAYS):
                drivable += 1
                drive_nodes.update((u, v))
            if not (tags & DRIVE_ONLY_HIGHWAYS):
                walkable += 1
                walk_nodes.update((u, v))
            try:
                speed = float(data.get("speed_kph") or 0.0)
                max_speed_kph = max(max_speed_kph, speed)
            except (TypeError, ValueError):
                pass

        self.drivable_edge_count = drivable
        self.walkable_edge_count = walkable
        self._mode_index = {
            "drive": self._build_node_tree(drive_nodes),
            "walk": self._build_node_tree(walk_nodes),
        }
        # Used as the A* heuristic divisor. Deriving it from the graph guarantees
        # admissibility instead of relying on a hardcoded constant staying correct.
        self.max_speed_mps = (max_speed_kph / 3.6) if max_speed_kph > 0 else 33.3

    def supported_modes(self) -> list[str]:
        modes = []
        if self.drivable_edge_count > 0:
            modes.append("drive")
        if self.walkable_edge_count > 0:
            modes.append("walk")
        return modes

    def contains(self, lon: float, lat: float, tolerance_m: float = 250.0) -> bool:
        """True when a coordinate is inside the loaded graph (plus a snap tolerance)."""
        return self.distance_outside_m(lon, lat) <= tolerance_m

    def distance_outside_m(self, lon: float, lat: float) -> float:
        """
        Metres from a coordinate to the nearest node in the graph.

        `nearest_node` will happily snap a coordinate in another country onto this
        graph's boundary, so every routing entry point must check this first and
        refuse rather than return a confident, wrong route.
        """
        if self._node_tree is None or not self._node_ids:
            return float("inf")
        node = self._node_ids[self._node_tree.nearest(Point(lon, lat))]
        n = self.graph.nodes[node]
        return haversine(lat, lon, n["y"], n["x"])

    def _index(self) -> None:
        """Build STRtree indices for edges (hazard queries) and nodes (nearest-node lookup)."""
        linestrings, edge_keys = [], []
        for u, v, k, data in self.graph.edges(keys=True, data=True):
            geom = data.get("geometry") or LineString(
                [(self.graph.nodes[u]["x"], self.graph.nodes[u]["y"]),
                 (self.graph.nodes[v]["x"], self.graph.nodes[v]["y"])]
            )
            linestrings.append(geom)
            edge_keys.append((u, v, k))

        self.linestrings = linestrings
        self.edge_keys = edge_keys
        self.spatial_index = STRtree(linestrings) if linestrings else None

        # Filter nodes with valid spatial coordinates and build 1-to-1 matching node index
        self._node_ids = [
            n for n, d in self.graph.nodes(data=True)
            if "x" in d and "y" in d
        ]
        node_points = [
            Point(self.graph.nodes[n]["x"], self.graph.nodes[n]["y"])
            for n in self._node_ids
        ]
        self._node_tree = STRtree(node_points) if node_points else None

    def _build_node_tree(self, node_ids: set[int]) -> tuple[list[int], STRtree | None]:
        ids = [n for n in node_ids if "x" in self.graph.nodes[n] and "y" in self.graph.nodes[n]]
        if not ids:
            return [], None
        points = [Point(self.graph.nodes[n]["x"], self.graph.nodes[n]["y"]) for n in ids]
        return ids, STRtree(points)

    def nearest_node(self, lon: float, lat: float, mode: str | None = None) -> int:
        """
        Nearest graph node to a coordinate.

        When `mode` is given, only nodes touched by an edge that mode may legally use
        are considered — otherwise a drive route can start on a pedestrian-only
        junction it can never leave.
        """
        if mode and getattr(self, "_mode_index", None):
            ids, tree = self._mode_index.get(mode, ([], None))
            if tree is not None and ids:
                return ids[tree.nearest(Point(lon, lat))]

        if self._node_tree and self._node_ids:
            return self._node_ids[self._node_tree.nearest(Point(lon, lat))]
        nodes = list(self.graph.nodes())
        if not nodes:
            return 1
        return min(nodes, key=lambda n: (
            (self.graph.nodes[n].get("x", 0.0) - lon) ** 2 + (self.graph.nodes[n].get("y", 0.0) - lat) ** 2
        ))

    def street_index(self) -> list[tuple[str, float, float]]:
        """`(street name, lat, lon)` for every distinct named street in the graph.

        This is what makes destination search work with the radio off: the names come
        out of the road graph the device already holds, so a user can type "Broadway"
        with no connectivity and get a routable coordinate back. Built once and cached,
        since the graph does not change after load.
        """
        if self._street_index is not None:
            return self._street_index

        # Keep the midpoint of the longest edge carrying each name. A single street is
        # many edges; the longest is the most representative place to aim at, and is
        # far more useful than whichever edge happened to be enumerated first.
        best: dict[str, tuple[float, float, float]] = {}
        for u, v, data in self.graph.edges(data=True):
            raw = data.get("name")
            if not raw:
                continue
            names = raw if isinstance(raw, list) else [raw]
            try:
                length = float(data.get("length", 0.0))
                lat = (self.graph.nodes[u]["y"] + self.graph.nodes[v]["y"]) / 2.0
                lon = (self.graph.nodes[u]["x"] + self.graph.nodes[v]["x"]) / 2.0
            except (KeyError, TypeError, ValueError):
                continue
            for name in names:
                name = str(name).strip()
                if not name:
                    continue
                current = best.get(name)
                if current is None or length > current[0]:
                    best[name] = (length, lat, lon)

        self._street_index = sorted(
            ((name, lat, lon) for name, (_, lat, lon) in best.items()),
            key=lambda item: item[0],
        )
        return self._street_index

    def get_graph(self) -> nx.MultiDiGraph:
        return self.graph

    def get_spatial_data(self) -> tuple[STRtree, list[LineString], EdgeKeys]:
        return self.spatial_index, self.linestrings, self.edge_keys

    def get_summary(self) -> dict:
        lats = [d["y"] for _, d in self.graph.nodes(data=True) if "y" in d]
        lons = [d["x"] for _, d in self.graph.nodes(data=True) if "x" in d]
        bounds = {
            "min_lat": round(min(lats), 6), "max_lat": round(max(lats), 6),
            "min_lon": round(min(lons), 6), "max_lon": round(max(lons), 6),
        } if lats else {"min_lat": 0.0, "max_lat": 0.0, "min_lon": 0.0, "max_lon": 0.0}
        return {
            "place_name": self.place_name,
            "bounds": bounds,
            "node_count": self.graph.number_of_nodes(),
            "edge_count": self.graph.number_of_edges(),
            "status": "no_map" if self.is_synthetic else "ready",
            "synthetic": self.is_synthetic,
            "drivable_edge_count": self.drivable_edge_count,
            "walkable_edge_count": self.walkable_edge_count,
            "supported_modes": self.supported_modes(),
        }
