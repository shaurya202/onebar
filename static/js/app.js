import { api } from './api.js';
import { haptics } from './haptics.js';
import { listContacts, saveContacts, smsHref, MAX_CONTACTS } from './contacts.js';
import { closeModal, openModal } from './focus-trap.js';
import { fetchCatalogue, downloadPack, installedPacks } from './pack-store.js';
import { routeOffline, hasOfflineCoverage, offlineHavens } from './offline-router.js';
import { cancelSearch, searchDebounced } from './search.js';
import { clearTrip, describeAge, flushTrip, loadTrip, saveTrip } from './trip-store.js';
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
let isLargeText = false;
let wakeLock = null;
let searchResults = [];
let searchActiveIndex = -1;
let sosRecipients = new Set();
let sosRecipientsInitialised = false;
let onboardingStep = 1;
let onboardingRegion = null;
let restoredTrip = null;
let destName = null;

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
  topPlaceSub:         $('top-place-subtitle'),
  connectBadge:        $('connectivity-badge'),
  connectDot:          document.querySelector('.signal-bars-icon'),
  connectText:         $('connectivity-text'),
  serviceBadge:        $('service-badge'),
  serviceText:         $('service-text'),
  pendingBadge:        $('pending-badge'),
  pendingText:         $('pending-text'),
  gpsText:             $('gps-text'),

  // Destination search
  searchInput:         $('search-input'),
  searchResults:       $('search-results'),
  btnSearchClear:      $('btn-search-clear'),

  // Resumed trip
  resumeBanner:        $('resume-trip-banner'),
  resumeAge:           $('resume-age'),
  resumeDestination:   $('resume-destination'),
  btnResumeTrip:       $('btn-resume-trip'),
  btnDismissTrip:      $('btn-dismiss-trip'),
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
  drillBanner:         $('drill-banner'),
  btnExitDrill:        $('btn-exit-drill'),
  welcomeModal:        $('welcome-modal'),
  btnCallEmergency:    $('btn-call-emergency'),
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
  btnShareLocation:    $('btn-share-location'),
  sosContactList:      $('sos-contact-list'),
  btnManageContacts:   $('btn-manage-contacts'),

  // Onboarding
  onboardProgress:     document.querySelector('.onboarding-progress'),
  onboardTitle:        $('welcome-title'),
  onboardSteps:        Array.from(document.querySelectorAll('.onboarding-step')),
  btnOnboardBack:      $('btn-onboard-back'),
  btnOnboardNext:      $('btn-onboard-next'),
  btnOnboardLocation:  $('btn-onboard-location'),
  onboardLocationMsg:  $('onboard-location-status'),
  btnOnboardContacts:  $('btn-onboard-contacts'),
  onboardContactsMsg:  $('onboard-contacts-summary'),
  btnOnboardDownload:  $('btn-onboard-download'),
  onboardRegionMsg:    $('onboard-region-summary'),

  // Emergency contacts
  contactsModal:       $('contacts-modal'),
  contactsFields:      $('contacts-fields'),
  btnCloseContactsX:   $('btn-close-contacts-x'),
  btnContactsCancel:   $('btn-contacts-cancel'),
  btnContactsSave:     $('btn-contacts-save'),

  // Hazard sharing
  hazardShareToggle:   $('hazard-share-toggle'),
  hazardExpiryNote:    $('hazard-expiry-note'),

  // Display settings
  settingContrast:     $('btn-toggle-contrast-setting'),
  settingLargeText:    $('btn-toggle-large-text'),
};


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

  // The name belonged to the old destination. Keeping it would label the swapped
  // destination "Broadway" when it is now wherever the origin used to be.
  destName = null;
  activeDestinationHaven = null;

  if (origin) setOriginMarker(origin); else clearOriginMarker();
  if (dest) setDestMarker(dest); else clearDestMarker();

  updatePlannerLabels();
  if (dest) nameDroppedPin(dest);
  persistTrip();
});

function selectTravelMode(mode) {
  travelMode = mode;
  dom.btnModeDrive?.classList.toggle('active', mode === 'drive');
  dom.btnModeWalk?.classList.toggle('active', mode === 'walk');
  dom.btnModeDrive?.setAttribute('aria-pressed', String(mode === 'drive'));
  dom.btnModeWalk?.setAttribute('aria-pressed', String(mode === 'walk'));
  persistTrip();
}

dom.btnModeDrive?.addEventListener('click', () => {
  haptics.tap();
  selectTravelMode('drive');
  if (currentRouteData && activeDestinationHaven) {
    autoEvacuateToSafety();
  } else if (currentRouteData && origin && dest) {
    requestRoute();
  }
});

dom.btnModeWalk?.addEventListener('click', () => {
  haptics.tap();
  selectTravelMode('walk');
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
  clearTrip();
  setAppState('idle');
}

/**
 * Write the journey to IndexedDB.
 *
 * Origin, destination, mode, the computed route and the chosen haven lived in module
 * variables and nowhere else, so an app kill part-way through an evacuation — which is
 * what a phone at 3% battery does — lost the route with no signal to recompute it.
 */
function persistTrip() {
  if (!origin && !dest && !currentRouteData) return;
  saveTrip({
    origin,
    dest,
    travelMode,
    route: currentRouteData,
    haven: activeDestinationHaven,
  });
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
  closeModal(dom.apiSyncModal);
});

dom.btnSyncCancel?.addEventListener('click', () => {
  haptics.tap();
  closeModal(dom.apiSyncModal);
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
  closeModal(dom.havensModal);
});

dom.btnHavensClose?.addEventListener('click', () => {
  haptics.tap();
  closeModal(dom.havensModal);
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
  downloadRegionForOffline();
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
  openModal(dom.layersModal);
});

dom.btnCloseLayers?.addEventListener('click', () => {
  haptics.tap();
  closeModal(dom.layersModal);
});

document.querySelectorAll('.layer-card-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    haptics.tap();
    const layer = btn.dataset.layer;
    setBasemap(layer);
    document.querySelectorAll('.layer-card-btn').forEach((b) => b.classList.toggle('active', b === btn));
    closeModal(dom.layersModal);
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
    destName = null;
    setDestMarker(latlng);
    setAppState('planner');
    nameDroppedPin(latlng);
    persistTrip();
    if (currentRouteData && origin) requestRoute();
  } else if (appState === 'idle') {
    dest = latlng;
    destName = null;
    setDestMarker(latlng);
    setAppState('planner');
    nameDroppedPin(latlng);
    persistTrip();
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
    // A name beats a coordinate pair every time — "Near Fulton Street" is something a
    // person can check against what they can see.
    dom.destLabel.textContent = destName || `${dest.lat.toFixed(4)}, ${dest.lon.toFixed(4)}`;
    dom.destLabel.classList.remove('placeholder');
  } else {
    dom.destLabel.textContent = 'Search above, or tap the map…';
    dom.destLabel.classList.add('placeholder');
  }

  dom.btnCalcRoute.disabled = !(dest && (origin || lastGPSLat !== null));
}

