// Coordinate note: Leaflet uses [lat, lon]; Shapely/OSMnx use (lon, lat).
// All functions accepting coordinates take { lat, lon } objects.

let map = null;
let currentTileLayer = null;
let currentLayerKey = 'dark';
let userMarker = null;
let originMarker = null;
let destMarker = null;
let destHavenMarker = null;
let routeLayerGroup = null;
let maneuverMarker = null;
let hazardLayers = {};       // hazard_id -> L.Polygon
let safeHavenLayers = {};   // haven_id -> L.Marker
let draw = null;             // active draw session state
let deleteHazardCallback = null;
let evacuateHavenCallback = null;

// Premium Basemap Tile Providers (Ultra-fast, mobile optimized)
export const BASEMAPS = {
  dark: {
    name: 'Tactical Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://openstreetmap.org">OSM</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  },
  street: {
    name: 'Clean Street',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://openstreetmap.org">OSM</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  },
  satellite: {
    name: 'Satellite Aerial',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; <a href="https://www.esri.com/">Esri</a>, Earthstar Geographics',
    subdomains: '',
    maxZoom: 19,
  },
  osm: {
    name: 'OpenStreetMap',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://openstreetmap.org">OSM</a>',
    subdomains: 'abc',
    maxZoom: 19,
  },
};

export const HAZARD_COLORS = {
  closure:   '#dc2626',
  wildfire:  '#ea580c',
  flood:     '#0284c7',
  debris:    '#ca8a04',
  powerline: '#9333ea',
  collapse:  '#e11d48',
};

export const HAZARD_SVG_ICONS = {
  closure: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#dc2626" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
  wildfire: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#ea580c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,
  flood: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#0284c7" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-4 6-4 6 4 6 4 3-4 6-4"/><path d="M2 18s3-4 6-4 6 4 6 4 3-4 6-4"/></svg>`,
  debris: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#ca8a04" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  powerline: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#9333ea" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  collapse: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#e11d48" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="9" y1="22" x2="9" y2="12"/><line x1="15" y1="22" x2="15" y2="12"/><line x1="4" y1="12" x2="20" y2="12"/></svg>`,
};

export const HAVEN_SVG_ICONS = {
  shelter: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>`,
  hospital: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`,
  assembly_point: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  perimeter_exit: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
};

// --- Custom DivIcons --------------------------------------------------------

function divIcon(cls, size = [40, 40], innerHtml = '') {
  return L.divIcon({
    className: cls,
    html: innerHtml,
    iconSize: size,
    iconAnchor: [size[0] / 2, size[1] / 2],
  });
}

// --- Init Map ---------------------------------------------------------------

export function initMap(onMapTap, onHazardDelete, onEvacuateHaven) {
  deleteHazardCallback = onHazardDelete;
  evacuateHavenCallback = onEvacuateHaven;

  map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    tap: false,               // Prevents double-tap latency on mobile
    bounceAtZoomLimits: false,
    doubleClickZoom: false,
    inertia: true,
  }).setView([40.7128, -74.006], 14);

  // Set default basemap (Tactical Dark)
  setBasemap('dark');

  // Custom minimalist attribution
  L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);

  map.on('click', (e) => {
    if (draw) {
      addVertex(e.latlng);
    } else {
      onMapTap({ lat: e.latlng.lat, lon: e.latlng.lng });
    }
  });

  return map;
}

export function setBasemap(key) {
  if (!map || !BASEMAPS[key]) return;
  if (currentTileLayer) {
    map.removeLayer(currentTileLayer);
  }
  const config = BASEMAPS[key];
  currentLayerKey = key;
  currentTileLayer = L.tileLayer(config.url, {
    attribution: config.attribution,
    subdomains: config.subdomains || 'abc',
    maxZoom: config.maxZoom,
    keepBuffer: 6,
  }).addTo(map);
}

export function getCurrentBasemapKey() {
  return currentLayerKey;
}

export function fitBounds(bounds) {
  if (!map) return;
  map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16, animate: true });
}

export function getMapBounds() {
  if (!map) return null;
  const b = map.getBounds();
  return {
    min_lat: b.getSouth(),
    max_lat: b.getNorth(),
    min_lon: b.getWest(),
    max_lon: b.getEast(),
  };
}

