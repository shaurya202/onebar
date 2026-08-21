// Offline routing over an .obp region pack.
//
// This is the engine that makes OneBar's core promise true: with a pack downloaded,
// evacuation routing works with the radio switched off. It runs inside a Web Worker
// (see router-worker.js) so a full-graph search never blocks the map.
//
// Design notes:
//  - A* over CSR adjacency using flat typed arrays; no object allocation in the hot loop.
//  - The heuristic divides by the pack's true maximum edge speed, recorded at build
//    time, so admissibility holds by construction rather than by a hardcoded constant.
//  - Evacuation uses ONE search toward the nearest of many havens, not one search per
//    haven, so ranking N shelters costs roughly the same as routing to one.

import {
  COORD_SCALE, edgeAllowed, edgeCostSeconds, edgeGeometry, edgeName,
  nodeLatOf, nodeLonOf,
} from './pack-format.js';

const EARTH_RADIUS_M = 6371000;
const HAZARD_PENALTY = 100;      // matches the server's penalised-fallback multiplier
const GRID_CELL_DEG = 0.002;     // ~200 m

export function haversine(lat1, lon1, lat2, lon2) {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Binary heap over (nodeIndex, priority). Flat arrays, no comparator closures.
// ---------------------------------------------------------------------------
class MinHeap {
  constructor(capacity) {
    this.items = new Uint32Array(capacity);
    this.priority = new Float64Array(capacity);
    this.size = 0;
  }

  push(item, priority) {
    if (this.size === this.items.length) this._grow();
    let i = this.size++;
    this.items[i] = item;
    this.priority[i] = priority;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priority[parent] <= this.priority[i]) break;
      this._swap(i, parent);
      i = parent;
    }
  }

  pop() {
    if (this.size === 0) return -1;
    const top = this.items[0];
    this.size--;
    if (this.size > 0) {
      this.items[0] = this.items[this.size];
      this.priority[0] = this.priority[this.size];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.size && this.priority[l] < this.priority[smallest]) smallest = l;
        if (r < this.size && this.priority[r] < this.priority[smallest]) smallest = r;
        if (smallest === i) break;
        this._swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  _swap(a, b) {
    const item = this.items[a]; this.items[a] = this.items[b]; this.items[b] = item;
    const pri = this.priority[a]; this.priority[a] = this.priority[b]; this.priority[b] = pri;
  }

  _grow() {
    const items = new Uint32Array(this.items.length * 2);
    const priority = new Float64Array(this.priority.length * 2);
    items.set(this.items); priority.set(this.priority);
    this.items = items; this.priority = priority;
  }
}

// ---------------------------------------------------------------------------
// Spatial index — a uniform grid over edge bounding boxes.
//
// Built once per pack in a single pass. Used both for snapping a GPS fix to the
// network and for finding the edges a hazard polygon could possibly touch, which
// keeps hazard masking proportional to hazard area rather than to graph size.
// ---------------------------------------------------------------------------
export function buildEdgeGrid(pack) {
  const cells = new Map();
  const key = (gx, gy) => gx * 100000 + gy;

  for (let node = 0; node < pack.nodeCount; node++) {
    const lat1 = pack.nodeLat[node] / COORD_SCALE;
    const lon1 = pack.nodeLon[node] / COORD_SCALE;
    for (let e = pack.edgeOffset[node]; e < pack.edgeOffset[node + 1]; e++) {
      const target = pack.edgeTarget[e];
      const lat2 = pack.nodeLat[target] / COORD_SCALE;
      const lon2 = pack.nodeLon[target] / COORD_SCALE;

      const gx0 = Math.floor(Math.min(lon1, lon2) / GRID_CELL_DEG);
      const gx1 = Math.floor(Math.max(lon1, lon2) / GRID_CELL_DEG);
      const gy0 = Math.floor(Math.min(lat1, lat2) / GRID_CELL_DEG);
      const gy1 = Math.floor(Math.max(lat1, lat2) / GRID_CELL_DEG);

      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const k = key(gx, gy);
          let bucket = cells.get(k);
          if (!bucket) { bucket = []; cells.set(k, bucket); }
          bucket.push(node, e);
        }
      }
    }
  }
  return { cells, key, cell: GRID_CELL_DEG };
}

