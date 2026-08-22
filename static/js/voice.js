// Voice turn-by-turn prompts over the platform speech engine (system voices, no
// network). Progress is tracked by projecting each GPS fix onto the route
// polyline and advancing monotonically, so skipped or jumpy fixes cannot strand
// the scheduler on an already-passed turn. The core is injectable and pure
// enough for tools/client_tests.mjs to exercise without a browser.

const STORAGE_KEY = 'onebar_voice_guidance';

// Distance bands ahead of a maneuver that trigger one spoken prompt each, most
// urgent last. Inside the last band the bare instruction is spoken.
const ANNOUNCE_BANDS = [400, 150, 60];

const ARRIVE_RADIUS_M = 25;

// Fixes landing farther than this from the route are treated as noise or
// detours: they neither advance nor rewind guidance.
const OFF_ROUTE_M = 120;

export function voiceSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function readVoiceSetting() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeVoiceSetting(enabled) {
  try {
    localStorage.setItem(STORAGE_KEY, String(Boolean(enabled)));
  } catch { /* ignore */ }
}

function speakViaBrowser(text) {
  if (!voiceSupported()) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = navigator.language || 'en-US';
    utterance.rate = 1.0;
    window.speechSynthesis.speak(utterance);
  } catch { /* speech is a convenience, never a failure */ }
}

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(a));
}

export function formatSpokenDistance(metres) {
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)} kilometres`;
  return `${Math.max(20, Math.round(metres / 10) * 10)} metres`;
}

// Projection of a fix onto one segment, in local-metre space (fine at the
// sub-kilometre legs a maneuver spans; avoids full spherical algebra).
export function projectOnSegment(lat, lon, aLat, aLon, bLat, bLon) {
  const cosMid = Math.cos(((lat + aLat + bLat) / 3) * (Math.PI / 180));
  const ax = aLon * 111320 * cosMid;
  const ay = aLat * 111320;
  const bx = bLon * 111320 * cosMid;
  const by = bLat * 111320;
  const px = lon * 111320 * cosMid;
  const py = lat * 111320;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const ex = px - (ax + t * dx);
  const ey = py - (ay + t * dy);
  return { t, distanceMeters: Math.sqrt(ex * ex + ey * ey) };
}

export function createVoiceGuide({ speak = speakViaBrowser, isEnabled = () => true } = {}) {
  let maneuvers = [];
  let points = [];
  let cum = [];          // cumulative metres along the route at each vertex
  let index = 0;         // maneuver currently being approached
  let progress = 0;      // metres travelled along the route, monotonic
  let active = false;
  const announced = new Set();

  function reset() {
    maneuvers = [];
    points = [];
    cum = [];
    index = 0;
    progress = 0;
    active = false;
    announced.clear();
  }

  function rebuildTrack(list) {
    points = list.map((m) => m.location).filter(Boolean);
    cum = [0];
    for (let k = 1; k < points.length; k += 1) {
      cum[k] = cum[k - 1]
        + haversineMeters(points[k - 1].lat, points[k - 1].lon, points[k].lat, points[k].lon);
    }
  }

  // Best fit among the current segment and the one after (never behind: progress
  // is monotonic, so an earlier segment can only be a worse match).
  function locateOnRoute(lat, lon) {
    let best = null;
    for (let k = Math.max(0, index - 1); k < points.length - 1; k += 1) {
      const hit = projectOnSegment(
        lat, lon,
        points[k].lat, points[k].lon,
        points[k + 1].lat, points[k + 1].lon,
      );
      if (!best || hit.distanceMeters < best.distanceMeters) {
        best = { ...hit, segment: k };
      }
    }
    return best;
  }

  function announceFor(i, remainingRaw) {
    const current = maneuvers[i];
    // Well past a turn (or a stale jump far beyond it) — nothing worth saying.
    if (!current || remainingRaw < -ARRIVE_RADIUS_M) return null;
    const remaining = Math.max(0, remainingRaw);

    const lastBand = ANNOUNCE_BANDS[ANNOUNCE_BANDS.length - 1];
    if (remaining <= lastBand) {
      for (const band of ANNOUNCE_BANDS) announced.add(`${i}:${band}`);
      return `${current.instruction}.`;
    }
    for (const band of ANNOUNCE_BANDS.slice(0, -1)) {
      if (remaining <= band && !announced.has(`${i}:${band}`)) {
        announced.add(`${i}:${band}`);
        return `In ${formatSpokenDistance(remaining)}, ${current.instruction}.`;
      }
    }
    return null;
  }

  // Every announcement goes out through speak(); the text is also returned so
  // callers can mirror what was said into the UI.
  function say(text) {
    speak(text);
    return text;
  }

  function promptFor(lat, lon) {
    if (!active || !isEnabled()) return null;

    if (points.length < 2) {
      const only = points[0] ?? maneuvers[0]?.location;
      if (only && haversineMeters(lat, lon, only.lat, only.lon) < ARRIVE_RADIUS_M) {
        reset();
        return say('You have arrived at your evacuation destination.');
      }
      return null;
    }

    const fix = locateOnRoute(lat, lon);
    if (!fix || fix.distanceMeters > OFF_ROUTE_M) return null;

    const raw = cum[fix.segment] + fix.t * (cum[fix.segment + 1] - cum[fix.segment]);
    progress = Math.max(progress, raw);

    const remainingRaw = cum[Math.min(index, cum.length - 1)] - progress;

    if (index === points.length - 1 && remainingRaw <= ARRIVE_RADIUS_M) {
      reset();
      return say('You have arrived at your evacuation destination.');
    }

    const prompt = announceFor(index, remainingRaw);
    if (prompt) return say(prompt);

    while (index < points.length - 1 && progress >= cum[index]) {
      index += 1;
    }
    return null;
  }

  return {
    route(nextManeuvers) {
      const list = Array.isArray(nextManeuvers) ? nextManeuvers : [];
      if (!isEnabled() || list.length === 0) {
        reset();
        return;
      }
      const wasActive = active;
      maneuvers = list;
      rebuildTrack(list);
      index = 0;
      progress = 0;
      announced.clear();
      active = true;
      const first = list[0];
      speak(wasActive ? `Rerouting. ${first.instruction}.` : `Route started. ${first.instruction}.`);
    },

    onPosition(lat, lon) {
      return promptFor(lat, lon);
    },

    stop() {
      if (active) speak('Navigation ended.');
      reset();
    },
  };
}

export const voiceGuide = createVoiceGuide({ isEnabled: () => voiceSupported() && readVoiceSetting() });