export function setHighContrastMap(enabled) {
  const container = document.getElementById('map');
  if (container) {
    container.classList.toggle('high-contrast-tiles', enabled);
  }
}

export function zoomIn() {
  map?.zoomIn();
}

export function zoomOut() {
  map?.zoomOut();
}

// --- User Location & Navigation Puck ---------------------------------------

export function setUserLocation(latlng, heading = null) {
  if (!map) return;
  const ll = [latlng.lat, latlng.lng ?? latlng.lon];
  const headingHtml = heading !== null
    ? `<div class="puck-heading" style="transform: rotate(${heading}deg);"></div>`
    : '';
  const html = `<div class="nav-puck"><div class="nav-puck-pulse"></div><div class="nav-puck-dot"></div>${headingHtml}</div>`;

  if (!userMarker) {
    userMarker = L.marker(ll, {
      icon: divIcon('marker-user-puck', [36, 36], html),
      zIndexOffset: 1000,
    }).addTo(map);
  } else {
    userMarker.setLatLng(ll);
    userMarker.setIcon(divIcon('marker-user-puck', [36, 36], html));
  }
}

export function panTo(latlng, zoom) {
  if (!map) return;
  map.setView([latlng.lat, latlng.lng ?? latlng.lon], zoom ?? map.getZoom(), { animate: true });
}

// --- Origin & Destination Markers ------------------------------------------

export function setOriginMarker(latlng) {
  if (!map) return;
  const ll = [latlng.lat, latlng.lng ?? latlng.lon];
  const html = `
    <div class="pin-marker origin-pin">
      <div class="pin-icon">A</div>
      <div class="pin-anchor"></div>
    </div>
  `;
  if (!originMarker) {
    originMarker = L.marker(ll, {
      icon: divIcon('marker-pin-wrapper', [36, 44], html),
      zIndexOffset: 800,
    }).addTo(map);
  } else {
    originMarker.setLatLng(ll);
  }
}

export function setDestMarker(latlng) {
  if (!map) return;
  const ll = [latlng.lat, latlng.lng ?? latlng.lon];
  const html = `
    <div class="pin-marker dest-pin">
      <div class="pin-icon">B</div>
      <div class="pin-anchor"></div>
    </div>
  `;
  if (!destMarker) {
    destMarker = L.marker(ll, {
      icon: divIcon('marker-pin-wrapper', [36, 44], html),
      zIndexOffset: 800,
    }).addTo(map);
  } else {
    destMarker.setLatLng(ll);
  }
}

export function clearOriginMarker() {
  originMarker?.remove();
  originMarker = null;
}

export function clearDestMarker() {
  destMarker?.remove();
  destMarker = null;
}

export function setSafeHavenDestinationMarker(haven) {
  if (!map || !haven) return;
  clearSafeHavenDestinationMarker();
  const ll = [haven.location.lat, haven.location.lon];
  const iconSvg = HAVEN_SVG_ICONS[haven.type] || HAVEN_SVG_ICONS.shelter;
  const html = `
    <div class="haven-dest-beacon">
      <div class="haven-dest-pulse"></div>
      <div class="haven-dest-badge">
        <span class="haven-dest-icon">${iconSvg}</span>
        <span class="haven-dest-label">SAFE HAVEN</span>
      </div>
    </div>
  `;
  destHavenMarker = L.marker(ll, {
    icon: divIcon('marker-haven-dest', [48, 54], html),
    zIndexOffset: 1200,
  }).addTo(map);
}

export function clearSafeHavenDestinationMarker() {
  destHavenMarker?.remove();
  destHavenMarker = null;
}

// --- Safe Havens Layer Management -------------------------------------------