/** Nearest node reachable in `mode`, or -1 if nothing is in range. */
// How far a *destination* may sit from the nearest usable node and still be offered.
//
// The server refuses a haven more than 400 m from the graph (SafeHavenStore
// .REACHABLE_TOLERANCE_M): snapping a distant shelter to a boundary node produces a
// route that claims to arrive somewhere it does not. The offline engine has to apply
// the same bound, or the two answer differently for the same shelter — the offline one
// being the more confident and the more wrong.
export const DESTINATION_SNAP_METRES = 400;

// An origin may snap further. The user is wherever they are, and refusing to route
// somebody standing 500 m from the mapped area helps nobody; coverage is enforced
// separately and with its own message.
export const ORIGIN_SNAP_METRES = 2000;

export function nearestNode(pack, grid, lat, lon, mode, maxMetres = ORIGIN_SNAP_METRES) {
  let best = -1;
  let bestDist = Infinity;

  for (let ring = 0; ring <= 6; ring++) {
    const gx = Math.floor(lon / grid.cell);
    const gy = Math.floor(lat / grid.cell);
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        const bucket = grid.cells.get(grid.key(gx + dx, gy + dy));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i += 2) {
          const node = bucket[i];
          const edge = bucket[i + 1];
          // Only snap to a node this mode can actually leave; otherwise a drive
          // request can start on a footpath junction with no road out of it.
          if (!edgeAllowed(pack, edge, mode)) continue;
          const d = haversine(lat, lon, nodeLatOf(pack, node), nodeLonOf(pack, node));
          if (d < bestDist) { bestDist = d; best = node; }
        }
      }
    }
    if (best >= 0 && bestDist <= (ring + 1) * grid.cell * 111000) break;
  }

  return bestDist <= maxMetres ? best : -1;
}

// ---------------------------------------------------------------------------
// Hazard masking — point-in-polygon and segment intersection in plain JS,
// replacing the server's Shapely dependency.
// ---------------------------------------------------------------------------
function pointInPolygon(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lonI] = ring[i];
    const [latJ, lonJ] = ring[j];
    if ((lonI > lon) !== (lonJ > lon)
      && lat < ((latJ - latI) * (lon - lonI)) / (lonJ - lonI) + latI) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentsIntersect(a1, a2, b1, b2) {
  const d = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  return d1 !== d2 && d3 !== d4;
}

function segmentHitsPolygon(p1, p2, ring) {
  if (pointInPolygon(p1[0], p1[1], ring) || pointInPolygon(p2[0], p2[1], ring)) return true;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (segmentsIntersect(p1, p2, ring[j], ring[i])) return true;
  }
  return false;
}

/**
 * Mark every edge intersecting an active hazard.
 *
 * `hazards` use each zone's effective_coordinates — the buffered ring the server
 * already computes — so the client blocks exactly the same edges the server would,
 * rather than reimplementing the buffer and drifting out of agreement.
 */
export function buildBlockedMask(pack, grid, hazards) {
  const mask = new Uint8Array(pack.edgeCount);
  if (!hazards || !hazards.length) return mask;

  for (const hazard of hazards) {
    const ring = (hazard.effective_coordinates?.length
      ? hazard.effective_coordinates
      : hazard.coordinates || []).map((c) => [c.lat, c.lon]);
    if (ring.length < 3) continue;

    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const [lat, lon] of ring) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }

    const gx0 = Math.floor(minLon / grid.cell);
    const gx1 = Math.floor(maxLon / grid.cell);
    const gy0 = Math.floor(minLat / grid.cell);
    const gy1 = Math.floor(maxLat / grid.cell);

    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const bucket = grid.cells.get(grid.key(gx, gy));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i += 2) {
          const node = bucket[i];
          const edge = bucket[i + 1];
          if (mask[edge]) continue;
          const pts = edgeGeometry(pack, node, edge);
          for (let p = 0; p < pts.length - 1; p++) {
            if (segmentHitsPolygon(pts[p], pts[p + 1], ring)) { mask[edge] = 1; break; }
          }
        }
      }
    }
  }
  return mask;
}