/** Best-effort name for a dropped pin. Silent on failure; a wrong name is worse. */
async function nameDroppedPin(point) {
  const fallback = `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`;
  destName = fallback;
  updatePlannerLabels();
  try {
    const result = await api.reverseGeocode(point.lat, point.lon);
    if (result?.name && dest && dest.lat === point.lat && dest.lon === point.lon) {
      destName = result.name;
      updatePlannerLabels();
    }
  } catch { /* offline, or nothing nearby worth naming */ }
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
      const hadNoFix = lastGPSLat === null;
      lastGPSLat = lat;
      lastGPSLon = lon;

      // The first fix is the moment the app learns where it is. Anything that gave up
      // for want of a position — the offline shelter list, most importantly — gets one
      // more go now rather than staying empty until the next connectivity poll.
      if (hadNoFix) loadSafeHavens();

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

/**
 * Two separate facts, previously reported as one.
 *
 * The badge was drawn as cellular signal bars but actually reflected whether the
 * OneBar server answered: it read "1 Bar" on office wifi with no cell service at all,
 * and "Degraded" on a full four bars when the backend was down. Those are different
 * problems with different responses, so they now have different indicators.
 */
async function pollConnectivity() {
  clearTimeout(connectivityTimer);
  updateDeviceConnectivity();

  if (!navigator.onLine) {
    setServiceStatus('down', 'Offline mode');
    updatePendingBadge();
    connectivityTimer = setTimeout(pollConnectivity, 10000);
    return;
  }

  try {
    const started = performance.now();
    await api.health();
    const elapsed = performance.now() - started;
    // A reachable but very slow server is worth distinguishing: it is the state where
    // waiting for the server instead of routing on-device costs the most.
    setServiceStatus(elapsed > 2500 ? 'degraded' : 'ok', elapsed > 2500 ? 'Service slow' : 'Service OK');

    const synced = await api.syncPending();
    if (synced > 0) {
      toast(`Uploaded ${synced} report${synced > 1 ? 's' : ''} saved while you were offline`);
      await loadHazards();
      await loadSafeHavens();
    }
  } catch {
    setServiceStatus('down', 'No service');
  }
  updatePendingBadge();
  connectivityTimer = setTimeout(pollConnectivity, 25000);
}

/** Whether this device has a connection at all — and how good, where the OS says. */
function updateDeviceConnectivity() {
  if (!dom.connectBadge) return;

  if (!navigator.onLine) {
    dom.connectBadge.className = 'status-badge offline';
    dom.connectText.textContent = 'Offline';
    dom.connectBadge.title = 'This device has no connection';
    return;
  }

  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const effective = connection?.effectiveType;
  const weak = effective === 'slow-2g' || effective === '2g';
  dom.connectBadge.className = `status-badge ${weak ? 'weak' : 'online'}`;
  dom.connectText.textContent = weak ? (effective === 'slow-2g' ? 'Very weak' : 'Weak') : 'Online';
  dom.connectBadge.title = connection?.type
    ? `Connected over ${connection.type}`
    : 'This device has a connection';
}

function setServiceStatus(state, label) {
  if (dom.serviceBadge) dom.serviceBadge.className = `status-badge ${state}`;
  if (dom.serviceText) dom.serviceText.textContent = label;
  if (dom.serviceBadge) {
    dom.serviceBadge.title = state === 'ok'
      ? 'OneBar\u2019s server is reachable'
      : 'OneBar\u2019s server is not reachable — routing falls back to your downloaded map';
  }
}

/**
 * Reports written while offline are held on this device.
 *
 * They used to raise the same success toast as a synced one, so there was no way to
 * tell what had actually been filed and what was still sitting in a queue.
 */
async function updatePendingBadge() {
  if (!dom.pendingBadge) return;
  let count = 0;
  try {
    count = await api.pendingCount();
  } catch { /* storage unavailable — treat as nothing queued */ }

  if (count > 0) {
    dom.pendingText.textContent = `${count} waiting to upload`;
    show(dom.pendingBadge);
  } else {
    hide(dom.pendingBadge);
  }
}

// ---------------------------------------------------------------------------
// Region, Hazards & Safe Havens Loading
// ---------------------------------------------------------------------------

async function loadRegion() {
  try {
    const reg = await api.region();
    const place = reg?.place_name ? reg.place_name.split(',')[0] : 'Downloaded area';
    if (reg?.synthetic) {
      // The server has no road network and is serving a placeholder grid. Saying
      // "ready" here would be the same lie the app refuses to tell about hazards.
      dom.topPlaceSub.textContent = 'No map loaded on the server';
      dom.overviewSubtitle.textContent = installedPacks().length
        ? 'Routing from your downloaded map only'
        : 'No map available — download an area, or contact the operator';
      banner('This server has no road network loaded. Routing needs a downloaded map.');
      return;
    }
    if (reg) {
      const roads = (reg.edge_count || 0).toLocaleString();
      dom.topPlaceSub.textContent = `${place} • ${roads} roads`;
      dom.overviewSubtitle.textContent = installedPacks().length
        ? `${place} • Works offline`
        : `${place} • Download this area to work offline`;
      // A graph with no drivable roads cannot honestly serve a drive request; say so
      // rather than letting the user pick a mode that will be refused.
      const modes = reg.supported_modes || [];
      if (modes.length && dom.btnModeDrive && dom.btnModeWalk) {
        dom.btnModeDrive.disabled = !modes.includes('drive');
        dom.btnModeWalk.disabled = !modes.includes('walk');
        if (!modes.includes(travelMode) && modes.length) selectTravelMode(modes[0]);
      }
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
    updateDrillBanner();
  } catch { /* offline */ }
}

async function loadSafeHavens() {
  let list = null;
  try {
    const res = await api.safeHavens.list();
    list = res?.safe_havens || [];
  } catch {
    // Offline: fall back to the havens bundled in the downloaded region pack. Losing
    // the shelter list is the last thing that should happen when the network drops.
    //
    // Anchored on the pack rather than on GPS. Gating this on a position fix meant an
    // offline cold start — where boot runs before the first fix arrives — found no
    // shelters, and nothing ever retried, so the map stayed empty for the session.
    try {
      const anchor = havenAnchor();
      if (anchor) list = await offlineHavens(anchor.lat, anchor.lon);
    } catch { /* no pack installed */ }
  }

  // An empty array is a real answer from the server and must replace the map. An empty
  // array from a *failed* offline lookup is not, and wiping every shelter on the map
  // because a pack could not be read is the opposite of degrading gracefully.
  if (!Array.isArray(list)) return;

  clearAllSafeHavenLayers();
  safeHavens = {};
  list.forEach((haven) => {
    safeHavens[haven.id] = haven;
    addSafeHavenLayer(haven);
  });
  updateHavenBadges();
}

/** A position to read the pack's haven list from: the user's, or the pack's centre. */
function havenAnchor() {
  if (lastGPSLat !== null && lastGPSLon !== null) return { lat: lastGPSLat, lon: lastGPSLon };
  const installed = installedPacks();
  const bounds = installed[0]?.bounds;
  if (!bounds) return null;
  return {
    lat: (bounds.min_lat + bounds.max_lat) / 2,
    lon: (bounds.min_lon + bounds.max_lon) / 2,
  };
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
// Safety gate, emergency dialling and drill-mode disclosure
// ---------------------------------------------------------------------------

const ACCEPTED_KEY = 'onebar_safety_ack_v1';

// Emergency numbers by region. 112 works across the EU and on GSM networks
// generally, so it is the safest default when we cannot identify the country.
const EMERGENCY_NUMBERS = {
  US: '911', CA: '911', MX: '911',
  GB: '999', IE: '999',
  AU: '000', NZ: '111',
  IN: '112', JP: '119', CN: '120', BR: '192', ZA: '10111',
};

function emergencyNumber() {
  try {
    const locale = navigator.language || '';
    const region = (locale.split('-')[1] || '').toUpperCase();
    return EMERGENCY_NUMBERS[region] || '112';
  } catch {
    return '112';
  }
}

function initEmergencyCall() {
  const number = emergencyNumber();
  if (dom.btnCallEmergency) {
    dom.btnCallEmergency.setAttribute('href', `tel:${number}`);
    const label = dom.btnCallEmergency.querySelector('span');
    if (label) label.textContent = `Call ${number}`;
  }
}

/**
 * First run.
 *
 * The app used to fire `initMap → startGPS → loadRegion` synchronously at module load:
 * the OS location prompt appeared cold, before the user had been told what OneBar is,
 * what it is not, or that it needs a downloaded map to keep working. This walks through
 * that in order, and asks for nothing until the reason for it has been given.
 */
const ONBOARDING_TOTAL = 5;
const ONBOARDING_TITLES = {
  1: 'What OneBar does',
  2: 'Before you rely on it',
  3: 'Your location',
  4: 'Emergency contacts',
  5: 'Download your area',
};

let onboardingDone = null;

function initOnboarding(onAccepted) {
  onboardingDone = onAccepted;

  let accepted = false;
  try {
    accepted = localStorage.getItem(ACCEPTED_KEY) === '1';
  } catch { /* private mode — show the gate again, which is the safe direction */ }

  if (accepted) {
    onAccepted();
    return;
  }

  onboardingStep = 1;
  renderOnboardingStep();
  // Not dismissible: the safety statement is the point of the screen.
  openModal(dom.welcomeModal, { dismissible: false, initialFocus: dom.btnOnboardNext });

  dom.btnOnboardNext?.addEventListener('click', () => {
    haptics.tap();
    if (onboardingStep >= ONBOARDING_TOTAL) {
      finishOnboarding();
    } else {
      onboardingStep += 1;
      renderOnboardingStep();
    }
  });

  dom.btnOnboardBack?.addEventListener('click', () => {
    haptics.tap();
    onboardingStep = Math.max(1, onboardingStep - 1);
    renderOnboardingStep();
  });

  dom.btnOnboardLocation?.addEventListener('click', requestLocationDuringOnboarding);
  dom.btnOnboardContacts?.addEventListener('click', () => openContactsModal());
  dom.btnOnboardDownload?.addEventListener('click', downloadDuringOnboarding);
}

function renderOnboardingStep() {
  dom.onboardSteps.forEach((section) => {
    section.classList.toggle('hidden', Number(section.dataset.step) !== onboardingStep);
  });

  if (dom.onboardTitle) dom.onboardTitle.textContent = ONBOARDING_TITLES[onboardingStep];
  if (dom.onboardProgress) {
    dom.onboardProgress.setAttribute('aria-valuenow', String(onboardingStep));
    Array.from(dom.onboardProgress.children).forEach((dot, index) => {
      dot.classList.toggle('active', index + 1 === onboardingStep);
      dot.classList.toggle('done', index + 1 < onboardingStep);
    });
  }

  if (dom.btnOnboardBack) dom.btnOnboardBack.hidden = onboardingStep === 1;
  const nextLabel = dom.btnOnboardNext?.querySelector('span');
  if (nextLabel) {
    nextLabel.textContent = onboardingStep === ONBOARDING_TOTAL
      ? 'Start using OneBar'
      : (onboardingStep === 3 || onboardingStep === 4 ? 'Skip for now' : 'Continue');
  }

  if (onboardingStep === 4) renderOnboardingContacts();
  if (onboardingStep === 5) loadOnboardingRegion();
}

function renderOnboardingContacts() {
  const contacts = listContacts();
  if (!dom.onboardContactsMsg) return;
  dom.onboardContactsMsg.textContent = contacts.length
    ? `Saved: ${contacts.map((c) => c.name).join(', ')}`
    : 'No contacts yet.';
  dom.onboardContactsMsg.className = `onboarding-status ${contacts.length ? 'ok' : ''}`;
  const label = dom.btnOnboardContacts?.querySelector('span');
  if (label) label.textContent = contacts.length ? 'Edit emergency contacts' : 'Add emergency contacts';
  const nextLabel = dom.btnOnboardNext?.querySelector('span');
  if (nextLabel && contacts.length) nextLabel.textContent = 'Continue';
}

function requestLocationDuringOnboarding() {
  haptics.tap();
  if (!navigator.geolocation) {
    setOnboardingStatus(dom.onboardLocationMsg, 'This device has no location services.', 'warn');
    return;
  }
  setOnboardingStatus(dom.onboardLocationMsg, 'Waiting for the location prompt…');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      lastGPSLat = position.coords.latitude;
      lastGPSLon = position.coords.longitude;
      setUserLocation({ lat: lastGPSLat, lon: lastGPSLon }, lastGPSHeading);
      panTo({ lat: lastGPSLat, lon: lastGPSLon }, 15);
      setOnboardingStatus(dom.onboardLocationMsg, 'Location on. OneBar can route from where you are.', 'ok');
      const nextLabel = dom.btnOnboardNext?.querySelector('span');
      if (nextLabel) nextLabel.textContent = 'Continue';
    },
    () => {
      // Refusal is a legitimate answer. The app still works from a pin dropped by hand.
      setOnboardingStatus(
        dom.onboardLocationMsg,
        'Location is off. You can still use OneBar by tapping the map to set where you are.',
        'warn',
      );
    },
    { enableHighAccuracy: true, timeout: 20000 },
  );
}

async function loadOnboardingRegion() {
  if (onboardingRegion || !dom.onboardRegionMsg) return;
  try {
    const catalogue = await fetchCatalogue();
    const regions = catalogue?.regions || [];
    if (!regions.length) {
      setOnboardingStatus(dom.onboardRegionMsg, 'No downloadable regions are published yet.', 'warn');
      return;
    }
    onboardingRegion = pickRegionForPosition(regions);
    const megabytes = (onboardingRegion.bytes / 1e6).toFixed(1);
    setOnboardingStatus(
      dom.onboardRegionMsg,
      `${onboardingRegion.name} — ${megabytes} MB, stored on this phone.`,
    );
    if (dom.btnOnboardDownload) dom.btnOnboardDownload.disabled = false;
  } catch {
    setOnboardingStatus(
      dom.onboardRegionMsg,
      'Could not reach the region catalogue. You can download a map later from the map screen.',
      'warn',
    );
  }
}

async function downloadDuringOnboarding() {
  if (!onboardingRegion) return;
  haptics.tap();
  dom.btnOnboardDownload.disabled = true;
  try {
    await downloadPack(onboardingRegion, {
      onProgress: (received, total) => {
        if (!total) return;
        const pct = Math.round((received / total) * 100);
        setOnboardingStatus(dom.onboardRegionMsg, `Downloading ${onboardingRegion.name} — ${pct}%`);
      },
    });
    haptics.success();
    setOnboardingStatus(dom.onboardRegionMsg, `${onboardingRegion.name} saved. Routing now works offline.`, 'ok');
    updateOfflineReadiness();
    loadRegion();
  } catch (err) {
    haptics.error();
    setOnboardingStatus(dom.onboardRegionMsg, `Download failed: ${err.message}`, 'warn');
    dom.btnOnboardDownload.disabled = false;
  }
}

function pickRegionForPosition(regions) {
  if (lastGPSLat === null || lastGPSLon === null) return regions[0];
  return regions.find((r) => lastGPSLat >= r.bounds.min_lat && lastGPSLat <= r.bounds.max_lat
    && lastGPSLon >= r.bounds.min_lon && lastGPSLon <= r.bounds.max_lon) || regions[0];
}

function setOnboardingStatus(element, text, tone = '') {
  if (!element) return;
  element.textContent = text;
  element.className = `onboarding-status ${tone}`;
}

function finishOnboarding() {
  try { localStorage.setItem(ACCEPTED_KEY, '1'); } catch { /* ignore */ }
  closeModal(dom.welcomeModal);
  onboardingDone?.();
  onboardingDone = null;
}

/** Keep the drill banner in sync with what is actually on the map. */
function updateDrillBanner() {
  const drills = Object.values(hazards).filter((h) => h.provenance === 'drill');
  if (drills.length) show(dom.drillBanner);
  else hide(dom.drillBanner);
}

async function clearDrillHazards() {
  // Drill fixtures have no reporter, so per-device deletion cannot reach them. They
  // get their own endpoint: leaving simulated hazards on an emergency map is the exact
  // failure this whole area of the app exists to prevent.
  try {
    await api.hazards.clearDrill();
  } catch (err) {
    haptics.error();
    toast(`Could not clear drill data: ${err.message}`, 'error');
    return;
  }
  for (const zone of Object.values(hazards)) {
    if (zone.provenance !== 'drill') continue;
    delete hazards[zone.hazard_id];
    removeHazardLayer(zone.hazard_id);
  }
  updateHazardBadges();
  updateDrillBanner();
  toast('Drill data cleared.');
}

// ---------------------------------------------------------------------------
// Automatic Evacuation to Safety (Fastest Safe Route Engine)
// ---------------------------------------------------------------------------

/**
 * Compute an evacuation route, preferring the on-device engine.
 *
 * OneBar is client-authoritative for routing: when a region pack covers the user's
 * position the whole search runs locally, so evacuation works with the radio off.
 * The server is only consulted when no pack is installed.
 */
async function evacuationRoute(startPt) {
  const offline = await tryOfflineRoute(startPt, await evacuationCandidates(startPt));
  if (offline?.success) {
    return {
      ...offline,
      destination_safe_haven: offline.destination?.__haven || null,
    };
  }
  return api.routeSafety(startPt, travelMode, 'all', true);
}

/**
 * Which shelters the offline engine may aim at.
 *
 * Two filters, both of which were missing. A haven the server has marked compromised is
 * excluded — but so is one the *pack's own* haven list carries with no compromise
 * information at all, which is every haven when the app has been offline since launch.
 * So compromise is recomputed here against the hazards actually on the map, and havens
 * the router cannot honestly reach are dropped rather than snapped to a boundary node.
 */
async function evacuationCandidates(startPt) {
  const known = Object.values(safeHavens);
  const source = known.length ? known : await offlineHavens(startPt.lat, startPt.lon);
  const active = Object.values(hazards);

  return source
    .filter((haven) => haven.reachable !== false)
    .filter((haven) => !isHavenCompromised(haven, active))
    .map((haven) => ({ ...haven.location, __haven: haven }));
}

/** Is this shelter inside, or right beside, a hazard we currently know about? */
function isHavenCompromised(haven, activeHazards) {
  if (haven.is_compromised) return true;
  for (const zone of activeHazards) {
    const ring = zone.effective_coordinates?.length ? zone.effective_coordinates : zone.coordinates;
    if (!ring || ring.length < 3) continue;
    if (pointInRing(haven.location.lat, haven.location.lon, ring)) return true;
  }
  return false;
}

/** Ray-cast point-in-polygon, matching the test the routing engine applies to edges. */
function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat;
    const xi = ring[i].lon;
    const yj = ring[j].lat;
    const xj = ring[j].lon;
    if ((yi > lat) !== (yj > lat)
        && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Route on-device when a pack covers the origin.
 *
 * Returns null when there is no pack, or when the worker itself fails. A failing
 * worker must not abort the request: falling through to the server is worse than
 * routing locally but far better than telling someone mid-evacuation that routing is
 * unavailable because a Web Worker threw.
 */
async function tryOfflineRoute(startPt, destinations) {
  if (!destinations.length || !hasOfflineCoverage(startPt.lat, startPt.lon)) return null;
  try {
    return await routeOffline({
      origin: startPt,
      destinations,
      mode: travelMode,
      hazards: Object.values(hazards),
    });
  } catch (err) {
    console.warn('Offline routing engine failed, falling back to the server:', err.message);
    return null;
  }
}

async function autoEvacuateToSafety() {
  // No silent fallback to a hardcoded New York coordinate. Routing someone from a
  // position that is not theirs, without saying so, is the worst thing this screen
  // could do.
  const startPt = origin || (lastGPSLat !== null ? { lat: lastGPSLat, lon: lastGPSLon } : null);
  if (!startPt) {
    haptics.error();
    toast('Waiting for your location — enable GPS or drop a pin to set your position.', 'error');
    return;
  }

  banner('Computing fastest safe route to evacuation shelter…');
  toast('Evaluating safe havens and active hazard perimeters…');

  try {
    const result = await evacuationRoute(startPt);
    currentRouteData = result;
    activeDestinationHaven = result.destination_safe_haven;

    // Display destination haven beacon on map
    if (result.destination_safe_haven) {
      setSafeHavenDestinationMarker(result.destination_safe_haven);
      renderHavenDestination(result.destination_safe_haven);
      show(dom.routeHavenCard);
    } else {
      hide(dom.routeHavenCard);
    }

    showRoute(result.coordinates, result.is_fallback);
    renderRouteDeck(result);
    setAppState('route');
    persistTrip();
    haptics.success();
    toast(`Fastest safe route computed to: ${result.destination_safe_haven?.name || 'safety'}${result.engine === 'offline' ? ' (offline)' : ''}`);
  } catch (err) {
    haptics.error();
    toast(routingErrorMessage(err), 'error');
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
  openModal(dom.apiSyncModal, { initialFocus: dom.btnTriggerApiSync });
}

async function syncHazardFeedsFromApis() {
  const sources = [];
  if (dom.feedSourceNws?.checked) sources.push('nws');
  if (dom.feedSourceUsgs?.checked) sources.push('usgs');
  if (dom.feedSourceEonet?.checked) sources.push('eonet');
  // Simulation is not a feed and must never be requested as one. It is an explicit
  // drill flag, and everything it produces is stamped as such.
  const drillMode = Boolean(dom.feedSourceSim?.checked);

  const center = lastGPSLat !== null ? { lat: lastGPSLat, lon: lastGPSLon } : (origin || null);

  const prevText = dom.btnTriggerApiSync?.querySelector('span')?.textContent || 'Pull Hazards';
  dom.btnTriggerApiSync.querySelector('span').textContent = 'Connecting to Feeds…';
  dom.btnTriggerApiSync.disabled = true;

  try {
    const res = await api.hazards.syncApi({
      center,
      radius_km: 15.0,
      sources,
      drill_mode: drillMode,
    });

    closeModal(dom.apiSyncModal);
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
  openModal(dom.havensModal);
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
    const unreachable = h.reachable === false;
    const unavailable = h.is_compromised || unreachable;

    const card = document.createElement('div');
    card.className = `haven-list-item ${unavailable ? 'compromised' : ''}`;

    const distStr = lastGPSLat !== null
      ? `${(computeRoughDistance(lastGPSLat, lastGPSLon, h.location.lat, h.location.lon) / 1000).toFixed(1)} km away`
      : '';

    // "SAFE" was shown for anything without a hazard beside it. That is not what the
    // word means: OpenStreetMap says a building exists, not that anyone has opened it,
    // and the API says so in `verified`.
    let status;
    if (h.is_compromised) status = { cls: 'haven-alert-badge', text: 'Threat near' };
    else if (unreachable) status = { cls: 'haven-alert-badge', text: 'Off the map' };
    else if (h.verified) status = { cls: 'haven-safe-badge', text: 'Confirmed open' };
    else if (h.visibility === 'private') status = { cls: 'haven-unconfirmed-badge', text: 'Yours only' };
    else status = { cls: 'haven-unconfirmed-badge', text: 'Unconfirmed' };

    let action = 'Evacuate here';
    if (h.is_compromised) action = 'Threat near';
    else if (unreachable) action = 'No route';

    card.innerHTML = `
      <div class="haven-list-header">
        <div class="haven-list-name"></div>
        <span class="${status.cls}">${status.text}</span>
      </div>
      <div class="haven-list-address"></div>
      <div class="haven-list-meta">
        <span class="haven-list-type"></span>
        <button class="btn-haven-select" ${unavailable ? 'disabled' : ''}></button>
      </div>
    `;
    // Shelter names and addresses can come from another device; insert them as text.
    card.querySelector('.haven-list-name').textContent = h.name || 'Safe haven';
    card.querySelector('.haven-list-address').textContent = h.address || 'Designated haven point';
    card.querySelector('.haven-list-type').textContent =
      `${String(h.type || '').toUpperCase().replace('_', ' ')}${distStr ? ` • ${distStr}` : ''}`;
    card.querySelector('.btn-haven-select').textContent = action;

    card.querySelector('.btn-haven-select')?.addEventListener('click', () => {
      closeModal(dom.havensModal);
      onEvacuateHaven(h);
    });

    dom.havensListContainer.appendChild(card);
  });
}

/**
 * Fill in the destination card above the turn list.
 *
 * The tag read "VERIFIED SAFE HAVEN" for every shelter regardless of whether anything
 * had verified it — which, for an OSM-derived haven, nothing had.
 */
function renderHavenDestination(haven) {
  if (dom.routeHavenName) dom.routeHavenName.textContent = haven.name || 'Safe haven';
  if (dom.routeHavenAddress) {
    dom.routeHavenAddress.textContent = haven.address
      || `${String(haven.type || 'shelter').replace('_', ' ')} from OpenStreetMap`;
  }
  const tag = dom.routeHavenCard?.querySelector('.haven-dest-tag');
  if (tag) {
    tag.textContent = haven.verified
      ? 'CONFIRMED OPEN BY AN AUTHORITY'
      : 'MAPPED SHELTER — NOT CONFIRMED OPEN';
    tag.classList.toggle('unconfirmed', !haven.verified);
  }
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

  if (dom.hazardShareToggle) dom.hazardShareToggle.checked = false;
  updateHazardExpiryNote();
  openModal(dom.hazardModal, { initialFocus: dom.hazardInput });
}

/** Say plainly how long a report will stand, because the answer differs by kind. */
function updateHazardExpiryNote() {
  if (!dom.hazardExpiryNote) return;
  const shared = Boolean(dom.hazardShareToggle?.checked);
  dom.hazardExpiryNote.textContent = shared
    ? 'Shared reports expire after about 6 hours, sooner if others mark the road clear. '
      + 'Conditions change, and a stale report reroutes people for no reason.'
    : 'This report stays on your phone and expires after 24 hours.';
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
  closeModal(dom.hazardModal);
});

dom.btnHazardCancel?.addEventListener('click', () => {
  haptics.tap();
  closeModal(dom.hazardModal);
});

dom.hazardShareToggle?.addEventListener('change', updateHazardExpiryNote);

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
  const share = Boolean(dom.hazardShareToggle?.checked);

  closeModal(dom.hazardModal);

  if (mode === 'polygon') {
    setAppState('draw');
    return;
  }

  const payload = {
    name,
    hazard_type: type,
    buffer_meters: bufferMeters,
    source: 'manual',
    severity: 'severe',
    share,
  };

  if (mode === 'polygon_submit') {
    // The drawn boundary was serialised onto the dialog when drawing finished. It was
    // previously never read back, so finishing a polygon silently reported a radial
    // hazard at the user's own position instead of the shape they had just traced.
    let coords = null;
    try {
      coords = JSON.parse(dom.hazardModal.dataset.pendingCoords || 'null');
    } catch { /* fall through to the guard below */ }
    delete dom.hazardModal.dataset.pendingCoords;
    if (!Array.isArray(coords) || coords.length < 3) {
      haptics.error();
      toast('That boundary was lost before it could be saved. Draw it again.', 'error');
      return;
    }
    payload.coordinates = coords;
  } else {
    const radiusMeters = parseFloat(document.querySelector('.radius-btn.active')?.dataset.radius ?? '100');
    const center = lastGPSLat !== null ? { lat: lastGPSLat, lon: lastGPSLon } : origin;
    if (!center) {
      // Reporting a hazard at a hardcoded New York coordinate, wherever the user
      // actually is, would put a false blockage on a road they have never seen.
      haptics.error();
      toast('Waiting for your location — enable GPS or drop a pin first.', 'error');
      return;
    }
    payload.center = center;
    payload.radius_meters = radiusMeters;
  }

  try {
    const zone = await api.hazards.add(payload);
    hazards[zone.hazard_id] = zone;
    addHazardLayer(zone);
    updateHazardBadges();
    await loadSafeHavens();
    haptics.success();
    if (zone.is_offline_pending) {
      toast('Saved on this device — it will upload when you are back online.');
    } else {
      toast(share ? 'Report shared with others nearby.' : 'Report saved to this device.');
    }
    updatePendingBadge();
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

/** Confirm or deny somebody else's shared report. */
async function onHazardVote(hazardId, kind) {
  try {
    const result = kind === 'confirm'
      ? await api.hazards.confirm(hazardId)
      : await api.hazards.deny(hazardId);

    if (result.retired) {
      delete hazards[hazardId];
      removeHazardLayer(hazardId);
      updateHazardBadges();
    } else if (result.hazard) {
      hazards[hazardId] = result.hazard;
      removeHazardLayer(hazardId);
      addHazardLayer(result.hazard);
    }
    haptics.success();
    toast(result.message);

    if (currentRouteData && activeDestinationHaven) {
      autoEvacuateToSafety();
    } else if (currentRouteData && origin && dest) {
      requestRoute();
    }
  } catch (err) {
    haptics.error();
    toast(`Could not record that: ${err.message}`, 'error');
  }
}

function onPolygonDrawn(coords) {
  setAppState('idle');
  // The label, hazard type and sharing choice the user entered before drawing are kept:
  // clearing them meant every polygon report was filed as an unlabelled road closure,
  // however carefully it had been filled in a moment earlier.
  hide(dom.hazardRadiusSec);
  dom.tabHazardPoly.classList.add('active');
  dom.tabHazardRadial.classList.remove('active');
  dom.hazardModal.dataset.mode = 'polygon_submit';
  dom.hazardModal.dataset.pendingCoords = JSON.stringify(coords);
  updateHazardExpiryNote();
  openModal(dom.hazardModal, { initialFocus: dom.hazardInput });
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
    // Point-to-point routing used to call the server unconditionally, so a searched
    // address, a tapped shelter, a dropped pin and a restored trip all needed a
    // connection — with a region pack sitting unused on the device. This is the same
    // engine the evacuate button uses, aimed at one destination instead of many.
    const offline = await tryOfflineRoute(startPt, [{ ...dest }]);
    const result = offline?.success ? offline : await api.route(startPt, dest, travelMode, true);
    currentRouteData = result;

    if (activeDestinationHaven) {
      setSafeHavenDestinationMarker(activeDestinationHaven);
      renderHavenDestination(activeDestinationHaven);
      show(dom.routeHavenCard);
    } else {
      hide(dom.routeHavenCard);
    }

    showRoute(result.coordinates, result.is_fallback);
    renderRouteDeck(result);
    setAppState('route');
    persistTrip();
    haptics.success();
    if (result.engine === 'offline') toast('Route computed on this device.');
  } catch (err) {
    haptics.error();
    toast(routingErrorMessage(err), 'error');
  } finally {
    dom.btnCalcRoute.querySelector('span').textContent = prevText;
    dom.btnCalcRoute.disabled = false;
  }
}

/**
 * Turn a routing failure into something true.
 *
 * Any 409 used to be reported as "all paths are blocked by active hazards", which is a
 * confident claim about the world that is simply wrong when the two points are in
 * disconnected parts of the graph and there are no hazards at all.
 */
function routingErrorMessage(err) {
  const detail = err.detail || {};
  if (detail.no_map) {
    return installedPacks().length
      ? 'The server has no map loaded, and your downloaded area does not cover this route.'
      : 'The server has no map loaded. Download an area so routing can run on this device.';
  }
  if (detail.outside_coverage) {
    return `${err.message} Download that area to route there.`;
  }
  if (detail.unsupported_mode) {
    return err.message;
  }
  if (err.status === 409) {
    return Object.keys(hazards).length
      ? 'No passable route — every way through is blocked by an active hazard.'
      : 'No route exists between those two points on the downloaded map.';
  }
  return `Routing error: ${err.message || err}`;
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
  renderSosContacts();
  openModal(dom.sosModal, { initialFocus: dom.btnCallEmergency });
}

dom.btnCloseSosX?.addEventListener('click', () => {
  haptics.tap();
  closeModal(dom.sosModal);
});

dom.btnSendSms?.addEventListener('click', () => {
  haptics.sos();
  // The composer used to open with no recipient, so the final step of an emergency
  // action was picking contacts by hand under stress.
  const numbers = listContacts()
    .filter((contact) => sosRecipients.has(contact.id))
    .map((contact) => contact.phone);
  window.location.href = smsHref(numbers, dom.sosPreview.value);
});

dom.btnShareLocation?.addEventListener('click', async () => {
  haptics.tap();
  try {
    await navigator.share({ title: 'OneBar emergency location', text: dom.sosPreview.value });
  } catch { /* the user dismissed the share sheet */ }
});

dom.btnManageContacts?.addEventListener('click', () => {
  haptics.tap();
  openContactsModal();
});

/**
 * Recipient chips.
 *
 * Everyone is selected by default: in an emergency the safe default is "tell all the
 * people I nominated", and deselecting is a deliberate act.
 */
function renderSosContacts() {
  if (!dom.sosContactList) return;
  const contacts = listContacts();
  dom.sosContactList.innerHTML = '';

  if (!contacts.length) {
    const empty = document.createElement('p');
    empty.className = 'sos-contact-empty';
    empty.textContent = 'No emergency contacts saved yet — the message will open with no '
      + 'recipient and you will have to pick one by hand.';
    dom.sosContactList.appendChild(empty);
    // Only offer the share sheet where the platform actually has one; otherwise the
    // button is a dead end at the moment the user most needs it to work.
    if (dom.btnShareLocation && navigator.share) show(dom.btnShareLocation);
    return;
  }

  // Select everyone the first time the dialog is opened: in an emergency the safe
  // default is "tell all the people I nominated". After that the selection is the
  // user's — testing `size` alone meant deselecting the last contact silently
  // reselected all of them, so the set could never be emptied.
  if (!sosRecipientsInitialised) {
    contacts.forEach((contact) => sosRecipients.add(contact.id));
    sosRecipientsInitialised = true;
  }

  for (const contact of contacts) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'sos-contact-chip';
    const selected = sosRecipients.has(contact.id);
    chip.setAttribute('aria-pressed', String(selected));
    chip.innerHTML = `<span class="chip-check" aria-hidden="true">${selected ? '✓' : ''}</span>`;
    chip.append(document.createTextNode(contact.name));
    chip.addEventListener('click', () => {
      haptics.tap();
      if (sosRecipients.has(contact.id)) sosRecipients.delete(contact.id);
      else sosRecipients.add(contact.id);
      renderSosContacts();
    });
    dom.sosContactList.appendChild(chip);
  }

  if (dom.btnShareLocation && navigator.share) show(dom.btnShareLocation);
}

