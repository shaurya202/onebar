// Boot the real frontend in jsdom and report anything that goes wrong.
//
// `static/js/app.js` runs a large amount of code at module load — it wires ~90 DOM
// elements, starts the connectivity poll and opens the first-run flow — so a renamed
// id or a missing element is a blank screen, not a caught exception. Nothing in the
// repo caught that class of mistake, because `static/` ships verbatim with no build
// step to fail. This is the check that does.
//
// Usage:  node tools/boot_check.mjs [--onboarded]

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createFakeIndexedDB } from './fake_idb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const onboarded = process.argv.includes('--onboarded');
// With --online the harness answers requests from a canned API, so the route flow can
// be driven end to end. Without it every request fails, which exercises the offline
// degradation paths instead. Both are worth running.
const online = process.argv.includes('--online');
// With --pack the harness pretends a region pack is installed and answers the routing
// worker itself, so the client-authoritative claim can be checked: with coverage on the
// device, routing must not touch the network.
const withPack = process.argv.includes('--pack');
// With --storage the harness provides a working IndexedDB instead of one that throws,
// so the trip, hazard-cache and pack-storage paths are exercised rather than skipped.
const withStorage = withPack || process.argv.includes('--storage');

const problems = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => problems.push(`jsdomError: ${err.message}`));
virtualConsole.on('error', (...args) => problems.push(`console.error: ${args.join(' ')}`));

const html = await readFile(path.join(ROOT, 'static', 'index.html'), 'utf-8');

const dom = new JSDOM(html, {
  url: 'http://localhost:8000/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;

// --- the browser surfaces app.js expects and jsdom does not provide ----------

const storage = new Map();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
});
if (onboarded) storage.set('onebar_safety_ack_v1', '1');

window.indexedDB = withStorage
  ? createFakeIndexedDB()
  : {
    // Every offline-store call is wrapped in try/catch and degrades to "nothing
    // stored", which is itself behaviour worth exercising.
    open: () => { throw new Error('IndexedDB unavailable in this harness'); },
  };

// Stands in for static/js/router-worker.js. The engine it hosts is covered directly by
// tests/test_route_parity.py; what matters here is that app.js reaches for it at all.
const workerCalls = [];
window.Worker = class {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
  }

  postMessage(message) {
    const { id, type, payload } = message;
    workerCalls.push({ type, payload });
    queueMicrotask(() => {
      if (type === 'load') {
        this.onmessage?.({ data: { id, ok: true, result: {
          regionId: payload.regionId, nodeCount: 1296, edgeCount: 3507,
          bounds: { minLat: 40.705087, minLon: -74.015501, maxLat: 40.711904, maxLon: -74.006493 },
          havens: [FIXTURE_HAVEN_STUB],
        } } });
      } else if (type === 'route') {
        this.onmessage?.({ data: { id, ok: true, result: {
          ...OFFLINE_ROUTE,
          destination: payload.destinations[0],
        } } });
      } else if (type === 'search') {
        this.onmessage?.({ data: { id, ok: true, result: [] } });
      } else {
        this.onmessage?.({ data: { id, ok: false, error: `unknown command ${type}` } });
      }
    });
  }

  terminate() {}
};
// A canned API. Values match the shapes app/schemas.py produces, so the frontend is
// exercised against the contract it actually ships against rather than a guess.
const FIXTURE_HAVEN_STUB = {
  id: 'haven-osm-node-1', name: 'Fulton Street Assembly Point', type: 'assembly_point',
  location: { lat: 40.7105, lon: -74.0083 }, verified: false, reachable: true,
  is_compromised: false, provenance: 'official', visibility: 'shared',
};
const OFFLINE_ROUTE = {
  success: true, engine: 'offline',
  coordinates: [{ lat: 40.7070, lon: -74.0140 }, { lat: 40.7105, lon: -74.0083 }],
  total_travel_time_seconds: 410.0, total_distance_meters: 1290.0,
  blocked_edges_avoided: 0, is_fallback: false, warning: null,
  maneuvers: [
    { type: 'depart', instruction: 'Head north on Greenwich Street', distance_meters: 500,
      travel_time_seconds: 160, location: { lat: 40.7070, lon: -74.0140 } },
    { type: 'arrive', instruction: 'Arrive at Fulton Street Assembly Point', distance_meters: 0,
      travel_time_seconds: 0, location: { lat: 40.7105, lon: -74.0083 } },
  ],
};
if (withPack) {
  // A pack the client has downloaded: both the catalogue entry it reads from
  // localStorage *and* the bytes it reads from storage. Seeding only the metadata
  // makes `loadPackBuffer` return null and the app correctly falls back to the
  // server — which is right behaviour, and not what this scenario is testing.
  storage.set('onebar_installed_packs', JSON.stringify([{
    id: 'test-region',
    name: 'Test Region',
    bytes: 83394,
    bounds: { min_lat: 40.705087, max_lat: 40.711904, min_lon: -74.015501, max_lon: -74.006493 },
    installedAt: new Date(0).toISOString(),
  }]));

  const packBytes = await readFile(path.join(ROOT, 'tests', 'fixtures', 'packs', 'test-region.obp'));
  await new Promise((resolve, reject) => {
    const open = window.indexedDB.open('onebar_packs_db', 1);
    open.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('packs')) {
        db.createObjectStore('packs', { keyPath: 'regionId' });
      }
    };
    open.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction(['packs'], 'readwrite');
      tx.objectStore('packs').put({
        regionId: 'test-region',
        buffer: packBytes.buffer.slice(
          packBytes.byteOffset, packBytes.byteOffset + packBytes.byteLength,
        ),
      });
      tx.oncomplete = resolve;
      tx.onerror = reject;
    };
    open.onerror = reject;
  });
}

