// Run the browser modules that carry non-trivial pure logic under Node, so the Python
// suite can assert on them in CI.
//
// There is no bundler and no frontend test runner in this repo — deliberately, the app
// ships `static/` verbatim — so this mirrors tools/route_offline_cli.mjs: a tiny host
// that imports the real modules, exercises them, and prints results as JSON.
//
// Usage:  node tools/client_tests.mjs <pack.obp>

import { readFile } from 'node:fs/promises';

// Minimal browser surface. Both modules touch these only from inside functions, so
// stubbing them here is enough to run the real code rather than a copy of it.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// Node 24 defines `navigator` as a getter-only global, so it has to be replaced
// rather than assigned to.
function setUserAgent(userAgent) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent, language: 'en-US' },
    configurable: true,
    writable: true,
  });
}
setUserAgent('node');

const { buildSearchIndex, searchIndex } = await import('../static/js/pack-search.js');
const { readPack } = await import('../static/js/pack-format.js');
const contacts = await import('../static/js/contacts.js');

const results = [];
const check = (name, condition, detail = '') => {
  results.push({ name, pass: Boolean(condition), detail: String(detail) });
};

// --- pack search ------------------------------------------------------------

const packPath = process.argv[2];
if (packPath) {
  const file = await readFile(packPath);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const pack = readPack(buffer);
  const index = buildSearchIndex(pack);

  check('index has streets', index.streets.length > 0, `${index.streets.length} streets`);
  check(
    'every indexed street has a finite position',
    index.streets.every((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon)),
  );
  check(
    'indexed positions fall inside the pack bounds',
    index.streets.every((s) => s.lat >= pack.bounds.minLat - 0.01 && s.lat <= pack.bounds.maxLat + 0.01
      && s.lon >= pack.bounds.minLon - 0.01 && s.lon <= pack.bounds.maxLon + 0.01),
  );

  const broad = searchIndex(index, 'broad', { limit: 8 });
  check('finds a street by prefix', broad.length > 0, broad.map((r) => r.name).join(', '));
  check(
    'prefix matches rank above interior matches',
    broad.length === 0 || broad[0].name.toLowerCase().startsWith('broad'),
    broad[0]?.name,
  );
  check('results are marked as offline and in coverage',
    broad.every((r) => r.source === 'offline' && r.in_coverage === true));

  const substring = searchIndex(index, 'street', { limit: 20 });
  check('finds streets by an interior substring', substring.length > 1, `${substring.length} hits`);
  check('results are deduplicated by name',
    new Set(substring.map((r) => r.name)).size === substring.length);

  const near = { lat: pack.bounds.minLat, lon: pack.bounds.minLon };
  const ranked = searchIndex(index, 'street', { limit: 20, near });
  check('distances are populated when a position is given',
    ranked.every((r) => typeof r.distance_meters === 'number'));
  const sameRank = ranked.filter((r) => r.kind === 'street');
  check('same-rank results are ordered nearest first',
    sameRank.every((r, i) => i === 0 || sameRank[i - 1].distance_meters <= r.distance_meters));

  check('a one-character query returns nothing', searchIndex(index, 'b', { limit: 8 }).length === 0);
  check('an empty query returns nothing', searchIndex(index, '', { limit: 8 }).length === 0);
  check('the limit is respected', searchIndex(index, 'street', { limit: 3 }).length <= 3);
}

// --- emergency contacts -----------------------------------------------------

check('phone numbers keep dialler-significant characters only',
  contacts.normalisePhone('+1 (555) 010-2030') === '+15550102030',
  contacts.normalisePhone('+1 (555) 010-2030'));
check('a plus is only meaningful in first position',
  contacts.normalisePhone('555+010') === '555010');

const saved = contacts.saveContacts([
  { name: 'Sam', phone: '+1 555 0101' },
  { name: '', phone: '5550102' },
  { name: 'No number', phone: '' },
  { name: 'Fourth', phone: '5550104' },
  { name: 'Fifth', phone: '5550105' },
]);
check('rows without a number are dropped', saved.every((c) => c.phone));
check('a nameless contact falls back to its number', saved[1]?.name === '5550102', saved[1]?.name);
check('at most three contacts are stored', saved.length === contacts.MAX_CONTACTS, String(saved.length));
check('contacts round-trip through storage',
  contacts.listContacts().length === saved.length);

// The separator between the address list and the body differs by platform, and the
// wrong one silently drops the message text.
setUserAgent('Mozilla/5.0 (Linux; Android 13)');
const android = contacts.smsHref(['+15550101', '5550102'], 'help');
check('android uses ? before the body', android === 'sms:+15550101,5550102?body=help', android);

setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
const ios = contacts.smsHref(['+15550101'], 'help me');
check('ios uses & before the body', ios === 'sms:+15550101&body=help%20me', ios);

