# AGENTS.md — Contributor & Multi-Agent Guidance

## 1. Project Overview & Philosophy

**Project Name:** OneBar  
**Core Purpose:** A mobile-first emergency map and evacuation routing application designed specifically for crisis scenarios where cellular connectivity is degraded ("one bar" of signal) or intermittent.

### Platform Focus
- **Android (Primary Target):** Optimized for the vast range of Android devices used globally in field and crisis conditions, including low-spec hardware, aggressive background battery saving, Android Location Services, and PWA/WebView standalone execution.
- **iOS (Cross-Platform Support):** Fully functional and responsive on Mobile Safari and iOS WebKit environments, handling iOS safe-area insets, standalone display modes, and WebKit-specific storage quotas.

### Core Principles
- **Mobile-First & Ultra-Lightweight:** Minimal payload footprint. Touch-first interactions, large touch targets (minimum 48px), and zero heavy UI bundles.
- **Offline & Low-Bandwidth Resilience:** Gracefully handle slow requests (2G/3G speeds), packet drops, and completely offline modes. Cache map tiles, hazard zones, and route graphs locally via Service Workers & IndexedDB.
- **High-Stress Usability:** High-contrast, unambiguous visual hierarchy, large buttons operable with one hand or with gloves, immediate tactile/visual feedback, and zero clutter.
- **Fail-Safe Routing:** Real-time routing around dynamic hazard zones (wildfires, floods, debris, road closures). If an area is blocked, compute the safest alternate path with clear warnings.

---

## 2. System Architecture & Tech Stack

```
                     +---------------------------------------+
                     |         Mobile Client (Leaflet.js)    |
                     |  - Touch-First Vanilla JS / CSS / HTML|
                     |  - Leaflet Map & Mobile Draw Tooling  |
                     |  - Service Worker & IndexedDB Caching |
                     |  - Geolocation API & Device Sensors   |
                     |  [ Android Priority | iOS Compatible ]|
                     +-------------------+-------------------+
                                         | REST / JSON (Compressed)
                                         v
                     +---------------------------------------+
                     |          Backend (FastAPI)            |
                     |  - app/index.py (Lifespan & Init)     |
                     |  - app/api.py (Route & Hazard APIs)   |
                     +---------+-------------------+---------+
                               |                   |
                               v                   v
              +----------------------+       +-----------------------+
              |     GraphManager     |       |      HazardStore      |
              |  - OSMnx / NetworkX  |       |  - Shapely Polygons   |
              |  - Spatial STRtree   |       |  - Dynamic Intersects |
              |  - .graphml caching  |       |  - In-Memory Cache    |
              +----------+-----------+       +-----------+-----------+
                         |                               |
                         +---------------+---------------+
                                         |
                                         v
                     +---------------------------------------+
                     |           A* Route Engine             |
                     |  - app/router.py                      |
                     |  - Great-circle distance heuristic    |
                     |  - Impassable edge filtering          |
                     +---------------------------------------+
```

### Technology Stack
- **Mobile Frontend:**
  - Map Engine: **Leaflet.js** (lightweight tile rendering, touch gesture handlers, pinch-to-zoom, vector overlays).
  - Styling: Vanilla CSS (touch-first responsive layouts, mobile viewport optimization `viewport-fit=cover`, safe-area insets, high-contrast emergency theme).
  - Client Logic: Vanilla JavaScript (ES modules, Service Worker for aggressive tile/asset caching, IndexedDB for offline hazard storage, Geolocation Watch API).
- **Backend:**
  - Web Framework: **FastAPI** (`uvicorn`).
  - Spatial & Graph Engine: **OSMnx**, **NetworkX**, **Shapely** (`STRtree` for 2D spatial indexing), **GeoPandas**.
  - Graph Caching: GraphML local file persistence for fast startup and low-memory reloading.

---

## 3. Specialized Agent Roles & Workstreams

When dividing tasks across agents or contributors, assign tasks according to these specialized agent personas:

### Agent 1: Mobile Frontend & Leaflet.js Specialist
**Focus:** Touch-First Mobile UI, Leaflet Map Rendering, Hazard Interaction, Low-Bandwidth Optimizations.

**Tasks & Responsibilities:**
1. **Mobile Leaflet Map & Viewport Setup:**
   - Configure mobile-optimized Leaflet instance (disabled double-tap zoom delay, smooth pinch-to-zoom, touch drag inertia).
   - Account for mobile notches, bottom navigation bars, and safe-area insets on both Android and iOS.
   - Continuous device GPS tracking via `navigator.geolocation.watchPosition` with fallback manual location pin.
2. **Touch-Friendly Hazard Zone Tooling:**
   - Mobile-friendly polygon drawing tools with clear vertex handles suitable for touchscreens.
   - Distinct visual styling for hazards (high-contrast semi-transparent red/amber polygons with bold borders).
   - Bottom sheet / slide-over mobile drawer for hazard details and one-tap removal.
3. **Turn & Route Visualization:**
   - Display computed route waypoints (`/route` response) with color-coded travel time and avoided hazards badge.
   - Prominent, easy-to-read emergency guidance banners. Clear modal alerts if no route is found (`409 Conflict`).
4. **Android & iOS Offline Resilience:**
   - Register Service Worker for offline tile caching and static app shell persistence.
   - Implement IndexedDB queue for hazard operations created while offline, syncing when connectivity resumes.
   - Display clear status banner on top of screen ("Offline Mode — Using Cached Map", "Weak Signal (1 Bar)", "Online").

---

### Agent 2: Backend & Routing Specialist
**Focus:** FastAPI endpoints, Graph Management, Hazard Intersections, Routing Optimization.

**Tasks & Responsibilities:**
1. **API Endpoints Enhancement (`app/api.py`):**
   - Enhance `GET /hazards` to return full polygon coordinate geometries alongside hazard IDs (or add `GET /hazards/{hazard_id}`).
   - Support polyline-encoded route responses to reduce network transfer size over mobile 2G/3G connections.
   - Add reverse geocoding or nearest landmark queries where appropriate without third-party API dependencies.
2. **Spatial Indexing & Performance (`app/spatial.py`, `app/graph_loader.py`):**
   - Keep STRtree spatial indexing fast during dynamic polygon additions and removals.
   - Support incremental or boxed subgraph loading for large territorial coverage.
3. **Routing Algorithmic Resilience (`app/router.py`):**
   - Provide fallback routing strategies (e.g., soft penalty weights when impassable route causes isolation).
   - Support pedestrian vs. vehicular travel time adjustments.
4. **Data Persistence:**
   - Add optional lightweight local storage (e.g., SQLite / GeoPackage) for hazard persistence across server restarts.

---

### Agent 3: GIS, Data Pipeline & Offline Infrastructure Specialist
**Focus:** Network graph extraction, offline tile packaging, compression, and deployment.

**Tasks & Responsibilities:**
1. **Map Data Pre-seeding:**
   - Scripts to pre-generate `.graphml` files for target disaster regions (coastal areas, wildfire zones, flood plains).
   - Ensure `network_type="all"` is properly preserved for drive + walk emergency access.
2. **MBTiles / Offline Tile Server:**
   - Support local raster or vector tile packaging (.mbtiles) for completely offline base stations or local emergency hubs.
3. **Compression & Bandwidth Optimization:**
   - Configure Gzip / Brotli compression middleware on FastAPI.
   - Minify static frontend bundles to under 100KB total initial transfer.

---

### Agent 4: Mobile QA, Testing & Chaos Engineering Specialist
**Focus:** Mobile device emulation, network throttling simulations, edge case testing, spatial verification.

**Tasks & Responsibilities:**
1. **Mobile Platform & Viewport Verification:**
   - Verify touch target dimensions (>= 48x48px) and gesture responsiveness across common Android screen sizes and iOS Safari viewports.
   - Test orientation shifts (portrait / landscape) and safe-area padding behavior.