// --------------------------------------------------------------------------
// Emergency contacts
// --------------------------------------------------------------------------

function initContactsUi() {
  dom.btnCloseContactsX?.addEventListener('click', () => {
    haptics.tap();
    closeModal(dom.contactsModal);
  });
  dom.btnContactsCancel?.addEventListener('click', () => {
    haptics.tap();
    closeModal(dom.contactsModal);
  });
  dom.btnContactsSave?.addEventListener('click', () => {
    haptics.tap();
    commitContacts();
  });
}

function openContactsModal() {
  renderContactFields();
  openModal(dom.contactsModal, { initialFocus: dom.contactsFields?.querySelector('input') });
}

function renderContactFields() {
  if (!dom.contactsFields) return;
  const contacts = listContacts();
  dom.contactsFields.innerHTML = '';

  for (let index = 0; index < MAX_CONTACTS; index++) {
    const contact = contacts[index] || { name: '', phone: '' };
    const row = document.createElement('div');
    row.className = 'contact-field-row';
    row.innerHTML = `
      <span class="contact-field-label">Contact ${index + 1}</span>
      <input type="text" data-field="name" placeholder="Name" autocomplete="off"
             value="${escapeAttribute(contact.name)}" aria-label="Contact ${index + 1} name">
      <input type="tel" data-field="phone" inputmode="tel" placeholder="Phone number"
             autocomplete="off" value="${escapeAttribute(contact.phone)}"
             aria-label="Contact ${index + 1} phone number">
    `;
    dom.contactsFields.appendChild(row);
  }
}

