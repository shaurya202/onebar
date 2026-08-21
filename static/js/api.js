import { deviceId } from './device.js';
import {
  saveLocalHazard,
  getLocalHazards,
  removeLocalHazard,
  queueMutation,
  getPendingMutations,
  pendingMutationCount,
  clearMutation,
  replaceLocalHazards,
} from './offline-store.js';

const TIMEOUT_MS = 10000;

export function apiBaseUrl() {
  return getBaseUrl();
}

function getBaseUrl() {
  if (typeof window === 'undefined') return '';
  const stored = localStorage.getItem('onebar_api_host');
  if (stored) return stored.replace(/\/+$/, '');
  if (window.Capacitor?.isNativePlatform?.()) {
    return window.ONEBAR_API_BASE || '';
  }
  return '';
}

async function req(path, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const url = path.startsWith('http') ? path : `${getBaseUrl()}${path}`;
  try {
    const res = await fetch(url, {
      ...options,
      // Identifies the device, not the person: it is what lets the server show you
      // your own reports and refuse to let anyone else delete them.
      headers: { 'X-OneBar-Device': deviceId(), ...(options.headers || {}) },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      // The server returns a structured detail object for the cases the UI has to
      // render differently — outside coverage, unsupported mode, rate limited.
      const detail = body.detail;
      const error = new Error(
        (typeof detail === 'string' ? detail : detail?.detail) || `HTTP ${res.status}`
      );
      error.status = res.status;
      if (detail && typeof detail === 'object') error.detail = detail;
      throw error;
    }
    return await res.json();
  } catch (err) {
    // An error that already carries a status came *from the server*, so it must pass
    // through untouched. Rewriting it here — which the `!navigator.onLine` test did on
    // any network the OS considers unvalidated, such as a local mesh with a reachable
    // backend — stripped `.status` and `.detail`, and every caller downstream then read
    // a refusal as "you are offline": a rejected report was queued as pending, the user
    // was told it was saved, and it was retried on every reconnect for ever.
    if (err.status) throw err;
    if (err.name === 'AbortError') {
      throw new Error('Connection timed out (weak signal).');
    }
    if (err.message === 'Failed to fetch' || !navigator.onLine) {
      throw new Error('Offline — unable to reach server.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const json = (body) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Was this failure the network, or the server saying no?
 *
 * Only the former may degrade into a queued local write. A rejected request — a rate
 * limit, a malformed payload, a report the caller does not own — would otherwise be
 * stored as "pending" and replayed forever, and the user would be told their report
 * was saved when the server had refused it.
 */
const isConnectivityFailure = (err) => !err?.status;

/** Has this cached report passed the expiry the server gave it? */
function isStillCurrent(zone) {
  if (!zone?.expires_at) return true;
  const expires = Date.parse(zone.expires_at);
  return !Number.isFinite(expires) || expires > Date.now();
}

export const api = {
  health: () => req('/health'),
  region: () => req('/region'),

  hazards: {
    list: async () => {
      try {
        const serverData = await req('/hazards');
        if (serverData?.hazards) {
          // Reconcile, do not merge. Anything the server no longer lists has expired or
          // been retired; keeping the cached copy would leave a road blocked offline
          // that everybody else can already drive down.
          await replaceLocalHazards(serverData.hazards);
        }
        return serverData;
      } catch (err) {
        // Offline: fall back to the cache, minus anything that has since expired.
        // Expiry is the mechanism that stops a stale report blocking a road for ever,
        // and it has to apply offline too — offline is when it matters most.
        const local = (await getLocalHazards()).filter(isStillCurrent);
        return { hazards: local, total: local.length, is_offline_cache: true };
      }
    },

    get: (id) => req(`/hazards/${id}`),

    add: async ({ coordinates, center, radius_meters, buffer_meters = 0, name, hazard_type = 'closure', source, severity, description, share = false, ttl_hours = null }) => {
      const payload = {
        coordinates: coordinates || null,
        center: center || null,
        radius_meters: radius_meters || null,
        buffer_meters: buffer_meters || 0,
        name: name || null,
        hazard_type: hazard_type || 'closure',
        source: source || 'manual',
        severity: severity || 'moderate',
        description: description || null,
        // Unshared reports stay on this device and only affect this device's routing.
        share: Boolean(share),
        ttl_hours,
      };

      try {
        const zone = await req('/hazards', { method: 'POST', ...json(payload) });
        await saveLocalHazard(zone, 'synced');
        return zone;
      } catch (err) {
        if (!isConnectivityFailure(err)) throw err;
        // Offline: keep the report on this device and queue it for upload. It is
        // marked pending so the UI can say so rather than claiming it was filed.
        const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const localZone = {
          hazard_id: localId,
          name: name || 'Offline Hazard',
          hazard_type,
          coordinates: coordinates || generateLocalCircleCoords(center, radius_meters || 100),
          center,
          radius_meters,
          buffer_meters,
          source: source || 'manual',
          severity: severity || 'moderate',
          description,
          created_at: new Date().toISOString(),
          visibility: share ? 'shared' : 'private',
          provenance: share ? 'community' : 'user',
          mine: true,
          is_offline_pending: true,
        };

        await saveLocalHazard(localZone, 'pending_add');
        // The queue entry remembers which placeholder it stands for, so replaying it
        // can remove the placeholder instead of leaving a permanent ghost beside the
        // real report.
        await queueMutation('add_hazard', { ...payload, __localId: localId });
        return localZone;
      }
    },

    remove: async (id) => {
      await removeLocalHazard(id);
      if (id.startsWith('local-')) {
        return { removed: true, hazard_id: id };
      }
      try {
        const res = await req(`/hazards/${id}`, { method: 'DELETE' });
        return res;
      } catch (err) {
        if (!isConnectivityFailure(err)) throw err;
        await queueMutation('delete_hazard', { hazard_id: id });
        return { removed: true, hazard_id: id, queued: true };
      }
    },

    clear: () => req('/hazards', { method: 'DELETE' }),

    /** Retire every simulated hazard. Drill data has no reporter to own it. */
    clearDrill: () => req('/hazards/drill', { method: 'DELETE' }),

    confirm: (id) => req(`/hazards/${id}/confirm`, { method: 'POST' }),
    deny: (id) => req(`/hazards/${id}/deny`, { method: 'POST' }),

    syncApi: async ({ center = null, radius_km = 15.0, sources = ['nws', 'usgs', 'eonet'], clear_existing = false, drill_mode = false } = {}) => {
      const payload = { center, radius_km, sources, clear_existing, drill_mode };
      return req('/hazards/sync-api', {
        method: 'POST',
        ...json(payload),
      });
    },
  },

  safeHavens: {
    list: () => req('/safe-havens'),
    add: (data) => req('/safe-havens', { method: 'POST', ...json(data) }),
  },

  /** Destination search. Offline map hits come back first and are marked as such. */
  geocode: (q, { lat = null, lon = null, limit = 8 } = {}) => {
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (lat !== null && lon !== null) {
      params.set('lat', String(lat));
      params.set('lon', String(lon));
    }
    return req(`/geocode?${params.toString()}`);
  },

  reverseGeocode: (lat, lon) =>
    req(`/geocode/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`),

  route: (origin, dest, mode = 'drive', fallback = true) =>
    req('/route', {
      method: 'POST',
      ...json({
        origin,
        destination: dest,
        mode,
        encode_polyline: false,
        allow_penalty_fallback: fallback,
      }),
    }),

  routeSafety: (origin, mode = 'drive', target_type = 'all', fallback = true) =>
    req('/route/safety', {
      method: 'POST',
      ...json({
        origin,
        mode,
        target_type,
        encode_polyline: false,
        allow_penalty_fallback: fallback,
      }),
    }),

  /** How many offline writes are still waiting to upload. */
  pendingCount: () => pendingMutationCount(),

  // Replay queued offline mutations
  syncPending: async () => {
    const mutations = await getPendingMutations();
    if (!mutations.length) return 0;

    let synced = 0;
    for (const m of mutations) {
      try {
        if (m.action === 'add_hazard') {
          const { __localId, ...payload } = m.payload;
          const zone = await req('/hazards', { method: 'POST', ...json(payload) });
          await saveLocalHazard(zone, 'synced');
          // The server assigned a real id; the placeholder must go, or the map shows
          // the same hazard twice and one of the two can never be deleted.
          if (__localId) await removeLocalHazard(__localId);
          await clearMutation(m.id);
          synced++;
        } else if (m.action === 'delete_hazard') {
          await req(`/hazards/${m.payload.hazard_id}`, { method: 'DELETE' });
          await clearMutation(m.id);
          synced++;
        }
      } catch (err) {
        // A refusal will be refused again every time. Drop it rather than retrying it
        // on every reconnect for the life of the install; a rate limit (429) is the
        // one rejection that genuinely is worth retrying.
        if (err.status && err.status !== 429) {
          console.warn('Sync item rejected by server, discarding:', err.message);
          // Drop the placeholder too. Leaving it behind would keep telling the user
          // their report is queued to upload when the server has already refused it.
          if (m.payload?.__localId) await removeLocalHazard(m.payload.__localId);
          await clearMutation(m.id);
        } else {
          console.warn('Sync item failed, will retry later:', err);
        }
      }
    }
    return synced;
  },
};

function generateLocalCircleCoords(center, radiusMeters) {
  if (!center) return [];
  const coords = [];
  const R = 6371000.0;
  const numPoints = 24;
  for (let i = 0; i < numPoints; i++) {
    const angle = (2 * Math.PI * i) / numPoints;
    const dx = radiusMeters * Math.cos(angle);
    const dy = radiusMeters * Math.sin(angle);
    const dLat = (dy / R) * (180.0 / Math.PI);
    const dLon = (dx / (R * Math.cos((center.lat * Math.PI) / 180))) * (180.0 / Math.PI);
    coords.push({ lat: center.lat + dLat, lon: center.lon + dLon });
  }
  return coords;
}