// ---------------------------------------------------------------------------
// A*
// ---------------------------------------------------------------------------
function search(pack, start, targets, mode, blocked, penalise) {
  const { nodeCount, edgeOffset, edgeTarget } = pack;
  const dist = new Float64Array(nodeCount).fill(Infinity);
  const cameFrom = new Int32Array(nodeCount).fill(-1);
  const cameEdge = new Int32Array(nodeCount).fill(-1);
  const settled = new Uint8Array(nodeCount);

  const speed = mode === 'walk' ? 1.389 : Math.max(pack.maxSpeedMps, 1);
  const targetSet = new Set(targets);

  // Admissible: straight-line distance divided by the fastest speed any edge in this
  // pack allows can never exceed the true remaining travel time.
  const heuristic = (node) => {
    const lat = nodeLatOf(pack, node);
    const lon = nodeLonOf(pack, node);
    let best = Infinity;
    for (const t of targets) {
      const d = haversine(lat, lon, nodeLatOf(pack, t), nodeLonOf(pack, t));
      if (d < best) best = d;
    }
    return best / speed;
  };

  const heap = new MinHeap(Math.min(nodeCount, 1024));
  dist[start] = 0;
  heap.push(start, heuristic(start));

  const reached = [];
  while (heap.size > 0) {
    const node = heap.pop();
    if (settled[node]) continue;
    settled[node] = 1;

    if (targetSet.has(node)) {
      reached.push(node);
      // Keep going until every candidate haven is settled, so alternatives come
      // out of the same search instead of costing another one each.
      if (reached.length === targetSet.size) break;
    }

    for (let e = edgeOffset[node]; e < edgeOffset[node + 1]; e++) {
      if (!edgeAllowed(pack, e, mode)) continue;
      if (blocked[e] && !penalise) continue;

      let cost = edgeCostSeconds(pack, e, mode);
      if (blocked[e]) cost *= HAZARD_PENALTY;

      const next = edgeTarget[e];
      const candidate = dist[node] + cost;
      if (candidate < dist[next]) {
        dist[next] = candidate;
        cameFrom[next] = node;
        cameEdge[next] = e;
        heap.push(next, candidate + heuristic(next));
      }
    }
  }

  return { dist, cameFrom, cameEdge, reached };
}

function reconstruct(pack, cameFrom, cameEdge, start, end) {
  const nodes = [];
  const edges = [];
  let node = end;
  while (node !== -1 && node !== start) {
    nodes.push(node);
    edges.push(cameEdge[node]);
    node = cameFrom[node];
  }
  if (node !== start) return null;
  nodes.push(start);
  nodes.reverse();
  edges.reverse();
  return { nodes, edges };
}

/**
 * Route from a coordinate to the fastest reachable target.
 *
 * Returns the same shape the server's /route endpoints produce, so the UI is
 * indifferent to which engine answered.
 */