function commitContacts() {
  const rows = Array.from(dom.contactsFields?.querySelectorAll('.contact-field-row') || []);
  const drafted = rows.map((row) => ({
    name: row.querySelector('[data-field="name"]').value,
    phone: row.querySelector('[data-field="phone"]').value,
  })).filter((contact) => contact.phone.trim());

  const saved = saveContacts(drafted);
  // Selections are keyed by contact id, and ids move when the list is edited.
  sosRecipients = new Set(saved.map((contact) => contact.id));
  sosRecipientsInitialised = saved.length > 0;

  closeModal(dom.contactsModal);
  renderOnboardingContacts();
  renderSosContacts();
  haptics.success();
  toast(saved.length
    ? `Saved ${saved.length} emergency contact${saved.length > 1 ? 's' : ''} on this device.`
    : 'Emergency contacts cleared.');
}

function escapeAttribute(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

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

const LARGE_TEXT_KEY = 'onebar_large_text';

function readFlag(key) {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function writeFlag(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
}

function initDisplaySettings() {
  isHighContrast = readFlag('onebar_contrast');
  isLargeText = readFlag(LARGE_TEXT_KEY);

  // Honour the OS preference when the user has expressed no preference of their own.
  // Someone who has already turned system-wide high contrast on should not have to
  // find a second switch inside this app.
  if (!isHighContrast && window.matchMedia?.('(prefers-contrast: more)').matches) {
    isHighContrast = true;
  }

  applyHighContrast();
  applyLargeText();

  dom.settingContrast?.addEventListener('click', () => {
    haptics.tap();
    toggleHighContrast();
  });
  dom.settingLargeText?.addEventListener('click', () => {
    haptics.tap();
    toggleLargeText();
  });
}

function applyHighContrast() {
  document.body.classList.toggle('high-contrast', isHighContrast);
  setHighContrastMap(isHighContrast);
  dom.settingContrast?.setAttribute('aria-pressed', String(isHighContrast));
  dom.btnContrast?.setAttribute('aria-pressed', String(isHighContrast));
}

function applyLargeText() {
  document.body.classList.toggle('text-large', isLargeText);
  dom.settingLargeText?.setAttribute('aria-pressed', String(isLargeText));
}

function toggleHighContrast() {
  isHighContrast = !isHighContrast;
  applyHighContrast();
  writeFlag('onebar_contrast', isHighContrast);
  toast(isHighContrast ? 'High-contrast display on' : 'Standard display restored');
}

function toggleLargeText() {
  isLargeText = !isLargeText;
  applyLargeText();
  writeFlag(LARGE_TEXT_KEY, isLargeText);
  toast(isLargeText ? 'Large text on' : 'Standard text size restored');
}

async function downloadRegionForOffline() {
  // Replaces the old tile pre-cacher, which bulk-downloaded raster tiles straight from
  // tile.openstreetmap.org in violation of their usage policy — and cached them under a
  // name the service worker then deleted, so it never worked anyway. A region pack is
  // the thing that actually makes the app usable offline: it carries the road graph, so
  // routing keeps working with no signal at all.
  const position = (lastGPSLat !== null && lastGPSLon !== null)
    ? { lat: lastGPSLat, lon: lastGPSLon }
    : null;

  toast('Finding available map regions…');
  let catalogue;
  try {
    catalogue = await fetchCatalogue();
  } catch (err) {
    haptics.error();
    toast(`Could not reach the region catalogue: ${err.message}`, 'error');
    return;
  }

  const regions = catalogue?.regions || [];
  if (!regions.length) {
    toast('No downloadable regions are published yet.', 'error');
    return;
  }

  const region = position
    ? regions.find((r) => position.lat >= r.bounds.min_lat && position.lat <= r.bounds.max_lat
        && position.lon >= r.bounds.min_lon && position.lon <= r.bounds.max_lon) || regions[0]
    : regions[0];

  const megabytes = (region.bytes / 1e6).toFixed(1);
  banner(`Downloading ${region.name} (${megabytes} MB)…`);
  try {
    await downloadPack(region, {
      onProgress: (received, total) => {
        if (!total) return;
        const pct = Math.round((received / total) * 100);
        if (pct % 10 === 0) banner(`Downloading ${region.name} — ${pct}%`);
      },
    });
    haptics.success();
    // `dom.modeBanner` was never a key on `dom`, so this was a silent no-op and the
    // "Downloading…" banner stayed on screen for the rest of the session.
    hide(dom.banner);
    toast(`${region.name} saved. Evacuation routing now works offline.`);
    updateOfflineReadiness();
    loadRegion();
  } catch (err) {
    haptics.error();
    hide(dom.banner);
    toast(`Download failed: ${err.message}`, 'error');
  }
}

function updateOfflineReadiness() {
  const packs = installedPacks();
  const ready = packs.length > 0;
  if (dom.btnCacheTiles) {
    dom.btnCacheTiles.classList.toggle('is-ready', ready);
    dom.btnCacheTiles.setAttribute(
      'title',
      ready ? `Offline maps ready (${packs.map((p) => p.name).join(', ')})` : 'Download offline map',
    );
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

// ---------------------------------------------------------------------------
// Destination search
// ---------------------------------------------------------------------------
//
// The top bar rendered a magnifier inside a rounded search frame wrapped around a
// static `<div>`: there was no search in the product at all, and the only way to pick
// a destination was to guess where it was and tap the map.
//
// Results are labelled by where they came from. An "OFFLINE MAP" hit is inside
// downloaded coverage and routable with no signal; a network hit may be neither, and
// is marked when it falls outside the area OneBar can actually route in.

const SEARCH_ICONS = {
  street: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="10" y2="3"/><line x1="20" y1="21" x2="14" y2="3"/><line x1="12" y1="6" x2="12" y2="9"/><line x1="12" y1="13" x2="12" y2="16"/></svg>`,
  shelter: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>`,
  address: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>`,
  coordinate: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/></svg>`,
};

function initSearch() {
  if (!dom.searchInput) return;

  dom.searchInput.addEventListener('input', () => {
    const query = dom.searchInput.value;
    dom.btnSearchClear?.classList.toggle('hidden', !query);
    if (query.trim().length < 2) {
      closeSearchResults();
      return;
    }
    renderSearchMessage('Searching…');
    searchDebounced(
      query,
      {
        near: currentPosition(),
        limit: 8,
        // Offline hits are instant; the geocoder can take up to ten seconds on a weak
        // link. Showing what the device already knows first means the search box is
        // useful the moment you stop typing, rather than after the network answers.
        onPartial: ({ results }) => {
          if (!results.length) return;
          searchResults = results;
          searchActiveIndex = -1;
          renderSearchResults(null);
        },
      },
      ({ results, message }) => {
        searchResults = results;
        searchActiveIndex = -1;
        renderSearchResults(message);
      },
    );
  });

  dom.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!searchResults.length) return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      searchActiveIndex = (searchActiveIndex + delta + searchResults.length) % searchResults.length;
      highlightSearchOption();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = searchResults[searchActiveIndex] || searchResults[0];
      if (chosen) chooseSearchResult(chosen);
    } else if (event.key === 'Escape') {
      closeSearchResults();
      dom.searchInput.blur();
    }
  });

  dom.btnSearchClear?.addEventListener('click', () => {
    haptics.tap();
    dom.searchInput.value = '';
    dom.btnSearchClear.classList.add('hidden');
    closeSearchResults();
    dom.searchInput.focus();
  });

  // Tapping the map or anywhere outside dismisses the list.
  document.addEventListener('pointerdown', (event) => {
    if (!dom.topNavCard?.contains(event.target)) closeSearchResults();
  });
}