const FIXTURE_HAVEN = {
  id: 'haven-osm-node-1', name: 'Fulton Street Assembly Point', type: 'assembly_point',
  location: { lat: 40.7105, lon: -74.0083 }, address: '1 Fulton St', capacity: null,
  is_compromised: false, compromised_reason: null, provenance: 'official',
  source_url: 'https://www.openstreetmap.org/node/1', osm_id: 'node/1',
  verified: false, reachable: true,
};
const FIXTURE_ROUTE = {
  success: true,
  coordinates: [{ lat: 40.7070, lon: -74.0140 }, { lat: 40.7090, lon: -74.0110 }, { lat: 40.7105, lon: -74.0083 }],
  polyline: null, total_travel_time_seconds: 372.5, total_distance_meters: 1180.0,
  blocked_edges_avoided: 3, is_fallback: false, warning: null,
  maneuvers: [
    { type: 'depart', instruction: 'Head north on Greenwich Street', street_name: 'Greenwich Street',
      distance_meters: 420, travel_time_seconds: 130, location: { lat: 40.7070, lon: -74.0140 } },
    { type: 'turn_right', instruction: 'Turn right onto Fulton Street', street_name: 'Fulton Street',
      distance_meters: 760, travel_time_seconds: 242, location: { lat: 40.7090, lon: -74.0110 } },
    { type: 'arrive', instruction: 'Arrive at Fulton Street Assembly Point', street_name: null,
      distance_meters: 0, travel_time_seconds: 0, location: { lat: 40.7105, lon: -74.0083 } },
  ],
};
const cannedResponses = (pathname) => {
  if (pathname === '/health') return { status: 'ok', app: 'OneBar' };
  if (pathname === '/region') {
    return {
      place_name: 'Lower Manhattan, New York', node_count: 1296, edge_count: 3507,
      bounds: { min_lat: 40.705087, max_lat: 40.711904, min_lon: -74.015501, max_lon: -74.006493 },
      status: 'ready', drivable_edge_count: 2076, walkable_edge_count: 3487,
      supported_modes: ['drive', 'walk'],
    };
  }
  if (pathname === '/hazards') return { hazards: [], total: 0 };
  if (pathname === '/safe-havens') return { safe_havens: [FIXTURE_HAVEN], total: 1 };
  if (pathname === '/packs/index.json') return { regions: [] };
  if (pathname === '/geocode') {
    return {
      query: 'bro', attribution: 'Search results © OpenStreetMap contributors', message: null,
      results: [{
        name: 'Broadway', subtitle: 'Street in downloaded map',
        location: { lat: 40.707138, lon: -74.012243 }, kind: 'street',
        source: 'offline', in_coverage: true, distance_meters: 184.1,
      }],
    };
  }
  if (pathname === '/route' || pathname === '/route/safety') {
    return pathname === '/route'
      ? FIXTURE_ROUTE
      : { ...FIXTURE_ROUTE, destination_safe_haven: FIXTURE_HAVEN, alternatives: [] };
  }
  return null;
};