export function route(pack, grid, options) {
  const {
    origin, destinations, mode = 'drive', hazards = [], allowPenaltyFallback = true,
  } = options;

  const startNode = nearestNode(pack, grid, origin.lat, origin.lon, mode);
  if (startNode < 0) {
    return { success: false, error: 'You are outside the downloaded map area for this region.' };
  }

  const targetNodes = [];
  const targetMeta = [];
  for (const dest of destinations) {
    const node = nearestNode(pack, grid, dest.lat, dest.lon, mode, DESTINATION_SNAP_METRES);
    if (node < 0) continue;      // unreachable havens are dropped, never snapped
    targetNodes.push(node);
    targetMeta.push({ node, dest });
  }
  if (!targetNodes.length) {
    return { success: false, error: 'No destination in this area can be reached by road.' };
  }

  const blocked = buildBlockedMask(pack, grid, hazards);
  const blockedCount = blocked.reduce((n, v) => n + v, 0);

  let result = search(pack, startNode, targetNodes, mode, blocked, false);
  let isFallback = false;

  if (!result.reached.length && allowPenaltyFallback && blockedCount) {
    result = search(pack, startNode, targetNodes, mode, blocked, true);
    isFallback = true;
  }
  if (!result.reached.length) {
    return { success: false, error: 'No route avoiding active hazards could be found.' };
  }

  const ranked = result.reached
    .map((node) => ({ node, seconds: result.dist[node] }))
    .sort((a, b) => a.seconds - b.seconds);

  const best = ranked[0];
  const path = reconstruct(pack, result.cameFrom, result.cameEdge, startNode, best.node);
  if (!path) return { success: false, error: 'Route reconstruction failed.' };

  const meta = targetMeta.find((t) => t.node === best.node);
  let metres = 0;
  const coordinates = [];
  for (let i = 0; i < path.edges.length; i++) {
    const edge = path.edges[i];
    metres += pack.edgeLength[edge];
    const pts = edgeGeometry(pack, path.nodes[i], edge);
    for (let p = i === 0 ? 0 : 1; p < pts.length; p++) {
      coordinates.push({ lat: pts[p][0], lon: pts[p][1] });
    }
  }

  return {
    success: true,
    engine: 'offline',
    destination: meta ? meta.dest : null,
    coordinates,
    maneuvers: buildManeuvers(pack, path),
    total_travel_time_seconds: Math.round(best.seconds * 10) / 10,
    total_distance_meters: metres,
    blocked_edges_avoided: blockedCount,
    is_fallback: isFallback,
    warning: isFallback ? 'Clear paths blocked — routing via lowest-risk alternative.' : null,
    alternatives: ranked.slice(1, 5).map((r) => {
      const m = targetMeta.find((t) => t.node === r.node);
      return {
        destination: m ? m.dest : null,
        travel_time_seconds: Math.round(r.seconds * 10) / 10,
      };
    }).filter((a) => a.destination),
  };
}

function bearing(lat1, lon1, lat2, lon2) {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const TURNS = [
  [20, 'straight', 'Continue onto'],
  [60, 'slight_right', 'Bear slight right onto'],
  [120, 'turn_right', 'Turn right onto'],
  [160, 'sharp_right', 'Take sharp right onto'],
];

function turnFor(delta) {
  const abs = Math.abs(delta);
  for (const [limit, type, text] of TURNS) {
    if (abs <= limit) {
      if (type === 'straight' || delta > 0) return [type, text];
      return [type.replace('right', 'left'), text.replace('right', 'left')];
    }
  }
  return ['u_turn', 'Make a U-turn onto'];
}

function buildManeuvers(pack, path) {
  const maneuvers = [];
  let current = null;
  let lastBearing = null;

  for (let i = 0; i < path.edges.length; i++) {
    const edge = path.edges[i];
    const from = path.nodes[i];
    const to = pack.edgeTarget[edge];
    const name = edgeName(pack, edge) || 'Connecting Road';
    const metres = pack.edgeLength[edge];
    const b = bearing(nodeLatOf(pack, from), nodeLonOf(pack, from),
      nodeLatOf(pack, to), nodeLonOf(pack, to));

    if (!current) {
      current = {
        type: 'depart',
        instruction: `Head ${cardinal(b)} on ${name}`,
        street_name: name,
        distance_meters: metres,
        location: { lat: nodeLatOf(pack, from), lon: nodeLonOf(pack, from) },
      };
    } else {
      const delta = ((b - lastBearing + 540) % 360) - 180;
      const [type, text] = turnFor(delta);
      if (type === 'straight' && name === current.street_name) {
        current.distance_meters += metres;
      } else {
        maneuvers.push(current);
        current = {
          type,
          instruction: `${text} ${name}`,
          street_name: name,
          distance_meters: metres,
          location: { lat: nodeLatOf(pack, from), lon: nodeLonOf(pack, from) },
        };
      }
    }
    lastBearing = b;
  }

  if (current) maneuvers.push(current);
  const last = path.nodes[path.nodes.length - 1];
  maneuvers.push({
    type: 'arrive',
    instruction: 'Arrive at evacuation destination',
    street_name: null,
    distance_meters: 0,
    location: { lat: nodeLatOf(pack, last), lon: nodeLonOf(pack, last) },
  });
  return maneuvers;
}

function cardinal(b) {
  const dirs = ['North', 'Northeast', 'East', 'Southeast', 'South', 'Southwest', 'West', 'Northwest'];
  return dirs[Math.round(b / 45) % 8];
}
