// Offline Map Tile Pre-Downloader for OneBar

const CACHE_NAME = 'onebar-v1';
const SUBDOMAINS = ['a', 'b', 'c'];

function lon2tile(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

function lat2tile(lat, zoom) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, zoom)
  );
}

export async function preCacheRegionTiles(bounds, minZoom = 13, maxZoom = 16, onProgress = null) {
  if (!('caches' in window)) {
    throw new Error('CacheStorage API not supported');
  }

  const cache = await caches.open(CACHE_NAME);
  const tileUrls = [];

  const minLat = Math.min(bounds.min_lat, bounds.max_lat);
  const maxLat = Math.max(bounds.min_lat, bounds.max_lat);
  const minLon = Math.min(bounds.min_lon, bounds.max_lon);
  const maxLon = Math.max(bounds.min_lon, bounds.max_lon);

  for (let z = minZoom; z <= maxZoom; z++) {
    const startX = lon2tile(minLon, z);
    const endX = lon2tile(maxLon, z);
    const startY = lat2tile(maxLat, z);
    const endY = lat2tile(minLat, z);

    for (let x = Math.min(startX, endX); x <= Math.max(startX, endX); x++) {
      for (let y = Math.min(startY, endY); y <= Math.max(startY, endY); y++) {
        const s = SUBDOMAINS[(x + y) % SUBDOMAINS.length];
        const url = `https://${s}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
        tileUrls.push(url);
      }
    }
  }

  const total = tileUrls.length;
  let completed = 0;
  const CONCURRENCY = 6;

  // Worker pool for concurrent downloading
  async function downloadWorker(urls) {
    while (urls.length > 0) {
      const url = urls.pop();
      try {
        const match = await cache.match(url);
        if (!match) {
          const res = await fetch(url, { mode: 'cors' });
          if (res.ok) {
            await cache.put(url, res);
          }
        }
      } catch (err) {
        console.warn('Tile fetch skipped:', url, err);
      } finally {
        completed++;
        if (onProgress) onProgress(completed, total);
      }
    }
  }

  const queue = [...tileUrls];
  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => downloadWorker(queue));
  await Promise.all(workers);

  return { total, cached: completed };
}