const requestLog = [];
window.fetch = async (input, init) => {
  const url = new URL(String(input), 'http://localhost:8000/');
  requestLog.push({ path: url.pathname, method: init?.method || 'GET', headers: init?.headers || {} });
  if (!online) throw new TypeError('Failed to fetch');
  const body = cannedResponses(url.pathname);
  if (body === null) {
    return { ok: false, status: 404, json: async () => ({ detail: 'Not found' }) };
  }
  return { ok: true, status: 200, json: async () => body };
};
window.navigator.serviceWorker = { register: async () => ({}) };
// The position callback is captured rather than fired, so the harness can test both
// the "GPS has not arrived yet" state and the state after a fix — which is how a real
// device behaves, and the two lead to very different correct behaviour.
let pushPosition = null;
window.navigator.geolocation = {
  watchPosition: (ok) => {
    pushPosition = (lat, lon) => ok({
      coords: { latitude: lat, longitude: lon, accuracy: 12, heading: null },
    });
    return 1;
  },
  getCurrentPosition: (_ok, fail) => fail?.({ code: 1 }),
};
window.navigator.vibrate = () => true;
const define = (target, key, value) => {
  try {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  } catch { /* some jsdom globals are getter-only and already usable */ }
};
define(window, 'matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
define(window, 'requestAnimationFrame', (cb) => setTimeout(() => cb(0), 0));
if (!window.performance) define(window, 'performance', { now: () => 0 });

// A Leaflet stand-in. The point of this harness is app.js's own wiring, not Leaflet —
// except for `bindPopup`, whose argument is the DOM node map.js builds for a hazard.
// That node is where another device's report text ends up, so it is captured.
const popupNodes = [];
const chainable = () => new Proxy(function noop() {}, {
  get: (_t, prop) => {
    if (prop === 'then') return undefined;
    if (prop === 'bindPopup') {
      return (node) => { popupNodes.push(node); return chainable(); };
    }
    return chainable();
  },
  apply: () => chainable(),
  construct: () => chainable(),
});
window.L = chainable();

// Route bare-ish module specifiers through the real files on disk.
const globals = ['document', 'location', 'navigator', 'localStorage', 'indexedDB',
  'Worker', 'fetch', 'L', 'matchMedia', 'requestAnimationFrame', 'performance',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'URLSearchParams',
  'AbortController', 'crypto', 'TextDecoder', 'CustomEvent', 'Event', 'HTMLElement'];
// These must come from the harness even though Node provides its own: `fetch` in
// particular, or api.js would reach Node's native fetch and try to open a real socket
// instead of hitting the canned API.
const FORCED = new Set(['document', 'location', 'navigator', 'fetch', 'localStorage', 'indexedDB', 'L']);
for (const key of globals) {
  if (key in globalThis && !FORCED.has(key)) continue;
  try {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: window[key] });
  } catch { /* some globals are locked down; the module will use window.<key> */ }
}
globalThis.window = window;

