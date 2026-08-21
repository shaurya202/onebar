// IndexedDB Local Storage & Offline Sync Queue for OneBar

const DB_NAME = 'onebar_offline_db';
const DB_VERSION = 2;
const STORE_HAZARDS = 'hazards';
const STORE_MUTATIONS = 'mutations';
// Version 2 adds `trips`: origin, destination, mode and the computed route, so an app
// kill part-way through an evacuation does not lose the route the user is following.
const STORE_TRIPS = 'trips';

let dbInstance = null;

export async function getDB() {
  if (dbInstance) return dbInstance;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_HAZARDS)) {
        db.createObjectStore(STORE_HAZARDS, { keyPath: 'hazard_id' });
      }
      if (!db.objectStoreNames.contains(STORE_MUTATIONS)) {
        db.createObjectStore(STORE_MUTATIONS, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_TRIPS)) {
        db.createObjectStore(STORE_TRIPS, { keyPath: 'id' });
      }
    };

    request.onsuccess = (e) => {
      dbInstance = e.target.result;
      resolve(dbInstance);
    };

    request.onerror = (e) => {
      console.warn('IndexedDB failed to open:', e);
      reject(e);
    };

    // Another tab holding the old schema open blocks the upgrade indefinitely. The
    // promise would then never settle and every caller awaiting it would hang — so
    // fail fast instead, and let each caller's own try/catch degrade gracefully.
    request.onblocked = () => {
      reject(new Error('Offline storage is open in another tab and cannot be upgraded.'));
    };
  });
}

export async function saveLocalHazard(zone, syncStatus = 'synced') {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_HAZARDS], 'readwrite');
    const store = tx.objectStore(STORE_HAZARDS);
    const item = { ...zone, _syncStatus: syncStatus };
    store.put(item);
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve(item);
      tx.onerror = () => resolve(zone);
    });
  } catch (err) {
    console.warn('Error saving local hazard:', err);
    return zone;
  }
}

export async function getLocalHazards() {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_HAZARDS], 'readonly');
    const store = tx.objectStore(STORE_HAZARDS);
    const req = store.getAll();
    return new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

/**
 * Replace the cached hazard set with what the server just returned.
 *
 * Merging instead of replacing meant anything the server had expired or retired stayed
 * in the cache for ever and kept blocking roads the moment the app went offline.
 */
export async function replaceLocalHazards(zones) {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_HAZARDS], 'readwrite');
    const store = tx.objectStore(STORE_HAZARDS);
    const keep = new Set(zones.map((z) => z.hazard_id));

    const existing = store.getAll();
    existing.onsuccess = () => {
      for (const item of existing.result || []) {
        // Reports still queued for upload are ours and are not in the server's answer
        // yet; dropping them would lose the user's own unsent work.
        if (item._syncStatus === 'pending_add') continue;
        if (!keep.has(item.hazard_id)) store.delete(item.hazard_id);
      }
      for (const zone of zones) store.put({ ...zone, _syncStatus: 'synced' });
    };

    return new Promise((resolve) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (err) {
    console.warn('Could not reconcile local hazards:', err);
    return false;
  }
}

export async function removeLocalHazard(hazardId) {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_HAZARDS], 'readwrite');
    const store = tx.objectStore(STORE_HAZARDS);
    store.delete(hazardId);
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

export async function queueMutation(action, payload) {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_MUTATIONS], 'readwrite');
    const store = tx.objectStore(STORE_MUTATIONS);
    store.add({ action, payload, createdAt: new Date().toISOString() });
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (err) {
    console.warn('Queue mutation failed:', err);
    return false;
  }
}

export async function getPendingMutations() {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_MUTATIONS], 'readonly');
    const store = tx.objectStore(STORE_MUTATIONS);
    const req = store.getAll();
    return new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function clearMutation(id) {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_MUTATIONS], 'readwrite');
    const store = tx.objectStore(STORE_MUTATIONS);
    store.delete(id);
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}


// --- Trip persistence -------------------------------------------------------
//
// One record, overwritten. There is only ever one journey in progress, and keeping a
// history of where somebody evacuated to is data OneBar has no reason to hold.

const CURRENT_TRIP_ID = 'current';

export async function putTrip(trip) {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_TRIPS], 'readwrite');
    tx.objectStore(STORE_TRIPS).put({ ...trip, id: CURRENT_TRIP_ID });
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

export async function getTrip() {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_TRIPS], 'readonly');
    const req = tx.objectStore(STORE_TRIPS).get(CURRENT_TRIP_ID);
    return new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function deleteTrip() {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_TRIPS], 'readwrite');
    tx.objectStore(STORE_TRIPS).delete(CURRENT_TRIP_ID);
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

/** How many offline writes are still waiting to upload. */
export async function pendingMutationCount() {
  return (await getPendingMutations()).length;
}