export function addSafeHavenLayer(haven) {
  if (!map) return;
  const ll = [haven.location.lat, haven.location.lon];
  const iconSvg = HAVEN_SVG_ICONS[haven.type] || HAVEN_SVG_ICONS.shelter;
  const isCompromised = Boolean(haven.is_compromised);
  const statusCls = isCompromised ? 'haven-compromised' : 'haven-safe';

  const markerHtml = `
    <div class="haven-marker ${statusCls}">
      <div class="haven-icon-box">${iconSvg}</div>
      <span class="haven-marker-status-dot"></span>
    </div>
  `;

  const marker = L.marker(ll, {
    icon: divIcon(`marker-safe-haven-wrapper ${statusCls}`, [38, 38], markerHtml),
    zIndexOffset: 600,
  }).addTo(map);

  // Popup
  const popupDiv = document.createElement('div');
  popupDiv.className = 'haven-popup-content';
  const capText = haven.capacity ? `<span class="haven-cap-badge">Cap: ${haven.capacity}</span>` : '';
  const statusBadge = isCompromised
    ? `<div class="haven-status-alert">Threat Near: ${haven.compromised_reason || 'Hazard proximity'}</div>`
    : `<div class="haven-status-good">VERIFIED SAFE HAVEN</div>`;

  popupDiv.innerHTML = `
    <div class="haven-popup-header">
      <div class="haven-popup-type">${haven.type.toUpperCase().replace('_', ' ')}</div>
      <h4 class="haven-popup-name">${haven.name}</h4>
      ${haven.address ? `<div class="haven-popup-address">${haven.address}</div>` : ''}
    </div>
    ${statusBadge}
    <div class="haven-popup-meta">
      ${capText}
    </div>
    <button class="btn-haven-evacuate-tap" ${isCompromised ? 'disabled' : ''}>
      ${isCompromised ? 'Route Compromised' : 'Evacuate to this Haven'}
    </button>
  `;

  popupDiv.querySelector('.btn-haven-evacuate-tap')?.addEventListener('click', (e) => {
    e.stopPropagation();
    marker.closePopup();
    if (evacuateHavenCallback && !isCompromised) {
      evacuateHavenCallback(haven);
    }
  });

  marker.bindPopup(popupDiv, { className: 'haven-custom-popup', maxWidth: 260 });
  safeHavenLayers[haven.id] = marker;
}

export function removeSafeHavenLayer(id) {
  safeHavenLayers[id]?.remove();
  delete safeHavenLayers[id];
}

export function clearAllSafeHavenLayers() {
  Object.values(safeHavenLayers).forEach((m) => m.remove());
  safeHavenLayers = {};
}

// --- Route Polyline (Dual-Tone Glowing Navigation Line) --------------------

export function showRoute(coords, isFallback) {
  clearRoute();
  if (!coords || !coords.length) return;
  const latlngs = coords.map((c) => [c.lat, c.lon]);

  routeLayerGroup = L.featureGroup();

  // 1. Shadow / Casing line (wide dark outline for crisp contrast over any satellite/streets)
  const casing = L.polyline(latlngs, {
    color: '#070c18',
    weight: 8,
    opacity: 0.9,
    lineCap: 'round',
    lineJoin: 'round',
  });

  // 2. Main route glow line (Vibrant green/blue or warning amber)
  const core = L.polyline(latlngs, {
    color: isFallback ? '#f59e0b' : '#10b981',
    weight: 4.8,
    opacity: 0.98,
    lineCap: 'round',
    lineJoin: 'round',
  });

  routeLayerGroup.addLayer(casing);
  routeLayerGroup.addLayer(core);
  routeLayerGroup.addTo(map);

  // Safe area padding ensures route is visible between top search bar and bottom sheet
  map.fitBounds(core.getBounds(), {
    paddingTopLeft: [70, 40],
    paddingBottomRight: [40, 240],
    animate: true,
  });
}

export function clearRoute() {
  routeLayerGroup?.remove();
  routeLayerGroup = null;
  clearManeuverHighlight();
  clearSafeHavenDestinationMarker();
}

export function highlightManeuver(location) {
  if (!map || !location) return;
  clearManeuverHighlight();
  const ll = [location.lat, location.lon];
  const html = `<div class="maneuver-beacon-pulse"></div>`;
  maneuverMarker = L.marker(ll, {
    icon: divIcon('marker-maneuver-beacon', [32, 32], html),
    zIndexOffset: 1500,
  }).addTo(map);
  map.panTo(ll, { animate: true });
}

export function clearManeuverHighlight() {
  maneuverMarker?.remove();
  maneuverMarker = null;
}

// --- Hazard Layer Management ------------------------------------------------