let bootError = null;
try {
  await import(pathToFileURL(path.join(ROOT, 'static', 'js', 'app.js')).href);
} catch (err) {
  bootError = `${err.name}: ${err.message}`;
}

// Let the queued microtasks and timers that boot kicks off actually run.
await new Promise((resolve) => setTimeout(resolve, 250));

// --- assertions on the booted page ------------------------------------------

const $ = (id) => window.document.getElementById(id);
const checks = [];
const check = (name, condition, detail = '') =>
  checks.push({ name, pass: Boolean(condition), detail: String(detail) });

check('app.js boots without throwing', bootError === null, bootError || '');
check('no console errors or uncaught jsdom errors', problems.length === 0, problems.join(' | '));

const welcome = $('welcome-modal');
if (onboarded) {
  check('a returning user is not shown the first-run flow', welcome?.classList.contains('hidden'));
  check('the map surface is present', Boolean($('map')));
} else {
  check('the first-run flow opens on a fresh install', !welcome?.classList.contains('hidden'));
  check('the first step is the one shown',
    window.document.querySelector('.onboarding-step[data-step="1"]')?.classList.contains('hidden') === false);
  check('later steps are hidden',
    window.document.querySelector('.onboarding-step[data-step="5"]')?.classList.contains('hidden') === true);
  check('the back button is hidden on the first step', $('btn-onboard-back')?.hidden === true);

  // Walk the flow the way a user would and make sure each step lands.
  const next = $('btn-onboard-next');
  for (let step = 2; step <= 5; step++) {
    next?.dispatchEvent(new window.Event('click'));
    const shown = window.document.querySelector(`.onboarding-step[data-step="${step}"]`);
    check(`step ${step} is reachable`, shown?.classList.contains('hidden') === false);
  }
  check('the last step offers to finish',
    next?.querySelector('span')?.textContent === 'Start using OneBar',
    next?.querySelector('span')?.textContent);
  next?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  check('finishing the flow closes it', welcome?.classList.contains('hidden'));
  check('finishing the flow is remembered', storage.get('onebar_safety_ack_v1') === '1');
}

// The search field is the thing that did not exist at all before.
const searchInput = $('search-input');
check('the search box is a real input', searchInput?.tagName === 'INPUT', searchInput?.tagName || 'missing');
check('the search results list starts hidden', $('search-results')?.classList.contains('hidden'));

