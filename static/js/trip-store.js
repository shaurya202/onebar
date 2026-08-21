// Trip persistence.
//
// `origin`, `dest`, `travelMode`, `currentRouteData` and `activeDestinationHaven` lived
// in module-level variables and nowhere else, so an app kill part-way through an
// evacuation — which is exactly what a low-battery phone does — lost the route, the
// destination and the turn list with no way back except recomputing from scratch, with
// no signal.
//
// A restored route is deliberately *not* treated as current. Hazards move; a route
// computed twenty minutes ago may now run through one. The app restores it so the user
// can see where they were going, and says plainly how old it is.

import { deleteTrip, getTrip, putTrip } from './offline-store.js';

// Older than this and a saved route is scenery, not guidance.
export const MAX_TRIP_AGE_MS = 6 * 60 * 60 * 1000;

let writeTimer = null;
let queued = null;

/** Persist the journey. Coalesced, because route recomputes can arrive in bursts. */
export function saveTrip(trip) {
  queued = { ...trip, savedAt: new Date().toISOString() };
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const payload = queued;
    queued = null;
    if (payload) putTrip(payload);
  }, 400);
}

/** Write immediately — used on pagehide, where a timer will not fire. */
export function flushTrip() {
  clearTimeout(writeTimer);
  if (queued) {
    const payload = queued;
    queued = null;
    return putTrip(payload);
  }
  return Promise.resolve(false);
}

export async function loadTrip() {
  const trip = await getTrip();
  if (!trip) return null;

  const savedAt = Date.parse(trip.savedAt || '');
  if (!Number.isFinite(savedAt)) return null;

  const ageMs = Date.now() - savedAt;
  if (ageMs > MAX_TRIP_AGE_MS) {
    await deleteTrip();
    return null;
  }
  return { ...trip, ageMs };
}

export async function clearTrip() {
  clearTimeout(writeTimer);
  queued = null;
  await deleteTrip();
}

export function describeAge(ageMs) {
  const minutes = Math.round(ageMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}
