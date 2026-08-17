import { api } from './api.js';
import { haptics } from './haptics.js';
import { preCacheRegionTiles } from './tile-cache.js';
import {
  initMap,
  panTo,
  fitBounds,
  getMapBounds,
  setHighContrastMap,
  setBasemap,
  getCurrentBasemapKey,
  zoomIn,
  zoomOut,
  setUserLocation,
  setOriginMarker,
  setDestMarker,
  clearOriginMarker,
  clearDestMarker,
  showRoute,
  clearRoute,
  highlightManeuver,
  addHazardLayer,
  removeHazardLayer,
  clearAllHazardLayers,
  addSafeHavenLayer,
  removeSafeHavenLayer,
  clearAllSafeHavenLayers,
  setSafeHavenDestinationMarker,
  clearSafeHavenDestinationMarker,
  startDraw,
  undoVertex,
  finishDraw,
  cancelDraw,
  drawVertexCount,
} from './map.js';

// ---------------------------------------------------------------------------
// Application State
// ---------------------------------------------------------------------------

let appState = 'idle';     // 'idle' | 'planner' | 'route' | 'draw' | 'pick_origin' | 'pick_dest'
let travelMode = 'drive';   // 'drive' | 'walk'
let origin = null;         // { lat, lon }
let dest = null;           // { lat, lon }
let hazards = {};          // hazard_id -> zone
let safeHavens = {};       // haven_id -> haven
let currentRouteData = null;
let activeDestinationHaven = null;
let toastTimer = null;
let connectivityTimer = null;
let backgroundSyncTimer = null;
let lastGPSLat = null;
let lastGPSLon = null;
let lastGPSAccuracy = null;
let lastGPSHeading = null;
let isHighContrast = false;
let wakeLock = null;

const GPS_STILL_THRESHOLD = 3; // metres

// ---------------------------------------------------------------------------
// Maneuver Vector Icons (SVG)
// ---------------------------------------------------------------------------