2. **Low-Bandwidth / High-Latency Testing:**
   - Test mobile app behavior under simulated 2G mobile data (30kbps, 1500ms RTT, 5% packet loss).
   - Test graceful offline degradation when backend is unreachable or connection drops mid-request.
3. **Spatial Integrity Testing:**
   - Test complex polygons (concave polygons, multi-polygons, self-intersecting boundaries) against the road network.
   - Verify that routes never cross or touch active hazard zones.
4. **Backend Unit & Integration Tests:**
   - Automated tests with `pytest` and `httpx` for `/health`, `/hazards`, `/route`.

---

## 4. Current API Contract Reference

### 1. Health & Region Info
- **Endpoint:** `GET /health`
  - **Response:** `{"status": "ok", "timestamp": "2026-08-16T...", "app": "OneBar"}`
- **Endpoint:** `GET /region`
  - **Response:**
    ```json
    {
      "place_name": "Battery Park, New York, USA",
      "bounds": {"min_lat": 40.700, "max_lat": 40.725, "min_lon": -74.015, "max_lon": -73.990},
      "node_count": 1420,
      "edge_count": 3120,
      "status": "ready"
    }
    ```

### 2. Register Hazard Zone
- **Endpoint:** `POST /hazards`
- **Request Body:**
  ```json
  {
    "name": "Midtown Flood Zone",
    "hazard_type": "flood",
    "coordinates": [
      {"lat": 40.7128, "lon": -74.0060},
      {"lat": 40.7150, "lon": -74.0020},
      {"lat": 40.7100, "lon": -74.0010}
    ]
  }
  ```
- **Response (201):**
  ```json
  {
    "hazard_id": "8fa88d96-...",
    "name": "Midtown Flood Zone",
    "hazard_type": "flood",
    "coordinates": [
      {"lat": 40.7128, "lon": -74.0060},
      {"lat": 40.7150, "lon": -74.0020},
      {"lat": 40.7100, "lon": -74.0010}
    ],
    "created_at": "2026-08-16T..."
  }
  ```

### 3. List Hazards
- **Endpoint:** `GET /hazards`
- **Response:**
  ```json
  {
    "hazards": [
      {
        "hazard_id": "8fa88d96-...",
        "name": "Midtown Flood Zone",
        "hazard_type": "flood",
        "coordinates": [...],
        "created_at": "2026-08-16T..."
      }
    ],
    "total": 1
  }
  ```

### 4. Delete Hazard
- **Endpoint:** `DELETE /hazards/{hazard_id}`
- **Response:** `{"removed": true, "hazard_id": "<uuid>"}`
- **Endpoint:** `DELETE /hazards` (Clear all)
- **Response:** `{"cleared": 3}`

### 5. Calculate Resilient Route
- **Endpoint:** `POST /route`
- **Request Body:**
  ```json
  {
    "origin": {"lat": 40.7128, "lon": -74.0060},
    "destination": {"lat": 40.7200, "lon": -73.9950},
    "mode": "drive",
    "encode_polyline": true,
    "allow_penalty_fallback": true
  }
  ```
- **Response (200):** includes `coordinates`, optional `polyline`, `total_travel_time_seconds`,
  `total_distance_meters`, `blocked_edges_avoided`, `is_fallback`, `warning` and a
  `maneuvers: [{type, instruction, distance_meters, location}]` turn-by-turn list.
- **Response (422):** coordinate outside loaded graph (`outside_coverage`) or unsupported mode.
- **Response (409 Conflict):** no passable route.

The contract below is the *full* current surface — this file's earlier copy predates most of it.