function currentPosition() {
  if (lastGPSLat !== null && lastGPSLon !== null) return { lat: lastGPSLat, lon: lastGPSLon };
  return origin || null;
}

function renderSearchMessage(text) {
  if (!dom.searchResults) return;
  dom.searchResults.innerHTML = `<div class="search-empty">${text}</div>`;
  show(dom.searchResults);
  dom.searchInput?.setAttribute('aria-expanded', 'true');
}

function renderSearchResults(message) {
  if (!dom.searchResults) return;
  dom.searchResults.innerHTML = '';

  if (!searchResults.length) {
    renderSearchMessage(message || 'No matches.');
    return;
  }

  searchResults.forEach((result, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'search-result-item';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', 'false');
    item.dataset.kind = result.kind;

    // What the user needs to know is where this came from and whether OneBar can
    // actually route there. `in_coverage === null` means "we cannot tell" — a pasted
    // coordinate with no region pack installed — and must not be labelled either way.
    let tag;
    if (result.in_coverage === false) {
      tag = { className: 'uncovered', text: 'No coverage' };
    } else if (result.kind === 'coordinate') {
      tag = { className: 'offline', text: 'Coordinates' };
    } else if (result.source === 'offline') {
      tag = { className: 'offline', text: 'Offline map' };
    } else {
      tag = { className: 'network', text: 'Online' };
    }

    const distance = result.distance_meters != null
      ? (result.distance_meters >= 1000
        ? `${(result.distance_meters / 1000).toFixed(1)} km · `
        : `${Math.round(result.distance_meters)} m · `)
      : '';

    item.innerHTML = `
      <span class="search-result-icon">${SEARCH_ICONS[result.kind] || SEARCH_ICONS.address}</span>
      <span class="search-result-body">
        <span class="search-result-name"></span>
        <span class="search-result-sub"></span>
      </span>
      <span class="search-result-tag ${tag.className}">${tag.text}</span>
    `;
    // Names come from OSM and from a third-party geocoder; they are data, not markup.
    item.querySelector('.search-result-name').textContent = result.name;
    item.querySelector('.search-result-sub').textContent = `${distance}${result.subtitle || ''}`;

    item.addEventListener('click', () => chooseSearchResult(result));
    item.addEventListener('mouseenter', () => {
      searchActiveIndex = index;
      highlightSearchOption();
    });
    dom.searchResults.appendChild(item);
  });

  if (message) {
    const note = document.createElement('div');
    note.className = 'search-empty';
    note.textContent = message;
    dom.searchResults.appendChild(note);
  }

  show(dom.searchResults);
  dom.searchInput?.setAttribute('aria-expanded', 'true');
}