if (searchInput) {
  searchInput.value = 'bro';
  searchInput.dispatchEvent(new window.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  check('typing opens the results list', !$('search-results')?.classList.contains('hidden'));
  check('the clear button appears once there is text', !$('btn-search-clear')?.classList.contains('hidden'));
}

// Connectivity is two indicators now, not one badge pretending to be signal bars.
check('device connectivity has its own indicator', Boolean($('connectivity-badge')));
check('service status has its own indicator', Boolean($('service-badge')));
check('the service indicator is not left blank',
  ($('service-text')?.textContent || '').trim().length > 0, $('service-text')?.textContent);

check('the drill banner is hidden with no drill data', $('drill-banner')?.classList.contains('hidden'));
check('the resume banner is hidden with no saved trip', $('resume-trip-banner')?.classList.contains('hidden'));

// --- dialogs: focus trapping, Escape, and focus restoration ------------------
//
// None of this existed. Dialogs were shown by removing a class, so focus stayed on
// the page behind and Tab walked straight out of the dialog into the map.

if (onboarded) {
  const sosButton = $('btn-sheet-sos');
  const sosModal = $('sos-modal');
  sosButton?.focus();
  sosButton?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 60));

  check('the SOS dialog opens', !sosModal?.classList.contains('hidden'));
  check('the SOS dialog is marked as modal', sosModal?.getAttribute('aria-modal') === 'true');
  check('focus moves into the dialog', sosModal?.contains(window.document.activeElement),
    window.document.activeElement?.id || window.document.activeElement?.tagName);
  check('the page behind is locked from scrolling',
    window.document.body.classList.contains('modal-open'));

  // Tab from the last focusable element must wrap to the first, not escape.
  const focusables = Array.from(sosModal.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled])',
  ));
  check('the dialog has focusable content', focusables.length > 1, String(focusables.length));

  // Escape closes it and focus returns where the user left it.
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  check('Escape closes the dialog', sosModal?.classList.contains('hidden'));
  check('focus returns to what opened it', window.document.activeElement === sosButton,
    window.document.activeElement?.id);
  check('the scroll lock is released', !window.document.body.classList.contains('modal-open'));

  // --- emergency contacts round-trip ----------------------------------------
  window.__onebar.openContactsModal();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const rows = window.document.querySelectorAll('.contact-field-row');
  check('the contacts dialog offers three rows', rows.length === 3, String(rows.length));

  rows[0].querySelector('[data-field="name"]').value = 'Alex';
  rows[0].querySelector('[data-field="phone"]').value = '+1 555 0101';
  $('btn-contacts-save')?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 40));

  check('the contacts dialog closes on save', $('contacts-modal')?.classList.contains('hidden'));
  const stored = JSON.parse(storage.get('onebar_contacts_v1') || '[]');
  check('the contact is stored on the device', stored.length === 1 && stored[0].name === 'Alex',
    JSON.stringify(stored));
  check('the number is normalised for the dialler', stored[0]?.phone === '+15550101', stored[0]?.phone);

  // The SOS dialog should now pre-fill that recipient instead of opening blank.
  $('btn-sheet-sos')?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const chips = window.document.querySelectorAll('.sos-contact-chip');
  check('SOS offers the saved contact as a recipient', chips.length === 1, String(chips.length));
  check('recipients are selected by default', chips[0]?.getAttribute('aria-pressed') === 'true');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  // --- hazard reporting: private by default ---------------------------------
  $('btn-quick-hazard')?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const shareToggle = $('hazard-share-toggle');
  check('a report is private unless the user shares it', shareToggle?.checked === false);
  check('the dialog says how long a private report lasts',
    ($('hazard-expiry-note')?.textContent || '').includes('stays on your phone'),
    $('hazard-expiry-note')?.textContent?.trim());

  shareToggle.checked = true;
  shareToggle.dispatchEvent(new window.Event('change'));
  check('sharing changes what the dialog promises',
    ($('hazard-expiry-note')?.textContent || '').includes('Shared reports'),
    $('hazard-expiry-note')?.textContent?.trim());
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  // --- display settings ------------------------------------------------------
  const largeText = $('btn-toggle-large-text');
  check('large text starts off', !window.document.body.classList.contains('text-large'));
  largeText?.dispatchEvent(new window.Event('click'));
  check('large text turns on', window.document.body.classList.contains('text-large'));
  check('the switch reports its state to assistive tech',
    largeText?.getAttribute('aria-pressed') === 'true');
  check('large text is remembered', storage.get('onebar_large_text') === 'true');
  largeText?.dispatchEvent(new window.Event('click'));
  check('large text turns off again', !window.document.body.classList.contains('text-large'));
}

// --- keyboard trapping actually wraps ----------------------------------------

if (onboarded) {
  $('btn-view-safe-havens')?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const havens = $('havens-modal');
  const focusables = Array.from(havens.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled])',
  )).filter((el) => !el.hasAttribute('hidden') && !el.closest('.hidden'));

  check('the dialog exposes its focusable controls', focusables.length >= 2, String(focusables.length));
  focusables[focusables.length - 1].focus();
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  check('Tab from the last control wraps to the first, not out of the dialog',
    window.document.activeElement === focusables[0],
    window.document.activeElement?.id || window.document.activeElement?.className);

  focusables[0].focus();
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  check('Shift+Tab from the first control wraps to the last',
    window.document.activeElement === focusables[focusables.length - 1],
    window.document.activeElement?.id || window.document.activeElement?.className);

  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

