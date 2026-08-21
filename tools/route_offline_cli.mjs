// Run the browser routing engine under Node so the Python test suite can compare the
// two implementations directly.
//
// Usage:  node tools/route_offline_cli.mjs <pack.obp> '<json request>'
//
// The request mirrors the /route payload:
//   { "origin": {...}, "destinations": [...], "mode": "drive", "hazards": [...] }

import { readFile } from 'node:fs/promises';
import { readPack } from '../static/js/pack-format.js';
import { buildEdgeGrid, route } from '../static/js/route-engine.js';

const [packPath, requestJson] = process.argv.slice(2);
if (!packPath || !requestJson) {
  console.error('usage: route_offline_cli.mjs <pack.obp> <json request>');
  process.exit(2);
}

const file = await readFile(packPath);
// Copy out of Node's pooled Buffer so byteOffset is 0 and the typed-array views align.
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);

const pack = readPack(buffer);
const grid = buildEdgeGrid(pack);
const request = JSON.parse(requestJson);

const started = process.hrtime.bigint();
const result = route(pack, grid, request);
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

process.stdout.write(JSON.stringify({
  ...result,
  compute_ms: Math.round(elapsedMs * 100) / 100,
  pack: { nodeCount: pack.nodeCount, edgeCount: pack.edgeCount, maxSpeedMps: pack.maxSpeedMps },
}));
