// Destination search over an installed region pack.
//
// The pack already carries every street name in the region — the router uses them to
// write turn instructions — plus the safe havens. Indexing them costs one pass over
// the edge array and makes the search box work with the radio off, which is the only
// state OneBar is really designed for.

import { COORD_SCALE } from './pack-format.js';

/**
 * Build the searchable index for a pack.
 *
 * One entry per distinct street name, positioned at the midpoint of the longest edge
 * carrying it: a street is many edges, and the longest is the most representative
 * place to aim at.
 */
export function buildSearchIndex(pack) {
  const bestLength = new Map();   // nameId -> length
  const bestNode = new Map();     // nameId -> [lat, lon] midpoint

  for (let node = 0; node < pack.nodeCount; node++) {
    const start = pack.edgeOffset[node];
    const end = pack.edgeOffset[node + 1];
    for (let edge = start; edge < end; edge++) {
      const nameId = pack.edgeNameId[edge];
      if (!nameId) continue;                  // index 0 is the empty string
      const length = pack.edgeLength[edge];
      if ((bestLength.get(nameId) ?? -1) >= length) continue;

      const target = pack.edgeTarget[edge];
      bestLength.set(nameId, length);
      bestNode.set(nameId, [
        (pack.nodeLat[node] + pack.nodeLat[target]) / 2 / COORD_SCALE,
        (pack.nodeLon[node] + pack.nodeLon[target]) / 2 / COORD_SCALE,
      ]);
    }
  }

  const streets = [];
  for (const [nameId, position] of bestNode) {
    const name = pack.strings[nameId];
    if (!name) continue;
    streets.push({ name, lower: name.toLowerCase(), lat: position[0], lon: position[1] });
  }
  streets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const havens = (pack.havens || []).map((haven) => ({
    name: haven.name,
    lower: String(haven.name || '').toLowerCase(),
    lat: haven.location?.lat ?? haven.lat,
    lon: haven.location?.lon ?? haven.lon,
    subtitle: haven.address || String(haven.type || 'shelter').replace('_', ' '),
    haven,
  }));

  return { streets, havens };
}

function haversineMetres(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(a));
}

/**
 * Search the index.
 * @returns results in the same shape as the server's `/geocode`, so the UI renders
 *          offline and online hits through one code path.
 */
export function searchIndex(index, query, { limit = 8, near = null } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < 2) return [];

  const scored = [];
  const consider = (entry, kind, subtitle) => {
    const at = entry.lower.indexOf(needle);
    if (at === -1) return;
    if (!Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) return;
    const distance = near ? haversineMetres(near.lat, near.lon, entry.lat, entry.lon) : 0;
    scored.push({
      // A name that starts with what was typed is almost always what was meant;
      // shelters outrank streets on a tie because during an evacuation they are the
      // more useful answer.
      rank: [at === 0 ? 0 : 1, kind === 'shelter' ? 0 : 1, distance, entry.name.length],
      result: {
        name: entry.name,
        subtitle,
        location: { lat: Number(entry.lat.toFixed(6)), lon: Number(entry.lon.toFixed(6)) },
        kind,
        source: 'offline',
        in_coverage: true,
        distance_meters: near ? Math.round(distance) : null,
        haven: entry.haven || null,
      },
    });
  };

  for (const haven of index.havens) consider(haven, 'shelter', haven.subtitle);
  for (const street of index.streets) consider(street, 'street', 'Street in downloaded map');

  scored.sort((a, b) => {
    for (let i = 0; i < a.rank.length; i++) {
      if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
    }
    return 0;
  });

  const seen = new Set();
  const out = [];
  for (const { result } of scored) {
    const key = result.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
    if (out.length >= limit) break;
  }
  return out;
}
