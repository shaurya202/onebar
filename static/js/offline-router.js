// Main-thread facade over the offline routing worker.
//
// OneBar is client-authoritative for routing: if a region pack covering the user's
// position is installed, routing happens on-device and never touches the network.
// The server is a fallback for the browser PWA before any pack is downloaded — the
// opposite of the original design, in which routing failed exactly when the network did.

import { loadPackBuffer, packForLocation } from './pack-store.js';

let worker = null;
// The *merged* record for the pack currently in the worker: the catalogue entry from
// localStorage plus what the worker reported after parsing it — crucially the haven
// list, which exists only inside the pack.
let loadedRegion = null;
let nextId = 1;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('/static/js/router-worker.js', { type: 'module' });
  worker.onmessage = (event) => {
    const { id, ok, result, error } = event.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(result);
    else entry.reject(new Error(error));
  };
  worker.onerror = (err) => {
    console.warn('Routing worker failed:', err.message);
    for (const [, entry] of pending) entry.reject(new Error('Routing worker failed'));
    pending.clear();
    // The worker is gone and so is the pack it held. Forgetting which region was
    // loaded means the next request reloads it rather than assuming a dead worker
    // still has it.
    worker = null;
    loadedRegion = null;
  };
  return worker;
}

function call(type, payload, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage({ id, type, payload }, transfer);
  });
}

/** True when a downloaded pack covers this position, i.e. offline routing is possible. */
export function hasOfflineCoverage(lat, lon) {
  return packForLocation(lat, lon) !== null;
}

/** Load the pack covering a position into the worker. Returns null when none is installed. */
export async function ensureRegionLoaded(lat, lon) {
  const region = packForLocation(lat, lon);
  if (!region) return null;

  // Return the merged record, not the catalogue entry. Returning `region` here meant
  // every call after the first handed back bare localStorage metadata with no
  // `havens` — so one keystroke in the search box was enough to make `offlineHavens()`
  // return [] for the rest of the session. Evacuation then had no destinations, and
  // the empty list also erased every shelter already drawn on the map.
  if (loadedRegion?.id === region.id) return loadedRegion;

  const buffer = await loadPackBuffer(region.id);
  if (!buffer) return null;

  // Transferred, not copied — a metro pack moves into the worker for free.
  const info = await call('load', { buffer, regionId: region.id }, [buffer]);
  loadedRegion = { ...region, ...info };
  return loadedRegion;
}

/**
 * Route entirely on-device.
 * @returns the same response shape as the server, or null when no pack covers the origin.
 */
export async function routeOffline({ origin, destinations, mode, hazards, allowPenaltyFallback }) {
  const region = await ensureRegionLoaded(origin.lat, origin.lon);
  if (!region) return null;
  return call('route', {
    origin,
    destinations,
    mode,
    hazards,
    allowPenaltyFallback: allowPenaltyFallback !== false,
  });
}

/** Safe havens bundled inside the installed pack — available with no connectivity. */
export async function offlineHavens(lat, lon) {
  const region = await ensureRegionLoaded(lat, lon);
  return region?.havens || [];
}

/**
 * Search street names and shelters inside the installed pack.
 *
 * Returns [] when no pack covers the position, which the caller must treat as "no
 * offline index here", not as "no such place" — the two are very different answers.
 */
export async function searchOffline(lat, lon, query, { limit = 8, near = null } = {}) {
  const region = await ensureRegionLoaded(lat, lon);
  if (!region) return [];
  return call('search', { query, limit, near });
}
