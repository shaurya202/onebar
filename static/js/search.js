// Destination search.
//
// Three sources, merged, and always in this order:
//
//   1. a coordinate the user pasted — instant, needs nothing
//   2. the installed region pack — street names and shelters, works with the radio off
//   3. the server geocoder — addresses and places the road graph cannot name
//
// The order is the point. Offline results come first because they are the ones
// guaranteed to be routable and guaranteed to still be there during the event OneBar
// exists for. Each result carries where it came from so the UI can say so; a result
// outside downloaded coverage is labelled rather than quietly offered as a destination
// the router will then refuse.

import { api } from './api.js';
import { hasOfflineCoverage, searchOffline } from './offline-router.js';
import { installedPacks, packForLocation } from './pack-store.js';

const DEBOUNCE_MS = 220;

let debounceTimer = null;
let sequence = 0;

/** Parse "40.7128, -74.0060" and friends. Mirrors the server's parser. */
export function parseCoordinate(query) {
  const cleaned = String(query || '').replace(/[;/]/g, ',').trim();
  let parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2) {
    parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length !== 2) return null;
  }
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/**
 * A position to search a pack from.
 *
 * The user's own position when there is one, otherwise the centre of an installed
 * pack — the pack is what holds the index, and which point inside it we ask from makes
 * no difference to what the search finds.
 */
function offlineAnchor(near) {
  if (near && hasOfflineCoverage(near.lat, near.lon)) return near;
  const installed = installedPacks();
  if (!installed.length) return null;
  const region = (near && packForLocation(near.lat, near.lon)) || installed[0];
  const b = region.bounds;
  if (!b) return null;
  return { lat: (b.min_lat + b.max_lat) / 2, lon: (b.min_lon + b.max_lon) / 2 };
}

function dedupe(results, limit) {
  const seen = new Set();
  const out = [];
  for (const result of results) {
    if (!result?.location) continue;
    const key = `${result.location.lat.toFixed(4)},${result.location.lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Run a search.
 *
 * @param {string} query
 * @param {object} options
 * @param {{lat:number,lon:number}|null} options.near  the user's position, for ranking
 * @param {number} options.limit
 * @returns {Promise<{results: Array, offlineOnly: boolean, message: string|null}>}
 */
export async function search(query, { near = null, limit = 8, onPartial = null } = {}) {
  const trimmed = String(query || '').trim();
  if (trimmed.length < 2) return { results: [], offlineOnly: false, message: null };

  const results = [];
  const coordinate = parseCoordinate(trimmed);
  if (coordinate) {
    results.push({
      name: `${coordinate.lat.toFixed(5)}, ${coordinate.lon.toFixed(5)}`,
      subtitle: 'Coordinates',
      location: coordinate,
      kind: 'coordinate',
      source: 'offline',
      // Three states, not two. With a pack installed we know whether this point is
      // routable; with no pack we genuinely do not, and claiming "no coverage" would
      // warn the user away from a destination the server can route to perfectly well.
      in_coverage: installedPacks().length
        ? hasOfflineCoverage(coordinate.lat, coordinate.lon)
        : null,
      distance_meters: null,
    });
  }

  // Without a position fix, search the pack the user actually downloaded rather than
  // skipping the offline layer entirely and telling them no map is installed. Waiting
  // for GPS is exactly the wrong behaviour indoors, underground, or in the minutes
  // after launch — which is most of when someone opens this app in a hurry.
  const anchor = offlineAnchor(near);
  if (anchor) {
    try {
      results.push(...await searchOffline(anchor.lat, anchor.lon, trimmed, { limit, near }));
    } catch (err) {
      console.warn('Offline search failed:', err.message);
    }
  }

  // Hand back what the device already knows before waiting on the network.
  if (onPartial && results.length) onPartial({ results: dedupe(results, limit) });

  let message = null;
  let offlineOnly = false;
  const havePack = Boolean(anchor);

  if (results.length < limit) {
    try {
      const remote = await api.geocode(trimmed, {
        lat: near?.lat ?? null,
        lon: near?.lon ?? null,
        limit,
      });
      results.push(...(remote.results || []));
      if (remote.message && !results.length) message = remote.message;
    } catch {
      offlineOnly = true;
      if (!results.length) {
        message = havePack
          ? 'No match in your downloaded map, and address search needs a connection.'
          : 'Search needs a connection, or a downloaded map for this area.';
      } else {
        message = 'Showing results from your downloaded map — address search is offline.';
      }
    }
  }

  return { results: dedupe(results, limit), offlineOnly, message };
}

/**
 * Debounced search for a text field.
 *
 * Late responses are dropped: without the sequence check a slow query for "br" can
 * land after a fast one for "broadway" and replace the right answer with a stale one.
 */
export function searchDebounced(query, options, onResults) {
  clearTimeout(debounceTimer);
  const ticket = ++sequence;
  debounceTimer = setTimeout(async () => {
    const payload = await search(query, {
      ...options,
      // Partial results are dropped just as late final results are: a stale answer for
      // "br" must not replace a fresh one for "broadway".
      onPartial: (partial) => {
        if (ticket === sequence) options.onPartial?.(partial);
      },
    });
    if (ticket === sequence) onResults(payload);
  }, DEBOUNCE_MS);
}

export function cancelSearch() {
  clearTimeout(debounceTimer);
  sequence++;
}
