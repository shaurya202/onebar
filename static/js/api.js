import {
  saveLocalHazard,
  getLocalHazards,
  removeLocalHazard,
  queueMutation,
  getPendingMutations,
  clearMutation,
} from './offline-store.js';

const TIMEOUT_MS = 10000;

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
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      throw new Error(body.detail || `HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
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

export const api = {
  health: () => req('/health'),
  region: () => req('/region'),

  hazards: {
    list: async () => {
      try {
        const serverData = await req('/hazards');
        if (serverData?.hazards) {
          for (const h of serverData.hazards) {
            await saveLocalHazard(h, 'synced');
          }
        }
        return serverData;
      } catch (err) {
        // Fallback to locally stored hazards from IndexedDB
        const local = await getLocalHazards();
        return { hazards: local, total: local.length, is_offline_cache: true };
      }
    },

    get: (id) => req(`/hazards/${id}`),

    add: async ({ coordinates, center, radius_meters, buffer_meters = 0, name, hazard_type = 'closure', source, severity, description }) => {
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
      };

      try {
        const zone = await req('/hazards', { method: 'POST', ...json(payload) });
        await saveLocalHazard(zone, 'synced');
        return zone;
      } catch (err) {
        // Generate simulated local zone and queue for sync when back online
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
          is_offline_pending: true,
        };

        await saveLocalHazard(localZone, 'pending_add');
        await queueMutation('add_hazard', payload);
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
        await queueMutation('delete_hazard', { hazard_id: id });
        return { removed: true, hazard_id: id, queued: true };
      }
    },

    clear: () => req('/hazards', { method: 'DELETE' }),

    syncApi: async ({ center = null, radius_km = 15.0, sources = ['nws', 'usgs', 'eonet', 'simulation'], clear_existing = false } = {}) => {
      const payload = { center, radius_km, sources, clear_existing };
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

  // Replay queued offline mutations
  syncPending: async () => {
    const mutations = await getPendingMutations();
    if (!mutations.length) return 0;

    let synced = 0;
    for (const m of mutations) {
      try {
        if (m.action === 'add_hazard') {
          const zone = await req('/hazards', { method: 'POST', ...json(m.payload) });
          await saveLocalHazard(zone, 'synced');
          await clearMutation(m.id);
          synced++;
        } else if (m.action === 'delete_hazard') {
          await req(`/hazards/${m.payload.hazard_id}`, { method: 'DELETE' });
          await clearMutation(m.id);
          synced++;
        }
      } catch (err) {
        console.warn('Sync item failed, will retry later:', err);
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
