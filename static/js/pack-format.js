// Reader for OneBar offline region packs (.obp).
//
// The format is laid out so that every section maps directly onto a typed array view
// over the downloaded ArrayBuffer — there is no parsing step and no per-node object
// allocation, so opening a metro-sized pack costs microseconds rather than seconds.
//
// Must stay byte-for-byte in step with tools/build_pack.py.

export const MAGIC = 0x3150424f; // "OBP1" little-endian
export const HEADER_BYTES = 64;
export const COORD_SCALE = 1e6;

export const FLAG_DRIVE = 1 << 0;
export const FLAG_WALK = 1 << 1;

function align4(value) {
  return (value + 3) & ~3;
}

/**
 * Map a downloaded pack buffer into typed-array views.
 * @param {ArrayBuffer} buffer
 */
export function readPack(buffer) {
  const view = new DataView(buffer);

  if (view.getUint32(0, true) !== MAGIC) {
    throw new Error('Not a OneBar pack (bad magic number)');
  }
  const formatVersion = view.getUint32(4, true);
  if (formatVersion !== 1) {
    throw new Error(`Unsupported pack format version ${formatVersion}`);
  }

  const bounds = {
    minLat: view.getInt32(8, true) / COORD_SCALE,
    minLon: view.getInt32(12, true) / COORD_SCALE,
    maxLat: view.getInt32(16, true) / COORD_SCALE,
    maxLon: view.getInt32(20, true) / COORD_SCALE,
  };

  const nodeCount = view.getUint32(24, true);
  const edgeCount = view.getUint32(28, true);
  const maxSpeedMps = view.getFloat32(32, true);
  const stringOffset = view.getUint32(36, true);
  const geometryOffset = view.getUint32(44, true);
  const geometryLength = view.getUint32(48, true);
  const havenOffset = view.getUint32(52, true);
  const havenLength = view.getUint32(56, true);

  // Walk the sections in the exact order the builder wrote them.
  let cursor = HEADER_BYTES;
  const take = (Ctor, count) => {
    const arr = new Ctor(buffer, cursor, count);
    cursor = align4(cursor + count * Ctor.BYTES_PER_ELEMENT);
    return arr;
  };

  const nodeLat = take(Int32Array, nodeCount);
  const nodeLon = take(Int32Array, nodeCount);
  const edgeOffset = take(Uint32Array, nodeCount + 1);
  const edgeTarget = take(Uint32Array, edgeCount);
  const edgeLength = take(Uint16Array, edgeCount);
  const edgeSpeed = take(Uint8Array, edgeCount);
  const edgeFlags = take(Uint8Array, edgeCount);
  const edgeNameId = take(Uint16Array, edgeCount);
  const edgeGeomOffset = take(Uint32Array, edgeCount + 1);

  const geometry = new Int16Array(buffer, geometryOffset, geometryLength / 2);

  const strings = readStringTable(buffer, stringOffset);
  const havens = havenLength
    ? JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, havenOffset, havenLength)))
    : [];

  return {
    formatVersion, bounds, nodeCount, edgeCount, maxSpeedMps,
    nodeLat, nodeLon, edgeOffset, edgeTarget, edgeLength, edgeSpeed,
    edgeFlags, edgeNameId, edgeGeomOffset, geometry, strings, havens,
  };
}

function readStringTable(buffer, offset) {
  const view = new DataView(buffer);
  const decoder = new TextDecoder();
  const count = view.getUint32(offset, true);
  const out = new Array(count);
  let cursor = offset + 4;
  for (let i = 0; i < count; i++) {
    const len = view.getUint16(cursor, true);
    cursor += 2;
    out[i] = len ? decoder.decode(new Uint8Array(buffer, cursor, len)) : '';
    cursor += len;
  }
  return out;
}

export const nodeLatOf = (pack, i) => pack.nodeLat[i] / COORD_SCALE;
export const nodeLonOf = (pack, i) => pack.nodeLon[i] / COORD_SCALE;

/** Whether an edge may be used in the given travel mode. */
export function edgeAllowed(pack, edge, mode) {
  const mask = mode === 'walk' ? FLAG_WALK : FLAG_DRIVE;
  return (pack.edgeFlags[edge] & mask) !== 0;
}

/**
 * Traversal time in seconds.
 *
 * Cost is derived rather than stored: baking a single cost into the pack would
 * hard-code one travel mode, whereas length plus speed serves both.
 */
export function edgeCostSeconds(pack, edge, mode) {
  const metres = pack.edgeLength[edge];
  if (mode === 'walk') return metres / 1.389;          // ~5 km/h
  return metres / (pack.edgeSpeed[edge] / 3.6);
}

/** Full polyline for an edge, including both endpoint nodes. */
export function edgeGeometry(pack, node, edge) {
  const start = pack.edgeGeomOffset[edge];
  const end = pack.edgeGeomOffset[edge + 1];
  const points = [[nodeLatOf(pack, node), nodeLonOf(pack, node)]];

  let lat = pack.nodeLat[node];
  let lon = pack.nodeLon[node];
  for (let i = start; i < end; i += 2) {
    lat += pack.geometry[i];
    lon += pack.geometry[i + 1];
    points.push([lat / COORD_SCALE, lon / COORD_SCALE]);
  }

  const target = pack.edgeTarget[edge];
  points.push([nodeLatOf(pack, target), nodeLonOf(pack, target)]);
  return points;
}

export function edgeName(pack, edge) {
  return pack.strings[pack.edgeNameId[edge]] || '';
}

export function packContains(pack, lat, lon, marginDeg = 0.002) {
  const b = pack.bounds;
  return lat >= b.minLat - marginDeg && lat <= b.maxLat + marginDeg
    && lon >= b.minLon - marginDeg && lon <= b.maxLon + marginDeg;
}
