import os
import networkx as nx
import osmnx as ox
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

from schemas import EdgeKeys


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

        self._load()
        self._index()

    def _load(self) -> None:
        """Load from cache, then OSMnx, then fall back to a synthetic grid."""
        if os.path.exists(self.cache_file):
            try:
                self.graph = ox.load_graphml(self.cache_file)
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

            try:
                self.graph = ox.add_edge_speeds(self.graph, fallback=50)
                self.graph = ox.add_edge_travel_times(self.graph)
            except Exception as speed_err:
                print(f"Notice: speed calculation skipped ({speed_err})")

            try:
                ox.save_graphml(self.graph, self.cache_file)
            except Exception as se:
                print(f"Notice: Could not cache graphml ({se})")
        except Exception as e:
            print(f"Graph download failed ({e}). Using synthetic fallback grid.")
            self._synthetic_grid()

    def _synthetic_grid(self) -> None:
        """5×5 bidirectional street grid centred on NYC for offline fallback."""
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
                               geometry=LineString([(u["x"], u["y"]), (v["x"], v["y"])]))

        self.graph = G

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

    def nearest_node(self, lon: float, lat: float) -> int:
        if self._node_tree and self._node_ids:
            return self._node_ids[self._node_tree.nearest(Point(lon, lat))]
        nodes = list(self.graph.nodes())
        if not nodes:
            return 1
        return min(nodes, key=lambda n: (
            (self.graph.nodes[n].get("x", 0.0) - lon) ** 2 + (self.graph.nodes[n].get("y", 0.0) - lat) ** 2
        ))

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
            "status": "ready",
        }