export function addHazardLayer(zone) {
  if (!map) return;
  const latlngs = zone.coordinates.map((c) => [c.lat, c.lon]);
  const color = HAZARD_COLORS[zone.hazard_type] ?? '#dc2626';
  const iconSvg = HAZARD_SVG_ICONS[zone.hazard_type] ?? HAZARD_SVG_ICONS.debris;
  const sourceLabel = zone.source ? `[${zone.source.toUpperCase()}]` : '';

  const poly = L.polygon(latlngs, {
    color,
    fillColor: color,
    fillOpacity: 0.28,
    weight: 2.4,
    dashArray: '6, 5',
  }).addTo(map);

  // Mobile popup for inspecting and deleting the hazard
  const popupDiv = document.createElement('div');
  popupDiv.className = 'hazard-popup-content';
  const bufferText = zone.buffer_meters > 0
    ? `<div style="font-size: 11px; color: #94a3b8; margin-bottom: 4px;">Safety Buffer: +${zone.buffer_meters}m</div>`
    : '';
  const descText = zone.description
    ? `<div style="font-size: 12px; color: #cbd5e1; margin-bottom: 6px; line-height: 1.3;">${zone.description}</div>`
    : '';

  popupDiv.innerHTML = `
    <div class="hazard-popup-header">
      <span class="hazard-popup-icon">${iconSvg}</span>
      <div>
        <div class="hazard-popup-title">${zone.name || 'Hazard Zone'}</div>
        <div class="hazard-popup-badge" style="color: ${color};">${zone.hazard_type.toUpperCase()} ${sourceLabel}</div>
      </div>
    </div>
    ${descText}
    ${bufferText}
    <button class="btn-hazard-del-tap" data-id="${zone.hazard_id}">Remove Zone</button>
  `;

  popupDiv.querySelector('.btn-hazard-del-tap').addEventListener('click', (e) => {
    e.stopPropagation();
    poly.closePopup();
    if (deleteHazardCallback) {
      deleteHazardCallback(zone.hazard_id);
    }
  });

  poly.bindPopup(popupDiv, { className: 'hazard-custom-popup', maxWidth: 260 });
  hazardLayers[zone.hazard_id] = poly;
}

export function removeHazardLayer(id) {
  hazardLayers[id]?.remove();
  delete hazardLayers[id];
}

export function clearAllHazardLayers() {
  Object.values(hazardLayers).forEach((l) => l.remove());
  hazardLayers = {};
}

// --- Polygon Drawing State --------------------------------------------------

function addVertex(latlng) {
  if (!draw) return;
  draw.vertices.push(latlng);
  draw.vertexMarkers.push(
    L.marker(latlng, { icon: divIcon('marker-vertex', [16, 16]) }).addTo(map)
  );
  refreshPreview();
  draw.onVertexAdded(draw.vertices.length);
}

function refreshPreview() {
  draw.preview?.remove();
  if (draw.vertices.length >= 2) {
    draw.preview = L.polyline(draw.vertices, {
      color: '#dc2626',
      weight: 2.5,
      dashArray: '5, 4',
      opacity: 0.9,
    }).addTo(map);
  }
}

export function startDraw(onVertexAdded, onFinished) {
  cancelDraw();
  draw = { vertices: [], vertexMarkers: [], preview: null, onVertexAdded, onFinished };
  if (map) map.getContainer().style.cursor = 'crosshair';
}

export function undoVertex() {
  if (!draw || draw.vertices.length === 0) return;
  draw.vertices.pop();
  draw.vertexMarkers.pop()?.remove();
  refreshPreview();
  draw.onVertexAdded(draw.vertices.length);
}

export function finishDraw() {
  if (!draw || draw.vertices.length < 3) return false;
  const coords = draw.vertices.map((ll) => ({ lat: ll.lat, lon: ll.lng }));
  const cb = draw.onFinished;
  cancelDraw();
  cb(coords);
  return true;
}

export function cancelDraw() {
  if (!draw) return;
  draw.vertexMarkers.forEach((m) => m.remove());
  draw.preview?.remove();
  draw = null;
  if (map) map.getContainer().style.cursor = '';
}

export function drawVertexCount() {
  return draw?.vertices.length ?? 0;
}
