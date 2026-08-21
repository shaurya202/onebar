// Download, persist and load offline region packs.
//
// Storage choice: Capacitor Filesystem on native, IndexedDB on the web. Android will
// evict IndexedDB under storage pressure, and an evacuation map that silently
// disappears the week you need it is worse than one that was never downloaded — so on
// device the pack goes to real files.

import { apiBaseUrl } from './api.js';

const DB_NAME = 'onebar_packs_db';
const DB_VERSION = 1;
const STORE = 'packs';
const META_KEY = 'onebar_installed_packs';

let dbInstance = null;

function isNative() {
  return typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.();
}

async function getDB() {
  if (dbInstance) return dbInstance;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'regionId' });
      }
    };
    request.onsuccess = (e) => { dbInstance = e.target.result; resolve(dbInstance); };
    request.onerror = (e) => reject(e);
  });
}

function readInstalled() {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeInstalled(entries) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(entries));
  } catch (err) {
    console.warn('Could not record installed packs:', err);
  }
}

export function installedPacks() {
  return readInstalled();
}

export function packForLocation(lat, lon) {
  return readInstalled().find((p) => {
    const b = p.bounds;
    return b && lat >= b.min_lat && lat <= b.max_lat && lon >= b.min_lon && lon <= b.max_lon;
  }) || null;
}

/**
 * Fetch the catalogue of region packs available from the server.
 * Requires connectivity — downloading coverage is inherently an online action, which
 * is exactly why the app must prompt for it before an emergency rather than during one.
 */
export async function fetchCatalogue(baseUrl = null) {
  // Defaults to the same backend every other request uses. Hardcoding '' meant a
  // packaged native build asked its own capacitor:// origin for the catalogue and could
  // never install a pack at all — so the one feature that makes the app work offline
  // was unreachable on the platform it is built for.
  const base = baseUrl ?? apiBaseUrl();
  const res = await fetch(`${base}/packs/index.json`);
  if (!res.ok) throw new Error(`Could not load region catalogue (HTTP ${res.status})`);
  return res.json();
}

/**
 * Download a region pack, reporting progress so a multi-megabyte download over a weak
 * link shows real feedback rather than an indefinite spinner.
 */
export async function downloadPack(region, { baseUrl = null, onProgress = null } = {}) {
  const base = baseUrl ?? apiBaseUrl();
  const res = await fetch(`${base}/packs/${region.id}.obp`);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);

  const total = Number(res.headers.get('content-length')) || region.bytes || 0;
  let buffer;

  if (res.body && onProgress) {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(received, total);
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
    buffer = merged.buffer;
  } else {
    buffer = await res.arrayBuffer();
  }

  await savePack(region, buffer);
  return buffer;
}

async function savePack(region, buffer) {
  if (isNative()) {
    const { Filesystem, Directory } = window.Capacitor.Plugins;
    const base64 = arrayBufferToBase64(buffer);
    await Filesystem.writeFile({
      path: `packs/${region.id}.obp`,
      data: base64,
      directory: Directory.Data,
      recursive: true,
    });
  } else {
    const db = await getDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE], 'readwrite');
      tx.objectStore(STORE).put({ regionId: region.id, buffer });
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
  }

  const entries = readInstalled().filter((p) => p.id !== region.id);
  entries.push({
    id: region.id,
    name: region.name,
    bounds: region.bounds,
    bytes: region.bytes,
    sha256: region.sha256,
    installedAt: new Date().toISOString(),
  });
  writeInstalled(entries);
}

export async function loadPackBuffer(regionId) {
  if (isNative()) {
    const { Filesystem, Directory } = window.Capacitor.Plugins;
    const file = await Filesystem.readFile({
      path: `packs/${regionId}.obp`,
      directory: Directory.Data,
    });
    return base64ToArrayBuffer(file.data);
  }
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE], 'readonly');
    const req = tx.objectStore(STORE).get(regionId);
    req.onsuccess = () => resolve(req.result ? req.result.buffer : null);
    req.onerror = reject;
  });
}

export async function deletePack(regionId) {
  if (isNative()) {
    const { Filesystem, Directory } = window.Capacitor.Plugins;
    await Filesystem.deleteFile({ path: `packs/${regionId}.obp`, directory: Directory.Data })
      .catch(() => {});
  } else {
    const db = await getDB();
    await new Promise((resolve) => {
      const tx = db.transaction([STORE], 'readwrite');
      tx.objectStore(STORE).delete(regionId);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }
  writeInstalled(readInstalled().filter((p) => p.id !== regionId));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