const noRecipients = contacts.smsHref([], 'help');
check('an empty recipient list still carries the body',
  noRecipients.includes('body=help'), noRecipients);

// --- voice guidance ----------------------------------------------------------

const voice = await import('../static/js/voice.js');

check('voice support is reported honestly outside a browser', voice.voiceSupported() === false);
check('spoken distances round to clean tens below a kilometre',
  voice.formatSpokenDistance(453) === '450 metres', voice.formatSpokenDistance(453));
check('spoken distances switch to kilometres above one',
  voice.formatSpokenDistance(1250) === '1.3 kilometres', voice.formatSpokenDistance(1250));

{
  const mid = voice.projectOnSegment(40.7045, -74.0, 40.7, -74.0, 40.709, -74.0);
  check('a mid-segment fix projects halfway with no offset',
    Math.abs(mid.t - 0.5) < 0.01 && mid.distanceMeters < 2,
    `${mid.t.toFixed(3)}/${mid.distanceMeters.toFixed(1)}`);
  check('fixes beyond either end clamp onto the segment',
    voice.projectOnSegment(40.72, -74.0, 40.7, -74.0, 40.709, -74.0).t === 1
    && voice.projectOnSegment(40.69, -74.0, 40.7, -74.0, 40.709, -74.0).t === 0);
}

function makeManeuvers() {
  return [
    { type: 'depart', instruction: 'Head north on Broad Street',
      location: { lat: 40.7000, lon: -74.0000 } },
    { type: 'turn_left', instruction: 'Turn left onto Park Row',
      location: { lat: 40.7090, lon: -74.0000 } },
    { type: 'arrive', instruction: 'Arrive at evacuation destination',
      location: { lat: 40.7180, lon: -74.0000 } },
  ];
}

// Fixes walk the route line itself; metres are measured north of the origin vertex.
function walkedGuide(said) {
  const guide = voice.createVoiceGuide({ speak: (t) => said.push(t), isEnabled: () => true });
  const at = (metresNorth, lon = -74.0) => guide.onPosition(40.7 + metresNorth / 111320, lon);
  return { guide, at };
}

{
  const said = [];
  const { guide, at } = walkedGuide(said);

  guide.route(makeManeuvers());
  check('starting a route speaks the first instruction',
    said.at(-1).includes('Route started') && said.at(-1).includes('Head north'), said.at(-1));

  check('a fix well behind the origin is ignored as noise', at(-900) === null);
  check('past the depart point but far from the turn, nothing more is spoken',
    at(150) === null);

  const farPrompt = at(650);
  check('the far band announces the turn with a distance prefix',
    typeof farPrompt === 'string' && farPrompt.includes('350 metres') && farPrompt.includes('Turn left onto Park Row'),
    String(farPrompt));
  check('lingering inside an announced band does not repeat', at(655) === null);

  const midPrompt = at(880);
  check('the middle band announces once closer in',
    typeof midPrompt === 'string' && midPrompt.includes('120 metres') && midPrompt.includes('Park Row'),
    String(midPrompt));

  const nearPrompt = at(950);
  check('inside the last band the bare instruction is spoken',
    typeof nearPrompt === 'string' && !nearPrompt.includes('metres') && nearPrompt.includes('Turn left onto Park Row'),
    String(nearPrompt));

  check('crossing a turn advances silently while the next leg is long', at(1050) === null);
  check('a fix far off the route neither speaks nor inflates progress', at(1900, -73.99) === null);

  const arrival = at(1995);
  check('reaching the destination speaks an arrival message',
    typeof arrival === 'string' && arrival.includes('arrived'), String(arrival));
  check('after arrival the guide is inert', at(1996) === null);

  guide.stop();
  check('stopping after arrival adds nothing further', said.at(-1).includes('arrived'), said.at(-1));
}

{
  const said = [];
  const { guide } = walkedGuide(said);
  guide.route(makeManeuvers());
  guide.stop();
  check('abandoning navigation mid-route speaks a closing line',
    said.at(-1) === 'Navigation ended.', said.at(-1));
}

{
  const said = [];
  const { guide } = walkedGuide(said);
  guide.route(makeManeuvers());
  guide.route(makeManeuvers());
  check('a recomputed route announces itself as a reroute',
    said.at(-1).startsWith('Rerouting.'), said.at(-1));
}

{
  const said = [];
  const muted = voice.createVoiceGuide({ speak: (t) => said.push(t), isEnabled: () => false });
  muted.route(makeManeuvers());
  const silent = muted.onPosition(40.7, -74.0);
  check('a disabled guide never speaks or schedules prompts',
    said.length === 0 && silent === null, `${said.length}/${String(silent)}`);
}

process.stdout.write(JSON.stringify({ results }));
process.exit(results.every((r) => r.pass) ? 0 : 1);