function highlightSearchOption() {
  const items = dom.searchResults?.querySelectorAll('.search-result-item') || [];
  items.forEach((item, index) => {
    const active = index === searchActiveIndex;
    item.setAttribute('aria-selected', String(active));
    if (active) item.scrollIntoView({ block: 'nearest' });
  });
}

function closeSearchResults() {
  cancelSearch();
  searchResults = [];
  searchActiveIndex = -1;
  hide(dom.searchResults);
  dom.searchInput?.setAttribute('aria-expanded', 'false');
}

function chooseSearchResult(result) {
  haptics.tap();
  dest = { lat: result.location.lat, lon: result.location.lon };
  destName = result.name;
  setDestMarker(dest);
  panTo(dest, 16);
  closeSearchResults();
  dom.searchInput.value = result.name;
  dom.btnSearchClear?.classList.remove('hidden');

  // Offline results carry the haven record inline; server results only name it, so
  // match it back so the route sheet can show a shelter rather than a coordinate.
  activeDestinationHaven = result.haven
    || (result.kind === 'shelter'
      ? Object.values(safeHavens).find((h) => h.name === result.name) || null
      : null);

  setAppState('planner');
  persistTrip();

  if (result.in_coverage === false) {
    // Warn before routing rather than after: the router will refuse, and being told
    // why in advance is the difference between an explanation and an error. Only when
    // we actually know — an unknown coverage state is not a warning.
    toast(
      `${result.name} is outside your downloaded map. Download that area to route there.`,
      'error',
    );
  }
}