// --- another device's report text must never become markup --------------------
//
// Reports are shareable now, so a hazard name arrives from a stranger. Before this it
// went straight into innerHTML.

{
  const mapModule = await import(pathToFileURL(path.join(ROOT, 'static', 'js', 'map.js')).href);
  popupNodes.length = 0;
  mapModule.addHazardLayer({
    hazard_id: 'hostile-1',
    name: '<img src=x onerror="globalThis.__pwned=1">Roadblock',
    hazard_type: 'closure',
    description: '<script>globalThis.__pwned = 2;<\/script>Water here',
    source_url: 'javascript:globalThis.__pwned=3',
    buffer_meters: 0,
    provenance: 'community',
    confirmations: 1,
    denials: 0,
    mine: false,
    coordinates: [
      { lat: 40.7080, lon: -74.0130 },
      { lat: 40.7095, lon: -74.0100 },
      { lat: 40.7065, lon: -74.0095 },
    ],
  });

  const popup = popupNodes[0];
  check('the hazard popup was built', Boolean(popup));
  check('a hostile report name is rendered as text, not markup',
    popup && popup.querySelector('img') === null && popup.querySelector('script') === null);
  check('the name is still shown to the user',
    (popup?.textContent || '').includes('Roadblock'), popup?.querySelector('.hazard-popup-title')?.textContent);
  check('the description is still shown to the user',
    (popup?.textContent || '').includes('Water here'));
  check('a javascript: source link is dropped',
    popup?.querySelector('.hazard-source-link') === null,
    popup?.querySelector('.hazard-source-link')?.getAttribute('href') || 'no link');
  check('nothing executed', globalThis.__pwned === undefined, String(globalThis.__pwned));

  // A real https link should survive.
  popupNodes.length = 0;
  mapModule.addHazardLayer({
    hazard_id: 'official-1',
    name: '[NWS] Flood Watch',
    hazard_type: 'flood',
    source_url: 'https://api.weather.gov/alerts/urn:oid:1.2.3',
    buffer_meters: 0,
    provenance: 'official',
    coordinates: [
      { lat: 40.7080, lon: -74.0130 },
      { lat: 40.7095, lon: -74.0100 },
      { lat: 40.7065, lon: -74.0095 },
    ],
  });
  check('an official https link is kept',
    popupNodes[0]?.querySelector('.hazard-source-link')?.getAttribute('href')
      === 'https://api.weather.gov/alerts/urn:oid:1.2.3',
    popupNodes[0]?.querySelector('.hazard-source-link')?.getAttribute('href') || 'missing');
  check('an official alert offers no confirm/deny buttons',
    popupNodes[0]?.querySelector('.hazard-vote-row') === null);
}

// --- the route flow, end to end -----------------------------------------------

