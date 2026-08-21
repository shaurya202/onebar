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

process.stdout.write(JSON.stringify({ results }));
process.exit(results.every((r) => r.pass) ? 0 : 1);