// ---------------------------------------------------------------------------
// Resuming an interrupted journey
// ---------------------------------------------------------------------------

function initResumeBanner() {
  dom.btnResumeTrip?.addEventListener('click', async () => {
    haptics.tap();
    hide(dom.resumeBanner);
    if (!restoredTrip) return;

    origin = restoredTrip.origin || origin;
    dest = restoredTrip.dest || null;
    destName = null;
    selectTravelMode(restoredTrip.travelMode || 'drive');
    activeDestinationHaven = restoredTrip.haven || null;
    if (origin) setOriginMarker(origin);
    if (dest) setDestMarker(dest);

    // Recomputed, never replayed. Hazards move, and handing someone a stored route
    // that now runs through a flood zone would be the worst thing this screen can do.
    toast('Rechecking that route against current hazards…');
    if (activeDestinationHaven) await autoEvacuateToSafety();
    else if (dest) await requestRoute();
    restoredTrip = null;
  });

  dom.btnDismissTrip?.addEventListener('click', () => {
    haptics.tap();
    hide(dom.resumeBanner);
    restoredTrip = null;
    clearTrip();
  });
}

async function restoreSavedTrip() {
  const trip = await loadTrip();
  if (!trip || (!trip.dest && !trip.haven)) return;

  restoredTrip = trip;
  if (dom.resumeAge) dom.resumeAge.textContent = describeAge(trip.ageMs);
  if (dom.resumeDestination) {
    dom.resumeDestination.textContent = trip.haven?.name
      || (trip.dest ? `Route to ${trip.dest.lat.toFixed(4)}, ${trip.dest.lon.toFixed(4)}` : 'Evacuation route');
  }
  show(dom.resumeBanner);
}