| Endpoint | Method | Notes |
| --- | --- | --- |
| `/health`, `/region` | GET | Service liveness; graph summary incl. bounds & counts. |
| `/hazards` | POST/GET | Create (device-attributed, private unless `share:true`); list scoped to caller. |
| `/hazards/{id}` | GET/DELETE | Fetch one; delete own report (operator token for others). |
| `/hazards/{id}/confirm`, `/deny` | POST | Community voting; enough denials retire a shared report. |
| `/hazards/drill` | DELETE | Retire drill fixtures (own, or all with operator token). |
| `/hazards` | DELETE | Wipe-all — **operator token only**, disabled unless `ONEBAR_ADMIN_TOKEN`. |
| `/hazards/sync-api` | POST | Pull NWS / USGS / EONET feeds; `drill_mode` scopes simulated hazards to the device. |
| `/safe-havens` | GET/POST/DELETE | Shelters; compromise detection vs live hazards. |
| `/geocode`, `/geocode/reverse` | GET | Offline street index first, Nominatim second. |
| `/route/safety` | POST | Multi-haven evacuation evaluation + alternatives. |
| `/push/vapid-public-key` | GET | `{enabled, public_key}` for Web Push hazard alerts. |
| `/push/subscriptions` | POST/GET/DELETE | Register/list/remove push subscriptions + watched area; device-scoped. |
| `/packs/index.json`, `/packs/{id}.obp` | GET | Offline pack catalogue + immutable downloads. |
| `/packs/request`, `/packs/jobs/{job_id}` | POST/GET | On-demand pack build (needs `ONEBAR_ON_DEMAND_PACKS=1`); poll job, then download via `/packs/{region_id}.obp`. |

Write endpoints require the `X-OneBar-Device` header (opaque client id, stored only as a keyed
hash) and are rate limited per device and per network origin. Operator actions use
`X-OneBar-Admin`.

---

## 5. Development & Execution Instructions

### Running the Backend
```bash
# Install dependencies (requirements-dev.txt adds pytest, httpx and ruff)
pip install -r requirements-dev.txt

# Run FastAPI dev server
uvicorn app.index:app --host 0.0.0.0 --port 8000 --reload
```

### Environment Variables for Graph Initialization
- `ONEBAR_PLACE`: Named location string (e.g. `"Manhattan, New York, USA"`).
- `ONEBAR_BBOX`: North, South, East, West degrees (e.g. `"40.78,-74.02,40.70,-73.93"`).
- `ONEBAR_POINT`: Centre `"lat,lon"` decimal degrees (used with `ONEBAR_RADIUS`).
- `ONEBAR_RADIUS`: Search radius in meters around point (default: `5000`).
- `ONEBAR_CACHE`: Path to `.graphml` cached graph file (default: `region_graph.graphml`).

### Other Environment Variables
- `ONEBAR_HAZARDS_FILE` / `ONEBAR_HAVENS_FILE` / `ONEBAR_PUSH_FILE`: JSON persistence paths for hazards, havens and push subscriptions.
- `ONEBAR_ADMIN_TOKEN`: enables operator endpoints when set.
- `ONEBAR_RATE_LIMIT=0`: disable per-device rate limiting (testing only).
- `ONEBAR_VAPID_PRIVATE_KEY` / `ONEBAR_VAPID_PUBLIC_KEY` / `ONEBAR_VAPID_SUBJECT`: enable Web Push hazard alerts.
- `ONEBAR_ON_DEMAND_PACKS=1`: allow clients to request region packs built around their location.
- `ONEBAR_PACK_DIR`: where published `.obp` packs live (default `packs/`).
- `ONEBAR_ALLOWED_ORIGINS`: extra CORS origins for hosted/native deployments.

---

## 6. Mobile Contribution & Code Quality Guidelines

1. **Touch Targets & Ergonomics:** All interactive buttons and map controls must be at least 48px × 48px to accommodate one-handed emergency operation.
2. **Android Priority & iOS Parity:** Test features on Android Chrome/WebView first, then ensure Safari on iOS supports identical functionality (handling WebKit scroll bouncing and safe-area insets).
3. **Preserve Spatial Accuracy:** Graph nodes are indexed in `(lon, lat)` for Shapely/OSMnx and `(lat, lon)` for Leaflet. Always verify coordinate ordering.
4. **Mobile Battery & Data Conservation:** Throttle continuous GPS queries when stationary, compress payloads over cellular links, and avoid unnecessary map re-renders.