if (onboarded && online && !withPack) {
  // Every request must be attributed, or the server refuses the write.
  const write = requestLog.find((r) => r.path === '/hazards' || r.path === '/region');
  check('requests carry the device header',
    Boolean(write?.headers?.['X-OneBar-Device']), JSON.stringify(write?.headers || {}));
  check('the device id looks like the server will accept it',
    /^[A-Za-z0-9_-]{8,64}$/.test(write?.headers?.['X-OneBar-Device'] || ''),
    write?.headers?.['X-OneBar-Device']);

  check('the region name reaches the top bar',
    ($('top-place-subtitle')?.textContent || '').includes('Lower Manhattan'),
    $('top-place-subtitle')?.textContent);
  check('the shelter count reaches the chips',
    $('chip-shelter-count')?.textContent === '1', $('chip-shelter-count')?.textContent);
  check('the service indicator reports a reachable server',
    $('service-badge')?.className.includes('ok'), $('service-badge')?.className);

  // Search → pick a destination → the planner opens with it filled in.
  const searchField = $('search-input');
  searchField.value = 'bro';
  searchField.dispatchEvent(new window.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const firstResult = window.document.querySelector('.search-result-item');
  check('a search result is offered', Boolean(firstResult),
    $('search-results')?.textContent?.trim()?.slice(0, 80));

  firstResult?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  check('choosing a result opens the planner', !$('sheet-planner-state')?.classList.contains('hidden'));
  check('the destination is named, not shown as coordinates',
    $('dest-label')?.textContent === 'Broadway', $('dest-label')?.textContent);
  check('the results list closes once a result is chosen',
    $('search-results')?.classList.contains('hidden'));

  // With no position fix, EVACUATE must refuse and say why. Routing from a guessed
  // or hardcoded coordinate is the failure this app cannot afford.
  $('btn-hero-evacuate')?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 120));
  check('evacuating without a position refuses instead of guessing',
    $('sheet-route-state')?.classList.contains('hidden'));
  check('and says what is missing',
    ($('toast')?.textContent || '').toLowerCase().includes('location'), $('toast')?.textContent);

  // Now the fix arrives.
  check('the app subscribed to position updates', typeof pushPosition === 'function');
  pushPosition?.(40.7070, -74.0140);
  await new Promise((resolve) => setTimeout(resolve, 60));
  check('the GPS indicator reflects the fix', $('gps-text')?.textContent === 'Active',
    $('gps-text')?.textContent);

  // The evacuate button is the one that has to work.
  $('btn-hero-evacuate')?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 200));

  check('an evacuation route renders', !$('sheet-route-state')?.classList.contains('hidden'));
  check('the route sheet shows a time', $('route-time')?.textContent === '6', $('route-time')?.textContent);
  check('the route sheet shows a distance', $('route-dist')?.textContent === '1.2', $('route-dist')?.textContent);
  check('the route sheet shows hazards avoided',
    $('route-blocked')?.textContent === '3', $('route-blocked')?.textContent);
  check('turn-by-turn steps are listed',
    window.document.querySelectorAll('.maneuver-item').length === 3,
    String(window.document.querySelectorAll('.maneuver-item').length));
  check('the guidance HUD shows the first instruction',
    ($('hud-instruction')?.textContent || '').includes('Greenwich'), $('hud-instruction')?.textContent);
  check('the destination shelter is named',
    ($('route-haven-name')?.textContent || '').includes('Fulton'), $('route-haven-name')?.textContent);
  check('the top bar yields to the navigation HUD',
    $('nav-guidance-hud')?.classList.contains('hidden') === false);

  // The SOS message should now describe where the user is heading.
  $('btn-top-sos')?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  const sosBody = $('sos-message-preview')?.value || '';
  check('the SOS message names the destination shelter', sosBody.includes('Fulton'), sosBody.slice(0, 120));
  check('the SOS message carries an ETA', /ETA/.test(sosBody));
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  // Exiting navigation must put the app back to idle and drop the saved trip.
  $('btn-clear-route')?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  check('exiting navigation returns to the idle sheet',
    !$('sheet-idle-state')?.classList.contains('hidden'));
  check('the navigation HUD is dismissed', $('nav-guidance-hud')?.classList.contains('hidden'));
}

// --- with a pack installed, routing must not touch the network -----------------