// Global debug
window.__onebar = {
  setAppState, api, autoEvacuateToSafety, syncHazardFeedsFromApis,
  downloadRegionForOffline, setBasemap, openContactsModal, restoreSavedTrip,
  // Used by tools/boot_check.mjs to drive the planner without reaching into the search
  // box; harmless in production and useful from the console when debugging.
  reloadSafeHavensForTest: () => loadSafeHavens(),
  setDestinationForTest: (point, name = null) => {
    dest = point;
    destName = name;
    setDestMarker(point);
    updatePlannerLabels();
  },
};

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
//
// Deliberately the last thing in the module.
//
// This block used to sit half way up the file, above the `const` declarations that
// several of these functions close over. Function declarations hoist; `const` and
// `let` do not, so `initDisplaySettings()` reached `LARGE_TEXT_KEY` before its
// initialiser had run and threw a ReferenceError at module load — which, in a page
// with no build step and no error boundary, is a blank screen. Booting from the very
// bottom means every binding in the module is initialised before anything uses it,
// and removes that entire class of failure rather than patching one instance of it.

initMap(onMapTap, onHazardDelete, onEvacuateHaven, onHazardVote);
initDisplaySettings();
initEmergencyCall();
initSearch();
initContactsUi();
initResumeBanner();
updateOfflineReadiness();

// The map, the network and the hazard layers come up immediately; GPS does not.
// Location is only requested once the user has seen what OneBar is and is not.
loadRegion();
loadHazards();
loadSafeHavens();
pollConnectivity();

initOnboarding(() => {
  startGPS();
  startCompass();
  handleUrlActionShortcuts();
  restoreSavedTrip();
});

dom.btnExitDrill?.addEventListener('click', clearDrillHazards);

// A route in progress is worth nothing if it dies with the tab. `pagehide` is the
// only event a mobile browser reliably fires before it discards the page.
window.addEventListener('pagehide', () => { flushTrip(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushTrip();
});

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
