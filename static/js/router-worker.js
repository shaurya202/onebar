// Web Worker host for the offline routing engine.
//
// Parsing a pack, building the edge grid and running A* all happen here so the map
// stays responsive even during a worst-case full-graph search on a low-end device.

import { readPack } from './pack-format.js';
import { buildSearchIndex, searchIndex } from './pack-search.js';
import { buildEdgeGrid, route } from './route-engine.js';

let pack = null;
let grid = null;
let searchable = null;
let regionId = null;

self.onmessage = (event) => {
  const { id, type, payload } = event.data;

  try {
    switch (type) {
      case 'load': {
        // The buffer arrives as a transferable, so this is a move, not a copy.
        const started = Date.now();
        pack = readPack(payload.buffer);
        grid = buildEdgeGrid(pack);
        // Built eagerly alongside the routing grid: it is one pass over the same
        // arrays, and building it lazily would put that cost on the first keystroke.
        searchable = buildSearchIndex(pack);
        regionId = payload.regionId;
        self.postMessage({
          id,
          ok: true,
          result: {
            regionId,
            nodeCount: pack.nodeCount,
            edgeCount: pack.edgeCount,
            bounds: pack.bounds,
            havens: pack.havens,
            loadMs: Date.now() - started,
          },
        });
        break;
      }

      case 'route': {
        if (!pack) throw new Error('No region pack loaded');
        const started = Date.now();
        const result = route(pack, grid, payload);
        result.compute_ms = Date.now() - started;
        self.postMessage({ id, ok: true, result });
        break;
      }

      case 'search': {
        if (!pack) throw new Error('No region pack loaded');
        self.postMessage({
          id,
          ok: true,
          result: searchIndex(searchable, payload.query, {
            limit: payload.limit || 8,
            near: payload.near || null,
          }),
        });
        break;
      }

      case 'status':
        self.postMessage({
          id,
          ok: true,
          result: pack
            ? {
              loaded: true, regionId, bounds: pack.bounds, nodeCount: pack.nodeCount,
              streetCount: searchable?.streets.length || 0,
            }
            : { loaded: false },
        });
        break;

      default:
        throw new Error(`Unknown worker command: ${type}`);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message || String(err) });
  }
};
