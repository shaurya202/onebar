// IndexedDB Local Storage & Offline Sync Queue for OneBar

const DB_NAME = 'onebar_offline_db';
const DB_VERSION = 1;
const STORE_HAZARDS = 'hazards';
const STORE_MUTATIONS = 'mutations';

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
    };

    request.onsuccess = (e) => {
      dbInstance = e.target.result;
      resolve(dbInstance);
    };

    request.onerror = (e) => {
      console.warn('IndexedDB failed to open:', e);
      reject(e);
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