if (withPack) {
  check('the app believes a pack is installed',
    JSON.parse(storage.get('onebar_installed_packs') || '[]').length === 1);

  pushPosition?.(40.7070, -74.0140);
  await new Promise((resolve) => setTimeout(resolve, 60));

  const before = requestLog.filter((r) => r.path.startsWith('/route')).length;
  $('btn-hero-evacuate')?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 250));

  check('an evacuation route renders from the pack',
    !$('sheet-route-state')?.classList.contains('hidden'));
  check('the routing worker was used', workerCalls.some((c) => c.type === 'route'),
    workerCalls.map((c) => c.type).join(','));
  check('the server was not asked to route',
    requestLog.filter((r) => r.path.startsWith('/route')).length === before,
    requestLog.filter((r) => r.path.startsWith('/route')).map((r) => r.path).join(','));
  check('the destination shelter came from the pack',
    ($('route-haven-name')?.textContent || '').includes('Fulton'), $('route-haven-name')?.textContent);
  check('an unverified shelter is not called verified',
    ($('.haven-dest-tag') ? true : true)
      && !(window.document.querySelector('.haven-dest-tag')?.textContent || '').includes('VERIFIED SAFE'),
    window.document.querySelector('.haven-dest-tag')?.textContent);

  // The custom planner is the path that had no offline engine at all.
  $('btn-clear-route')?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const beforePlanner = requestLog.filter((r) => r.path === '/route').length;
  $('btn-open-route-planner')?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  window.__onebar.setDestinationForTest?.({ lat: 40.7100, lon: -74.0090 }, 'Test destination');
  await new Promise((resolve) => setTimeout(resolve, 30));
  $('btn-calculate-route')?.dispatchEvent(new window.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 250));

  check('the custom planner routes from the pack too',
    !$('sheet-route-state')?.classList.contains('hidden'));
  check('and did not fall back to the server',
    requestLog.filter((r) => r.path === '/route').length === beforePlanner,
    String(requestLog.filter((r) => r.path === '/route').length - beforePlanner));

  // The pack's shelter list must survive being asked for more than once. Returning the
  // catalogue entry on the second call dropped `havens`, which emptied the evacuation
  // destination list *and* wiped every shelter already drawn on the map.
  const { offlineHavens } = await import(
    pathToFileURL(path.join(ROOT, 'static', 'js', 'offline-router.js')).href);
  const firstAsk = await offlineHavens(40.7070, -74.0140);
  const secondAsk = await offlineHavens(40.7070, -74.0140);
  check('the pack still lists shelters on a second lookup',
    secondAsk.length > 0 && secondAsk.length === firstAsk.length,
    `${firstAsk.length} then ${secondAsk.length}`);

  // ...and reloading them must not empty the map.
  await window.__onebar.reloadSafeHavensForTest?.();
  await new Promise((resolve) => setTimeout(resolve, 80));
  check('reloading shelters offline does not clear the map',
    Number($('chip-shelter-count')?.textContent || '0') > 0,
    $('chip-shelter-count')?.textContent);

  // The trip must survive being written and read back.
  const { loadTrip, flushTrip } = await import(
    pathToFileURL(path.join(ROOT, 'static', 'js', 'trip-store.js')).href);
  await flushTrip();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const restored = await loadTrip();
  check('the journey is persisted for a restart', Boolean(restored?.dest || restored?.haven),
    JSON.stringify(restored || null).slice(0, 160));
  check('the persisted journey keeps the travel mode',
    restored?.travelMode === 'drive' || restored?.travelMode === 'walk', restored?.travelMode);
}

// --- touch targets ------------------------------------------------------------
//
// jsdom does no layout, so this checks the stylesheet names classes that actually
// exist in the markup. The previous accessibility pass targeted .category-chip,
// .hazard-type-btn, .radius-pill and .buffer-pill — none of which appear anywhere in
// index.html — so every one of those rules silently matched nothing.

const css = await readFile(path.join(ROOT, 'static', 'app.css'), 'utf-8');
for (const cls of ['chip-item', 'type-btn', 'radius-btn', 'buffer-btn']) {
  const inHtml = new RegExp(`class="[^"]*\\b${cls}\\b`).test(html);
  const inCss = new RegExp(`\\.${cls}[^{]*\\{[^}]*min-height`).test(css)
    || new RegExp(`\\.${cls}[,\\s]`).test(css.slice(css.indexOf('Raise the controls')));
  check(`touch-target rule for .${cls} matches real markup`, inHtml && inCss,
    `html=${inHtml} css=${inCss}`);
}

process.stdout.write(JSON.stringify({ checks }));
process.exit(checks.every((c) => c.pass) ? 0 : 1);
