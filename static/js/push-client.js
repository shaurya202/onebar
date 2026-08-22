// Web Push subscription management for nearby-hazard alerts.
//
// The server never learns who the user is — it receives the browser's opaque push
// endpoint, encryption keys and a rectangle to watch, all attributed to the same
// hashed device identity as hazard reports. The watched rectangle is centred on
// the position at subscribe time and re-centred as the device moves, so alerts
// follow the person rather than freezing where they first consented.

import { api } from './api.js';

const WATCH_KEY = 'onebar_push_watch';
const WATCH_RADIUS_KM = 10;
// Re-centre only after meaningful movement; each refresh is a write to the server.
const WATCH_REFRESH_KM = 2;
const WATCH_REFRESH_MIN_MS = 60_000;

let lastWatchRefresh = 0;

export function pushAvailable() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in window
    && 'PushManager' in window
    && 'Notification' in window;
}

function serviceWorkerRegistration() {
  return navigator.serviceWorker.ready;
}

// The applicationServerKey arrives as base64url; subscribe() wants raw bytes.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

function watchAreaAround(lat, lon, radiusKm = WATCH_RADIUS_KM) {
  const dLat = radiusKm / 110.574;
  const dLon = radiusKm / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return { min_lat: lat - dLat, max_lat: lat + dLat, min_lon: lon - dLon, max_lon: lon + dLon };
}

function rememberWatch(area) {
  try { localStorage.setItem(WATCH_KEY, JSON.stringify(area)); } catch { /* ignore */ }
}

function lastWatch() {
  try {
    const area = JSON.parse(localStorage.getItem(WATCH_KEY));
    return area && Number.isFinite(area.min_lat) ? area : null;
  } catch {
    return null;
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export async function pushState() {
  if (!pushAvailable()) {
    return { supported: false, permission: 'unsupported', subscribed: false };
  }
  let subscribed = false;
  try {
    const reg = await serviceWorkerRegistration();
    subscribed = Boolean(await reg.pushManager.getSubscription());
  } catch { /* treated as unsubscribed */ }
  return { supported: true, permission: Notification.permission, subscribed };
}

export async function enableHazardAlerts(position) {
  if (!pushAvailable()) {
    throw new Error('Push notifications are not available on this device.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }

  const config = await api.push.config();
  if (!config?.enabled || !config.public_key) {
    throw new Error('This OneBar service does not offer hazard alerts.');
  }

  const reg = await serviceWorkerRegistration();
  const existing = await reg.pushManager.getSubscription();
  const subscription = existing || await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.public_key),
  });

  const keys = subscription.toJSON()?.keys || {};
  if (!keys.p256dh || !keys.auth) {
    throw new Error('The browser did not provide push keys.');
  }

  const area = (position && Number.isFinite(position.lat))
    ? watchAreaAround(position.lat, position.lon)
    : lastWatch();
  await api.push.subscribe({
    endpoint: subscription.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    watch_area: area,
  });
  if (area) rememberWatch(area);
  lastWatchRefresh = Date.now();
  return true;
}

export async function disableHazardAlerts() {
  if (!pushAvailable()) return false;
  const reg = await serviceWorkerRegistration();
  const subscription = await reg.pushManager.getSubscription();
  if (!subscription) return false;
  try {
    // Remove the server copy first: if the browser-side unsubscribe then fails we
    // err on the side of fewer wake-ups, never more.
    await api.push.unsubscribe(subscription.endpoint);
  } catch { /* the server copy may already be gone */ }
  await subscription.unsubscribe();
  try { localStorage.removeItem(WATCH_KEY); } catch { /* ignore */ }
  return true;
}

/**
 * Re-centre the watched rectangle as the device moves.
 *
 * Called from the GPS handler on every fix; it exits within microseconds unless
 * enough time *and* distance have accumulated, so callers need no throttling of
 * their own.
 */
export async function refreshWatchArea(lat, lon) {
  const now = Date.now();
  if (now - lastWatchRefresh < WATCH_REFRESH_MIN_MS) return;

  const area = lastWatch();
  if (!area) return;
  const centreLat = (area.min_lat + area.max_lat) / 2;
  const centreLon = (area.min_lon + area.max_lon) / 2;
  if (haversineKm(centreLat, centreLon, lat, lon) < WATCH_REFRESH_KM) {
    lastWatchRefresh = now;
    return;
  }

  try {
    const reg = await serviceWorkerRegistration();
    const subscription = await reg.pushManager.getSubscription();
    const keys = subscription?.toJSON()?.keys;
    if (!subscription || !keys?.p256dh || !keys?.auth) return;

    const next = watchAreaAround(lat, lon);
    await api.push.subscribe({
      endpoint: subscription.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      watch_area: next,
    });
    rememberWatch(next);
    lastWatchRefresh = now;
  } catch { /* alerts keep working with the previous area */ }
}