const MANEUVER_SVGS = {
  depart: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`,
  straight: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`,
  slight_left: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="19" x2="7" y2="7"/><polyline points="7 14 7 7 14 7"/></svg>`,
  turn_left: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 20v-7a4 4 0 0 0-4-4H5"/><polyline points="9 5 5 9 9 13"/></svg>`,
  sharp_left: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21V9a4 4 0 0 0-7-2.6L4 12"/><polyline points="8 12 4 12 4 8"/></svg>`,
  slight_right: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="19" x2="17" y2="7"/><polyline points="10 7 17 7 17 14"/></svg>`,
  turn_right: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20v-7a4 4 0 0 1 4-4h10"/><polyline points="15 5 19 9 15 13"/></svg>`,
  sharp_right: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21V9a4 4 0 0 1 7-2.6L20 12"/><polyline points="16 12 20 12 20 8"/></svg>`,
  u_turn: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19V9a5 5 0 0 1 10 0v10"/><polyline points="5 15 9 19 13 15"/></svg>`,
  arrive: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>`,
};

// ---------------------------------------------------------------------------
// DOM Elements
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const show = (el) => el?.classList.remove('hidden');
const hide = (el) => el?.classList.add('hidden');

const dom = {
  // Top Navigation & Badges
  topNavCard:          $('top-nav-card'),
  topPlaceTitle:       $('top-place-title'),
  topPlaceSub:         $('top-place-subtitle'),
  connectBadge:        $('connectivity-badge'),
  connectDot:          document.querySelector('.signal-bars-icon'),
  connectText:         $('connectivity-text'),
  gpsText:             $('gps-text'),
  btnTopQuickEvacuate: $('btn-top-quick-evacuate'),
  btnTopSos:           $('btn-top-sos'),
  chipHazardCount:     $('chip-hazard-count'),
  chipShelterCount:    $('chip-shelter-count'),

  // Navigation HUD
  navHud:              $('nav-guidance-hud'),
  hudTurnIcon:         $('hud-turn-icon'),
  hudInstruction:      $('hud-instruction'),
  hudSubInstr:         $('hud-sub-instruction'),
  btnCloseHud:         $('btn-close-hud-route'),

  // Map Controls
  btnCompass:          $('btn-compass'),
  compassNeedle:       $('compass-needle'),
  btnPullApiFab:       $('btn-pull-api-fab'),
  btnLayers:           $('btn-layer-switcher'),
  btnContrast:         $('btn-contrast-toggle'),
  btnCacheTiles:       $('btn-cache-tiles'),
  btnZoomIn:           $('btn-zoom-in'),
  btnZoomOut:          $('btn-zoom-out'),
  btnQuickHazard:      $('btn-quick-hazard'),
  btnLocate:           $('btn-locate'),

  // Context Banner & Toast
  banner:              $('mode-banner'),
  toast:               $('toast'),

  // Bottom Sheet States
  bottomSheet:         $('bottom-sheet'),
  sheetIdle:           $('sheet-idle-state'),
  sheetPlanner:        $('sheet-planner-state'),
  sheetRoute:          $('sheet-route-state'),
  sheetDraw:           $('sheet-draw-state'),

  // Sheet Controls
  overviewSubtitle:    $('overview-subtitle'),
  hazardsCountBadge:   $('hazards-count-badge'),
  sheltersCountBadge:  $('shelters-count-badge'),
  btnHeroEvacuate:     $('btn-hero-evacuate'),
  btnOpenPlanner:      $('btn-open-route-planner'),
  btnOpenFeedSync:     $('btn-open-feed-sync'),
  btnViewSafeHavens:   $('btn-view-safe-havens'),
  btnSheetHazard:      $('btn-sheet-hazard'),
  btnSheetSos:         $('btn-sheet-sos'),

  // Planner
  btnModeDrive:        $('btn-mode-drive'),
  btnModeWalk:         $('btn-mode-walk'),
  originLabel:         $('origin-label'),
  destLabel:           $('dest-label'),
  btnSetOriginTap:     $('btn-set-origin-tap'),
  btnSetDestTap:       $('btn-set-dest-tap'),
  btnSwapWaypoints:    $('btn-swap-waypoints'),
  btnCancelPlanner:    $('btn-cancel-planner'),
  btnCalcRoute:        $('btn-calculate-route'),

  // Route Sheet
  routeHavenCard:      $('route-haven-card'),
  routeHavenName:      $('route-haven-name'),
  routeHavenAddress:   $('route-haven-address'),
  routeTime:           $('route-time'),
  routeDist:           $('route-dist'),
  routeBlocked:        $('route-blocked'),
  routeWarn:           $('route-warning'),
  maneuversList:       $('maneuvers-list'),
  maneuversCount:      $('maneuvers-count'),
  btnShareRoute:       $('btn-share-route'),
  btnClearRoute:       $('btn-clear-route'),

  // Draw Controls
  btnUndo:             $('btn-undo'),
  btnFinish:           $('btn-finish'),
  btnCancelDraw:       $('btn-cancel-draw'),

  // Modals
  apiSyncModal:        $('api-sync-modal'),
  feedSourceNws:       $('feed-source-nws'),
  feedSourceUsgs:      $('feed-source-usgs'),
  feedSourceEonet:     $('feed-source-eonet'),
  feedSourceSim:       $('feed-source-sim'),
  feedClearExisting:   $('feed-clear-existing'),
  btnTriggerApiSync:   $('btn-trigger-api-sync'),
  btnCloseSyncX:       $('btn-close-sync-x'),
  btnSyncCancel:       $('btn-sync-cancel'),

  havensModal:         $('havens-modal'),
  havensListContainer: $('havens-list-container'),
  btnCloseHavensX:     $('btn-close-havens-x'),
  btnHavensClose:      $('btn-havens-close'),

  layersModal:         $('layers-modal'),
  btnCloseLayers:      $('btn-close-layers'),
  hazardModal:         $('hazard-modal'),
  hazardInput:         $('hazard-name-input'),
  hazardRadiusSec:     $('hazard-radius-section'),
  tabHazardRadial:     $('tab-hazard-radial'),
  tabHazardPoly:       $('tab-hazard-polygon'),
  btnHazardCloseX:     $('btn-hazard-close-x'),
  btnHazardCancel:     $('btn-hazard-cancel'),
  btnHazardSubmit:     $('btn-hazard-submit'),
  sosModal:            $('sos-modal'),
  sosCoordsText:       $('sos-coords-text'),
  sosPreview:          $('sos-message-preview'),
  btnCloseSosX:        $('btn-close-sos-x'),
  btnSendSms:          $('btn-send-sms'),
  btnCopyCoords:       $('btn-copy-coords'),
};

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

initMap(onMapTap, onHazardDelete, onEvacuateHaven);
startGPS();
startCompass();
loadRegion();
loadHazards();
loadSafeHavens();
pollConnectivity();
initHighContrastState();
handleUrlActionShortcuts();

// Periodic background sync for fresh hazard feeds (every 90s when online)
backgroundSyncTimer = setInterval(() => {
  if (navigator.onLine) {
    autoSyncHazardsQuietly();
  }
}, 90000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
    console.warn('SW registration failed:', err);
  });
}

window.addEventListener('online', pollConnectivity);
window.addEventListener('offline', pollConnectivity);

// ---------------------------------------------------------------------------
// Screen Wake Lock API
// ---------------------------------------------------------------------------

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } catch { /* ignore */ }
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    try { wakeLock.release(); } catch { /* ignore */ }
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible' && appState === 'route') {
    await requestWakeLock();
  }
});

// ---------------------------------------------------------------------------
// Mobile Device Compass
// ---------------------------------------------------------------------------

function startCompass() {
  const handleOrientation = (e) => {
    let compassHeading = null;
    if (e.webkitCompassHeading) {
      compassHeading = e.webkitCompassHeading;
    } else if (e.alpha !== null) {
      compassHeading = (360 - e.alpha) % 360;
    }

    if (compassHeading !== null) {
      lastGPSHeading = compassHeading;
      if (dom.compassNeedle) {
        dom.compassNeedle.style.transform = `rotate(${-compassHeading}deg)`;
      }
      if (lastGPSLat !== null) {
        setUserLocation({ lat: lastGPSLat, lon: lastGPSLon }, compassHeading);
      }
    }
  };

  if (typeof DeviceOrientationEvent !== 'undefined') {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      dom.btnCompass.addEventListener('click', async () => {
        try {
          const perm = await DeviceOrientationEvent.requestPermission();
          if (perm === 'granted') {
            window.addEventListener('deviceorientation', handleOrientation, true);
          }
        } catch { /* ignore */ }
      }, { once: true });
    } else {
      window.addEventListener('deviceorientationabsolute', handleOrientation, true) ||
      window.addEventListener('deviceorientation', handleOrientation, true);
    }
  }
}

// ---------------------------------------------------------------------------
// PWA Action Shortcuts Handler
// ---------------------------------------------------------------------------

function handleUrlActionShortcuts() {
  const urlParams = new URLSearchParams(window.location.search);
  const action = urlParams.get('action');
  if (action === 'evacuate' || action === 'safety') {
    setTimeout(() => autoEvacuateToSafety(), 400);
  } else if (action === 'route') {
    setTimeout(() => setAppState('planner'), 300);
  } else if (action === 'hazard') {
    setTimeout(() => openHazardModal(true), 300);
  } else if (action === 'feeds' || action === 'sync') {
    setTimeout(() => openApiSyncModal(), 300);
  } else if (action === 'sos') {
    setTimeout(() => openSOSModal(), 300);
  }
}

// ---------------------------------------------------------------------------
// State Machine & Bottom Deck Transitions
// ---------------------------------------------------------------------------

function setAppState(nextState) {
  appState = nextState;
  hide(dom.banner);

  hide(dom.sheetIdle);
  hide(dom.sheetPlanner);
  hide(dom.sheetRoute);
  hide(dom.sheetDraw);

  if (nextState === 'idle') {
    show(dom.sheetIdle);
    show(dom.topNavCard);
    hide(dom.navHud);
    cancelDraw();
    releaseWakeLock();
  } else if (nextState === 'planner') {
    show(dom.sheetPlanner);
    show(dom.topNavCard);
    hide(dom.navHud);
    updatePlannerLabels();
  } else if (nextState === 'route') {
    show(dom.sheetRoute);
    hide(dom.topNavCard);
    show(dom.navHud);
    requestWakeLock();
  } else if (nextState === 'draw') {
    show(dom.sheetDraw);
    show(dom.topNavCard);
    hide(dom.navHud);
    startDraw(updateFinishBtn, onPolygonDrawn);
    updateFinishBtn(0);
    banner('Tap map to draw boundary vertices (minimum 3 points)');
  } else if (nextState === 'pick_origin') {
    show(dom.sheetPlanner);
    banner('Tap map to set Origin point (A)');
  } else if (nextState === 'pick_dest') {
    show(dom.sheetPlanner);
    banner('Tap map to set Destination point (B)');
  }
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------

// HERO ACTION: Auto-Evacuate to Safety (Fastest Route to Safe Haven)
dom.btnHeroEvacuate?.addEventListener('click', () => {
  haptics.sos();
  autoEvacuateToSafety();
});

dom.btnTopQuickEvacuate?.addEventListener('click', () => {
  haptics.sos();
  autoEvacuateToSafety();
});

dom.btnOpenPlanner?.addEventListener('click', () => {
  haptics.tap();
  setAppState('planner');
});

dom.btnCancelPlanner?.addEventListener('click', () => {
  haptics.tap();
  setAppState('idle');
});

dom.btnSetOriginTap?.addEventListener('click', () => {
  haptics.tap();
  setAppState('pick_origin');
});

dom.btnSetDestTap?.addEventListener('click', () => {
  haptics.tap();
  setAppState('pick_dest');
});

dom.btnSwapWaypoints?.addEventListener('click', () => {
  haptics.tap();
  const temp = origin;
  origin = dest;
  dest = temp;

  if (origin) setOriginMarker(origin); else clearOriginMarker();
  if (dest) setDestMarker(dest); else clearDestMarker();

  updatePlannerLabels();
});

dom.btnModeDrive?.addEventListener('click', () => {
  haptics.tap();
  travelMode = 'drive';
  dom.btnModeDrive.classList.add('active');
  dom.btnModeWalk.classList.remove('active');
  if (currentRouteData && activeDestinationHaven) {
    autoEvacuateToSafety();
  } else if (currentRouteData && origin && dest) {
    requestRoute();
  }
});

dom.btnModeWalk?.addEventListener('click', () => {
  haptics.tap();
  travelMode = 'walk';
  dom.btnModeWalk.classList.add('active');
  dom.btnModeDrive.classList.remove('active');
  if (currentRouteData && activeDestinationHaven) {
    autoEvacuateToSafety();
  } else if (currentRouteData && origin && dest) {
    requestRoute();
  }
});

dom.btnCalcRoute?.addEventListener('click', () => {
  haptics.tap();
  requestRoute();
});

dom.btnCloseHud?.addEventListener('click', () => {
  haptics.tap();
  exitNavigation();
});

dom.btnClearRoute?.addEventListener('click', () => {
  haptics.tap();
  exitNavigation();
});

function exitNavigation() {
  clearRoute();
  currentRouteData = null;
  activeDestinationHaven = null;
  setAppState('idle');
}

// Live Hazard Feed API Triggers
dom.btnOpenFeedSync?.addEventListener('click', () => {
  haptics.tap();
  openApiSyncModal();
});

dom.btnPullApiFab?.addEventListener('click', () => {
  haptics.tap();
  openApiSyncModal();
});

dom.btnCloseSyncX?.addEventListener('click', () => {
  haptics.tap();
  hide(dom.apiSyncModal);
});

dom.btnSyncCancel?.addEventListener('click', () => {
  haptics.tap();
  hide(dom.apiSyncModal);
});

dom.btnTriggerApiSync?.addEventListener('click', () => {
  haptics.tap();
  syncHazardFeedsFromApis();
});

// Safe Shelters Directory
dom.btnViewSafeHavens?.addEventListener('click', () => {
  haptics.tap();
  openSafeHavensModal();
});

dom.btnCloseHavensX?.addEventListener('click', () => {
  haptics.tap();
  hide(dom.havensModal);
});

dom.btnHavensClose?.addEventListener('click', () => {
  haptics.tap();
  hide(dom.havensModal);
});

// Hazard reporting triggers
dom.btnSheetHazard?.addEventListener('click', () => {
  haptics.tap();
  openHazardModal(true);
});

dom.btnQuickHazard?.addEventListener('click', () => {
  haptics.tap();
  openHazardModal(true);
});

// Map HUD Controls
dom.btnCompass?.addEventListener('click', () => {
  haptics.tap();
  if (lastGPSLat !== null) {
    panTo({ lat: lastGPSLat, lon: lastGPSLon }, 16);
  } else {
    loadRegion();
  }
  toast('Aligned North');
});

dom.btnZoomIn?.addEventListener('click', () => {
  haptics.tap();
  zoomIn();
});

dom.btnZoomOut?.addEventListener('click', () => {
  haptics.tap();
  zoomOut();
});

dom.btnLocate?.addEventListener('click', () => {
  haptics.tap();
  locateMe();
});

dom.btnContrast?.addEventListener('click', () => {
  haptics.tap();
  toggleHighContrast();
});

dom.btnCacheTiles?.addEventListener('click', () => {
  haptics.tap();
  cacheCurrentMapArea();
});

// SOS buttons
dom.btnTopSos?.addEventListener('click', () => {
  haptics.sos();
  openSOSModal();
});

dom.btnSheetSos?.addEventListener('click', () => {
  haptics.sos();
  openSOSModal();
});

dom.btnShareRoute?.addEventListener('click', () => {
  haptics.tap();
  openSOSModal();
});

// Layers Modal
dom.btnLayers?.addEventListener('click', () => {
  haptics.tap();
  show(dom.layersModal);
});

dom.btnCloseLayers?.addEventListener('click', () => {
  haptics.tap();
  hide(dom.layersModal);
});

document.querySelectorAll('.layer-card-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    haptics.tap();
    const layer = btn.dataset.layer;
    setBasemap(layer);
    document.querySelectorAll('.layer-card-btn').forEach((b) => b.classList.toggle('active', b === btn));
    hide(dom.layersModal);
    toast(`Map layer: ${btn.querySelector('.layer-name').textContent}`);
  });
});

// Draw Controls
dom.btnUndo?.addEventListener('click', () => {
  haptics.tap();
  undoVertex();
  updateFinishBtn();
});

dom.btnFinish?.addEventListener('click', () => {
  haptics.tap();
  const ok = finishDraw();
  if (!ok) toast('Draw at least 3 points first.', 'error');
});

dom.btnCancelDraw?.addEventListener('click', () => {
  haptics.tap();
  setAppState('idle');
});

// Category Chips
document.querySelectorAll('.chip-item').forEach((chip) => {
  chip.addEventListener('click', () => {
    haptics.tap();
    document.querySelectorAll('.chip-item').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    const filter = chip.dataset.filter;
    if (filter === 'hazards') {
      const hazardIds = Object.keys(hazards);
      if (hazardIds.length > 0) {
        const first = hazards[hazardIds[0]];
        if (first.coordinates?.length) {
          panTo(first.coordinates[0], 16);
          toast(`Focused on active hazard: ${first.name || 'Hazard Zone'}`);
        }
      } else {
        toast('No active hazards on graph.');
      }
    } else if (filter === 'shelters') {
      openSafeHavensModal();
    } else if (filter === 'feeds') {
      openApiSyncModal();
    } else {
      toast(`Filter: ${chip.textContent.trim()}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Map Tap Handler
// ---------------------------------------------------------------------------

function onMapTap(latlng) {
  haptics.tap();

  if (appState === 'pick_origin') {
    origin = latlng;
    setOriginMarker(latlng);
    setAppState('planner');
    if (currentRouteData && dest) requestRoute();
  } else if (appState === 'pick_dest') {
    dest = latlng;
    setDestMarker(latlng);
    setAppState('planner');
    if (currentRouteData && origin) requestRoute();
  } else if (appState === 'idle') {
    dest = latlng;
    setDestMarker(latlng);
    setAppState('planner');
    toast('Destination selected. Tap "Calculate Safe Route"');
  }
}

function updatePlannerLabels() {
  if (origin) {
    dom.originLabel.textContent = `${origin.lat.toFixed(4)}, ${origin.lon.toFixed(4)}`;
    dom.originLabel.classList.remove('placeholder');
  } else {
    dom.originLabel.textContent = 'Current Location';
    dom.originLabel.classList.remove('placeholder');
  }

  if (dest) {
    dom.destLabel.textContent = `${dest.lat.toFixed(4)}, ${dest.lon.toFixed(4)}`;
    dom.destLabel.classList.remove('placeholder');
  } else {
    dom.destLabel.textContent = 'Select point on map…';
    dom.destLabel.classList.add('placeholder');
  }

  dom.btnCalcRoute.disabled = !(dest && (origin || lastGPSLat !== null));
}

// ---------------------------------------------------------------------------
// GPS Tracking
// ---------------------------------------------------------------------------

function startGPS() {
  if (!navigator.geolocation) {
    dom.gpsText.textContent = 'N/A';
    return;
  }

  navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lon, accuracy, heading } = pos.coords;
      lastGPSAccuracy = accuracy;
      if (heading !== null && !isNaN(heading)) {
        lastGPSHeading = heading;
      }

      if (lastGPSLat !== null) {
        const dx = (lat - lastGPSLat) * 111320;
        const dy = (lon - lastGPSLon) * 111320 * Math.cos((lat * Math.PI) / 180);
        if (Math.sqrt(dx * dx + dy * dy) < GPS_STILL_THRESHOLD) return;
      }
      lastGPSLat = lat;
      lastGPSLon = lon;

      const ll = { lat, lon, lng: lon };
      setUserLocation(ll, lastGPSHeading);
      dom.gpsText.textContent = accuracy < 25 ? 'Active' : `~${Math.round(accuracy)}m`;

      if (!origin) {
        origin = { lat, lon };
        updatePlannerLabels();
      }
    },
    () => {
      dom.gpsText.textContent = 'Off';
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

function locateMe() {
  if (lastGPSLat !== null) {
    panTo({ lat: lastGPSLat, lon: lastGPSLon }, 16);
    toast('Centered on position');
  } else {
    toast('Acquiring GPS position…');
  }
}

// ---------------------------------------------------------------------------
// Connectivity & Auto-Sync
// ---------------------------------------------------------------------------

async function pollConnectivity() {
  clearTimeout(connectivityTimer);
  if (!navigator.onLine) {
    setConnStatus('offline', 'Offline');
    connectivityTimer = setTimeout(pollConnectivity, 10000);
    return;
  }
  try {
    await api.health();
    setConnStatus('online', '1 Bar');
    const synced = await api.syncPending();
    if (synced > 0) {
      toast(`Synced ${synced} offline report${synced > 1 ? 's' : ''}`);
      await loadHazards();
      await loadSafeHavens();
    }
  } catch {
    setConnStatus('weak', 'Degraded');
  }
  connectivityTimer = setTimeout(pollConnectivity, 25000);
}

function setConnStatus(state, label) {
  if (dom.connectBadge) {
    dom.connectBadge.className = `status-badge ${state}`;
  }
  dom.connectText.textContent = label;
}

// ---------------------------------------------------------------------------
// Region, Hazards & Safe Havens Loading
// ---------------------------------------------------------------------------

async function loadRegion() {
  try {
    const reg = await api.region();
    if (reg?.place_name) {
      dom.topPlaceTitle.textContent = reg.place_name.split(',')[0];
      dom.topPlaceSub.textContent = `${reg.node_count.toLocaleString()} nodes • Ready`;
      dom.overviewSubtitle.textContent = `${reg.place_name.split(',')[0]} • Offline Network Ready`;
    }
    if (reg?.bounds && reg.bounds.min_lat !== 0 && !lastGPSLat) {
      const b = reg.bounds;
      fitBounds([[b.min_lat, b.min_lon], [b.max_lat, b.max_lon]]);
    }
  } catch { /* offline */ }
}

async function loadHazards() {
  try {
    const { hazards: list } = await api.hazards.list();
    clearAllHazardLayers();
    hazards = {};
    (list || []).forEach((zone) => {
      hazards[zone.hazard_id] = zone;
      addHazardLayer(zone);
    });
    updateHazardBadges();
  } catch { /* offline */ }
}

async function loadSafeHavens() {
  try {
    const res = await api.safeHavens.list();
    clearAllSafeHavenLayers();
    safeHavens = {};
    (res?.safe_havens || []).forEach((haven) => {
      safeHavens[haven.id] = haven;
      addSafeHavenLayer(haven);
    });
    updateHavenBadges();
  } catch { /* offline */ }
}

function updateHazardBadges() {
  const count = Object.keys(hazards).length;
  if (dom.chipHazardCount) dom.chipHazardCount.textContent = count;
  if (dom.hazardsCountBadge) dom.hazardsCountBadge.textContent = `${count} Hazard${count === 1 ? '' : 's'}`;
}

function updateHavenBadges() {
  const count = Object.keys(safeHavens).length;
  if (dom.chipShelterCount) dom.chipShelterCount.textContent = count;
  if (dom.sheltersCountBadge) dom.sheltersCountBadge.textContent = `${count} Safe Haven${count === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Automatic Evacuation to Safety (Fastest Safe Route Engine)
// ---------------------------------------------------------------------------

async function autoEvacuateToSafety() {
  const startPt = origin || (lastGPSLat !== null ? { lat: lastGPSLat, lon: lastGPSLon } : { lat: 40.7128, lon: -74.0060 });

  banner('Computing fastest safe route to evacuation shelter…');
  toast('Evaluating safe havens and active hazard perimeters…');

  try {
    const result = await api.routeSafety(startPt, travelMode, 'all', true);
    currentRouteData = result;
    activeDestinationHaven = result.destination_safe_haven;

    // Display destination haven beacon on map
    if (result.destination_safe_haven) {
      setSafeHavenDestinationMarker(result.destination_safe_haven);
      if (dom.routeHavenName) dom.routeHavenName.textContent = result.destination_safe_haven.name;
      if (dom.routeHavenAddress) dom.routeHavenAddress.textContent = result.destination_safe_haven.address || 'Verified Safe Clearance Zone';
      show(dom.routeHavenCard);
    } else {
      hide(dom.routeHavenCard);
    }

    showRoute(result.coordinates, result.is_fallback);
    renderRouteDeck(result);
    setAppState('route');
    haptics.success();
    toast(`Fastest safe route computed to: ${result.destination_safe_haven.name}`);
  } catch (err) {
    haptics.error();
    const msg = err.message || '';
    toast(`Unable to construct safety route: ${msg}`, 'error');
  }
}

function onEvacuateHaven(haven) {
  const startPt = origin || (lastGPSLat !== null ? { lat: lastGPSLat, lon: lastGPSLon } : null);
  if (!startPt) {
    toast('Acquiring location… Please retry in a moment.');
    return;
  }
  dest = haven.location;
  setDestMarker(dest);
  activeDestinationHaven = haven;
  requestRoute();
}

// ---------------------------------------------------------------------------
// Hazard API Feeds Synchronizer
// ---------------------------------------------------------------------------

function openApiSyncModal() {
  show(dom.apiSyncModal);
}

async function syncHazardFeedsFromApis() {
  const sources = [];
  if (dom.feedSourceNws?.checked) sources.push('nws');
  if (dom.feedSourceUsgs?.checked) sources.push('usgs');
  if (dom.feedSourceEonet?.checked) sources.push('eonet');
  if (dom.feedSourceSim?.checked) sources.push('simulation');

  const clearExisting = Boolean(dom.feedClearExisting?.checked);
  const center = lastGPSLat !== null ? { lat: lastGPSLat, lon: lastGPSLon } : (origin || null);

  const prevText = dom.btnTriggerApiSync?.querySelector('span')?.textContent || 'Pull Hazards';
  dom.btnTriggerApiSync.querySelector('span').textContent = 'Connecting to Feeds…';
  dom.btnTriggerApiSync.disabled = true;

  try {
    const res = await api.hazards.syncApi({
      center,
      radius_km: 15.0,
      sources: sources.length > 0 ? sources : ['simulation'],
      clear_existing: clearExisting,
    });

    hide(dom.apiSyncModal);
    await loadHazards();
    await loadSafeHavens();
    haptics.success();
    toast(res.message || `Pulled ${res.fetched_count} hazards from emergency APIs.`);

    // If currently on an active route, re-evaluate safety
    if (appState === 'route') {
      toast('Re-evaluating active route against updated hazard feeds…');
      if (activeDestinationHaven) {
        await autoEvacuateToSafety();
      } else if (origin && dest) {
        await requestRoute();
      }
    }
  } catch (err) {
    haptics.error();
    toast(`Feed sync failed: ${err.message}`, 'error');
  } finally {
    dom.btnTriggerApiSync.querySelector('span').textContent = prevText;
    dom.btnTriggerApiSync.disabled = false;
  }
}

async function autoSyncHazardsQuietly() {
  try {
    const center = lastGPSLat !== null ? { lat: lastGPSLat, lon: lastGPSLon } : (origin || null);
    await api.hazards.syncApi({ center, radius_km: 15.0, sources: ['nws', 'usgs', 'eonet'] });
    await loadHazards();
    await loadSafeHavens();
  } catch { /* quiet background update */ }
}

// ---------------------------------------------------------------------------
// Safe Havens Directory Modal
// ---------------------------------------------------------------------------

function openSafeHavensModal() {
  renderHavensList();
  show(dom.havensModal);
}

function renderHavensList() {
  if (!dom.havensListContainer) return;
  dom.havensListContainer.innerHTML = '';

  const havenList = Object.values(safeHavens);
  if (havenList.length === 0) {
    dom.havensListContainer.innerHTML = '<div style="color: #94a3b8; font-size: 12px; text-align: center; padding: 20px;">No safe havens discovered in region.</div>';
    return;
  }

  havenList.forEach((h) => {
    const card = document.createElement('div');
    card.className = `haven-list-item ${h.is_compromised ? 'compromised' : ''}`;

    const distStr = lastGPSLat !== null
      ? `${(computeRoughDistance(lastGPSLat, lastGPSLon, h.location.lat, h.location.lon) / 1000).toFixed(1)} km away`
      : '';

    const statusBadge = h.is_compromised
      ? `<span class="haven-alert-badge">Threat Near</span>`
      : `<span class="haven-safe-badge">SAFE</span>`;

    card.innerHTML = `
      <div class="haven-list-header">
        <div class="haven-list-name">${h.name}</div>
        ${statusBadge}
      </div>
      <div class="haven-list-address">${h.address || 'Designated Haven Point'}</div>
      <div class="haven-list-meta">
        <span style="font-size: 11px; color: #94a3b8;">${h.type.toUpperCase()} • ${distStr}</span>
        <button class="btn-haven-select" ${h.is_compromised ? 'disabled' : ''}>
          ${h.is_compromised ? 'Compromised' : 'Evacuate Here'}
        </button>
      </div>
    `;

    card.querySelector('.btn-haven-select')?.addEventListener('click', () => {
      hide(dom.havensModal);
      onEvacuateHaven(h);
    });

    dom.havensListContainer.appendChild(card);
  });
}

function computeRoughDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000.0;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Hazard Setup Modal
// ---------------------------------------------------------------------------

function openHazardModal(isRadialDefault = true) {
  dom.hazardInput.value = '';
  document.querySelectorAll('.type-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  document.querySelectorAll('.radius-btn').forEach((b, i) => b.classList.toggle('active', i === 1)); // 100m
  document.querySelectorAll('.buffer-btn').forEach((b, i) => b.classList.toggle('active', i === 0));

  if (isRadialDefault) {
    show(dom.hazardRadiusSec);
    dom.tabHazardRadial.classList.add('active');
    dom.tabHazardPoly.classList.remove('active');
    dom.hazardModal.dataset.mode = 'radial';
  } else {
    hide(dom.hazardRadiusSec);
    dom.tabHazardPoly.classList.add('active');
    dom.tabHazardRadial.classList.remove('active');
    dom.hazardModal.dataset.mode = 'polygon';
  }

  show(dom.hazardModal);
  setTimeout(() => dom.hazardInput.focus(), 150);
}

dom.tabHazardRadial?.addEventListener('click', () => {
  haptics.tap();
  dom.tabHazardRadial.classList.add('active');
  dom.tabHazardPoly.classList.remove('active');
  show(dom.hazardRadiusSec);
  dom.hazardModal.dataset.mode = 'radial';
});

dom.tabHazardPoly?.addEventListener('click', () => {
  haptics.tap();
  dom.tabHazardPoly.classList.add('active');
  dom.tabHazardRadial.classList.remove('active');
  hide(dom.hazardRadiusSec);
  dom.hazardModal.dataset.mode = 'polygon';
});

dom.btnHazardCloseX?.addEventListener('click', () => {
  haptics.tap();
  hide(dom.hazardModal);
});

dom.btnHazardCancel?.addEventListener('click', () => {
  haptics.tap();
  hide(dom.hazardModal);
});

dom.btnHazardSubmit?.addEventListener('click', () => {
  haptics.tap();
  submitHazard();
});

document.querySelectorAll('.type-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    haptics.tap();
    document.querySelectorAll('.type-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.querySelectorAll('.radius-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    haptics.tap();
    document.querySelectorAll('.radius-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.querySelectorAll('.buffer-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    haptics.tap();
    document.querySelectorAll('.buffer-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

async function submitHazard() {
  const mode = dom.hazardModal.dataset.mode || 'radial';
  const name = dom.hazardInput.value.trim() || null;
  const type = document.querySelector('.type-btn.active')?.dataset.type ?? 'closure';
  const bufferMeters = parseFloat(document.querySelector('.buffer-btn.active')?.dataset.buffer ?? '0');

  hide(dom.hazardModal);

  if (mode === 'polygon') {
    setAppState('draw');
    return;
  }

  // Radial Hazard Submission
  const radiusMeters = parseFloat(document.querySelector('.radius-btn.active')?.dataset.radius ?? '100');
  const center = lastGPSLat !== null ? { lat: lastGPSLat, lon: lastGPSLon } : (origin || { lat: 40.7128, lon: -74.0060 });

  const payload = {
    name,
    hazard_type: type,
    center,
    radius_meters: radiusMeters,
    buffer_meters: bufferMeters,
    source: 'manual',
    severity: 'severe',
  };

  try {
    const zone = await api.hazards.add(payload);
    hazards[zone.hazard_id] = zone;
    addHazardLayer(zone);
    updateHazardBadges();
    await loadSafeHavens();
    haptics.success();
    toast('Hazard perimeter registered on graph');
    if (currentRouteData && activeDestinationHaven) {
      autoEvacuateToSafety();
    } else if (currentRouteData && origin && dest) {
      requestRoute();
    }
  } catch (err) {
    haptics.error();
    toast(`Failed to register hazard: ${err.message}`, 'error');
  }
}

function onPolygonDrawn(coords) {
  setAppState('idle');
  dom.hazardInput.value = '';
  document.querySelectorAll('.type-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  hide(dom.hazardRadiusSec);
  dom.tabHazardPoly.classList.add('active');
  dom.tabHazardRadial.classList.remove('active');
  dom.hazardModal.dataset.mode = 'polygon_submit';
  dom.hazardModal.dataset.pendingCoords = JSON.stringify(coords);
  show(dom.hazardModal);
}

async function onHazardDelete(hazardId) {
  try {
    await api.hazards.remove(hazardId);
    delete hazards[hazardId];
    removeHazardLayer(hazardId);
    updateHazardBadges();
    await loadSafeHavens();
    haptics.success();
    toast('Hazard removed from network graph');
    if (currentRouteData && activeDestinationHaven) {
      autoEvacuateToSafety();
    } else if (currentRouteData && origin && dest) {
      requestRoute();
    }
  } catch (err) {
    haptics.error();
    toast(`Failed to remove hazard: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Route Calculation & Navigation Guidance
// ---------------------------------------------------------------------------

async function requestRoute() {
  const startPt = origin || (lastGPSLat !== null ? { lat: lastGPSLat, lon: lastGPSLon } : null);
  if (!startPt || !dest) {
    toast('Please set both Origin and Destination.', 'error');
    return;
  }

  const prevText = dom.btnCalcRoute.querySelector('span').textContent;
  dom.btnCalcRoute.querySelector('span').textContent = 'Computing Route…';
  dom.btnCalcRoute.disabled = true;

  try {
    const result = await api.route(startPt, dest, travelMode, true);
    currentRouteData = result;

    if (activeDestinationHaven) {
      setSafeHavenDestinationMarker(activeDestinationHaven);
      if (dom.routeHavenName) dom.routeHavenName.textContent = activeDestinationHaven.name;
      if (dom.routeHavenAddress) dom.routeHavenAddress.textContent = activeDestinationHaven.address || 'Designated Haven';
      show(dom.routeHavenCard);
    } else {
      hide(dom.routeHavenCard);
    }

    showRoute(result.coordinates, result.is_fallback);
    renderRouteDeck(result);
    setAppState('route');
    haptics.success();
  } catch (err) {
    haptics.error();
    const msg = err.message || '';
    const isBlocked = msg.toLowerCase().includes('viable') || msg.includes('409');
    toast(
      isBlocked
        ? 'No passable path found. All paths are blocked by active hazards.'
        : `Routing error: ${msg}`,
      'error'
    );
  } finally {
    dom.btnCalcRoute.querySelector('span').textContent = prevText;
    dom.btnCalcRoute.disabled = false;
  }
}

function renderRouteDeck(result) {
  const mins = Math.max(1, Math.round(result.total_travel_time_seconds / 60));
  const km = (result.total_distance_meters / 1000).toFixed(1);

  dom.routeTime.textContent = mins;
  dom.routeDist.textContent = km;
  dom.routeBlocked.textContent = result.blocked_edges_avoided;

  if (result.warning) {
    dom.routeWarn.textContent = result.warning;
    show(dom.routeWarn);
  } else {
    hide(dom.routeWarn);
  }

  // Update Top Navigation Guidance HUD
  const maneuvers = result.maneuvers || [];
  if (maneuvers.length > 0) {
    const first = maneuvers[0];
    dom.hudTurnIcon.innerHTML = MANEUVER_SVGS[first.type] || MANEUVER_SVGS.straight;
    dom.hudInstruction.textContent = first.instruction;
    const distStr = first.distance_meters > 0
      ? (first.distance_meters >= 1000 ? `${(first.distance_meters / 1000).toFixed(1)} km` : `${Math.round(first.distance_meters)} m`)
      : 'Destination';
    const destHavenStr = activeDestinationHaven ? `to ${activeDestinationHaven.name.split(' ')[0]}` : '';
    const nextStep = maneuvers.length > 1 ? `Then ${maneuvers[1].instruction.toLowerCase()}` : `Evacuate ${destHavenStr}`;
    dom.hudSubInstr.textContent = `In ${distStr} • ${nextStep}`;
  }

  // Render Turn-by-Turn Maneuvers List in Bottom Sheet
  dom.maneuversList.innerHTML = '';
  dom.maneuversCount.textContent = `${maneuvers.length} steps`;

  maneuvers.forEach((m) => {
    const li = document.createElement('li');
    li.className = 'maneuver-item';
    const iconSvg = MANEUVER_SVGS[m.type] || MANEUVER_SVGS.straight;
    const distText = m.distance_meters > 0
      ? (m.distance_meters >= 1000 ? `${(m.distance_meters / 1000).toFixed(1)} km` : `${Math.round(m.distance_meters)} m`)
      : 'Safe Destination';

    li.innerHTML = `
      <div class="maneuver-icon">${iconSvg}</div>
      <div class="maneuver-body">
        <div class="maneuver-instruction">${m.instruction}</div>
        <div class="maneuver-distance">${distText}</div>
      </div>
    `;

    li.addEventListener('click', () => {
      haptics.tap();
      if (m.location) {
        highlightManeuver(m.location);
      }
    });

    dom.maneuversList.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// SOS Emergency Beacon
// ---------------------------------------------------------------------------

function openSOSModal() {
  const lat = lastGPSLat !== null ? lastGPSLat.toFixed(5) : (origin ? origin.lat.toFixed(5) : 'Unknown');
  const lon = lastGPSLon !== null ? lastGPSLon.toFixed(5) : (origin ? origin.lon.toFixed(5) : 'Unknown');
  const accuracy = lastGPSAccuracy ? `~${Math.round(lastGPSAccuracy)}m` : 'N/A';

  dom.sosCoordsText.textContent = `${lat}, ${lon} (Accuracy: ${accuracy})`;

  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const mapLink = `https://maps.google.com/?q=${lat},${lon}`;
  const appleMapLink = `https://maps.apple.com/?ll=${lat},${lon}&q=Emergency+Evacuation+Point`;
  const hazardCount = Object.keys(hazards).length;

  let body = `EMERGENCY SOS via OneBar [${timestamp}]:\nPosition: ${lat}, ${lon} (${accuracy})\nMap: ${mapLink}\nApple Maps: ${appleMapLink}\nActive Hazards in Area: ${hazardCount}`;

  if (activeDestinationHaven) {
    const etaMins = currentRouteData ? Math.max(1, Math.round(currentRouteData.total_travel_time_seconds / 60)) : 10;
    body += `\nEvacuating To Haven: ${activeDestinationHaven.name} (${activeDestinationHaven.location.lat.toFixed(4)}, ${activeDestinationHaven.location.lon.toFixed(4)}) - ETA: ${etaMins}m`;
  } else if (currentRouteData && dest) {
    const etaMins = Math.max(1, Math.round(currentRouteData.total_travel_time_seconds / 60));
    body += `\nEvacuating To: ${dest.lat.toFixed(5)}, ${dest.lon.toFixed(5)} (ETA: ${etaMins} min)`;
  }

  dom.sosPreview.value = body;
  show(dom.sosModal);
}

dom.btnCloseSosX?.addEventListener('click', () => {
  haptics.tap();
  hide(dom.sosModal);
});

dom.btnSendSms?.addEventListener('click', () => {
  haptics.tap();
  const body = encodeURIComponent(dom.sosPreview.value);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const smsUrl = isIOS ? `sms:&body=${body}` : `sms:?body=${body}`;
  window.location.href = smsUrl;
});

dom.btnCopyCoords?.addEventListener('click', () => {
  haptics.tap();
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(dom.sosPreview.value).then(() => {
      haptics.success();
      toast('SOS payload copied to clipboard');
    });
  } else {
    dom.sosPreview.select();
    document.execCommand('copy');
    haptics.success();
    toast('SOS payload copied to clipboard');
  }
});

// ---------------------------------------------------------------------------
// High Contrast & Offline Pre-Caching
// ---------------------------------------------------------------------------

function initHighContrastState() {
  const saved = localStorage.getItem('onebar_contrast') === 'true';
  if (saved) {
    isHighContrast = true;
    document.body.classList.add('high-contrast');
    setHighContrastMap(true);
  }
}

function toggleHighContrast() {
  isHighContrast = !isHighContrast;
  document.body.classList.toggle('high-contrast', isHighContrast);
  setHighContrastMap(isHighContrast);
  localStorage.setItem('onebar_contrast', String(isHighContrast));
  toast(isHighContrast ? 'High-contrast HUD enabled' : 'Standard theme restored');
}

async function cacheCurrentMapArea() {
  const bounds = getMapBounds();
  if (!bounds) {
    toast('Unable to determine map bounds.', 'error');
    return;
  }

  toast('Caching region tiles for offline use…');
  try {
    const result = await preCacheRegionTiles(bounds, 13, 16, (cached, total) => {
      if (cached % 15 === 0 || cached === total) {
        toast(`Caching offline tiles: ${cached}/${total}…`);
      }
    });
    haptics.success();
    toast(`Cached ${result.cached} map tiles for offline usage`);
  } catch (err) {
    haptics.error();
    toast(`Cache failed: ${err.message}`, 'error');
  }
}

function updateFinishBtn(count) {
  const n = count ?? drawVertexCount();
  dom.btnFinish.querySelector('.btn-label').textContent = n < 3 ? `Finish (${n}/3)` : `Finish (${n} pts)`;
  dom.btnFinish.disabled = n < 3;
}

function banner(text) {
  dom.banner.textContent = text;
  show(dom.banner);
}

function toast(msg, type = '') {
  clearTimeout(toastTimer);
  dom.toast.textContent = msg;
  dom.toast.className = type;
  show(dom.toast);
  toastTimer = setTimeout(() => hide(dom.toast), 4000);
}

// Global debug
window.__onebar = { setAppState, api, autoEvacuateToSafety, syncHazardFeedsFromApis, preCacheRegionTiles, setBasemap };
