# OneBar

A mobile-first emergency evacuation map and resilient routing application designed specifically for crisis scenarios where cellular connectivity is degraded ("one bar" of signal) or intermittent.

---

## Core Philosophy

During natural disasters (wildfires, flash floods, earthquakes, severe storms) and civil crises, cellular bandwidth drops dramatically while roads become impassable. OneBar is engineered for this exact condition:

- **Ultra-Lightweight Payload Footprint**: No heavy frontend frameworks or bulky UI bundles. Native HTML5, Vanilla CSS, and Leaflet.js served locally (no CDN dependency at boot).
- **Fail-Safe Spatial Routing**: A* routing on OpenStreetMap graphs avoiding dynamic hazard perimeters, with no third-party routing dependency.
- **Genuinely Offline Routing**: Download a region pack and the entire search — road graph, safe havens, hazard avoidance — runs on-device in a Web Worker. Routing does not require the network.
- **Real-Time Emergency Feed Ingestion**: Active alerts from NOAA/NWS, USGS Earthquakes and NASA EONET, each carrying a link back to the issuing authority. When there are no alerts, OneBar says so — it never fabricates hazards to fill the map.
- **Real Safe Havens**: Shelters are derived from mapped OpenStreetMap features (hospitals, schools, fire stations, assembly points) and carry the OSM id they came from.
- **Tactile Emergency Ergonomics**: High-contrast dark theme, large 48px+ touch targets operable with gloves or one hand, and device haptic feedback.
- **Cross-Platform Native Execution**: Packaged as both a native Android APK and iOS application via Capacitor.

---

## Architecture Overview

```
                     +---------------------------------------+
                     |       Mobile Client (Android / iOS)   |
                     |  - Leaflet Map & Touch Draw Tooling   |
                     |  - Service Worker & IndexedDB Caching |
                     |  - Capacitor Geolocation & Haptics    |
                     +-------------------+-------------------+
                                         | Compressed REST / JSON
                                         v
                     +---------------------------------------+
                     |          Backend (FastAPI)            |
                     |  - app/index.py (Lifespan & State)    |
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
                     |  - Safe Haven multi-target optimizer  |
                     +---------------------------------------+
```

---

## Key Features

1. **Automatic Route to Safety**:
   - One-tap evaluation of all regional safe havens (designated shelters, medical centers, maritime egress points).
   - Dynamically bypasses impassable hazard polygons and computes the fastest safe corridor with turn-by-turn guidance.
2. **Hazard Feed Ingestion**:
   - Pulls live alerts from the NOAA / National Weather Service (NWS) Active Alerts API.
   - Ingests real-time seismic epicenters and damage perimeters from the USGS Earthquake Hazards API.
   - Queries tracked natural hazard perimeters from the NASA EONET API.
3. **Safe Haven Threat Detection**:
   - Automatically detects when a safe shelter or emergency hub is threatened or compromised by approaching hazards and reroutes to safe alternatives.
4. **Emergency SOS Beacon**:
   - Generates compact, low-bandwidth SMS payloads containing precise GPS coordinates, map links, active hazard counts, and navigation ETA for degraded cellular links.
5. **Offline Map Pre-Caching**:
   - Pre-caches map tiles directly into IndexedDB storage for total cellular blackout scenarios.

---

## Getting Started

### Prerequisites

- **Python**: 3.10 to 3.12 (or compatible virtual environment)
- **Node.js**: v18+ and npm
- **Java (for Android builds)**: JDK 17 or JDK 21 LTS (e.g. Eclipse Temurin 21)
- **Android SDK**: Build Tools 34+ / 35+ (for native Android builds)

### 1. Backend Setup

```bash
# Create and activate Python virtual environment
python -m venv .venv
# On Windows PowerShell:
.venv\Scripts\Activate.ps1
# On Linux/macOS:
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run FastAPI server
uvicorn app.index:app --host 0.0.0.0 --port 8000 --reload
```

Once running, access the web client at `http://localhost:8000`.

### 2. Environment Variables (Optional)

- `ONEBAR_PLACE`: Target location string (e.g. `"Battery Park, New York, USA"`).
- `ONEBAR_BBOX`: North, South, East, West degrees (e.g. `"40.78,-74.02,40.70,-73.93"`).
- `ONEBAR_CACHE`: Path to `.graphml` cached graph file (default: `region_graph.graphml`).
- `ONEBAR_API_BASE`: Optional custom API base URL for native mobile containers.

---

## Building Native Mobile Apps

### Android (APK)

```bash
# Install Capacitor dependencies
npm install

# Synchronize web assets to native Android project
npm run cap:sync

# Build Debug APK directly via Gradle
cd android
./gradlew assembleDebug
```

The output APK will be located at:
`android/app/build/outputs/apk/debug/app-debug.apk`

To open the project in Android Studio:
```bash
npm run cap:android
```

### iOS (Xcode)

```bash
# Sync web assets to iOS project
npm run cap:sync

# Open Xcode workspace
npm run cap:ios
```

---

## API Reference

### Health & Region Info
- `GET /health`: Returns service health and timestamp.
- `GET /region`: Returns current spatial bounding box, place name, and graph node/edge counts.

### Offline Region Packs
- `GET /packs/index.json`: Catalogue of downloadable regions (id, bounds, size, checksum).
- `GET /packs/{region_id}.obp`: One region pack — a binary road graph plus safe havens,
  roughly 70 bytes per node (about 20x smaller than the equivalent GraphML).

Build one with:

```bash
python tools/build_pack.py --id lower-manhattan --name "Lower Manhattan"     --point 40.7075,-74.0113 --radius 1200
```

### Hazard Management
- `GET /hazards`: Lists all active hazard zones with geometries and provenance.
- `POST /hazards`: Registers a new radial or polygon hazard zone.
- `POST /hazards/sync-api`: Pulls real-time hazard data from external APIs (NWS, USGS, NASA EONET).
  Returns zero hazards when there are no active alerts. Pass `"drill_mode": true` to add
  clearly-labelled simulated hazards for exercises.
- `DELETE /hazards/{hazard_id}`: Removes an active hazard zone.
- `DELETE /hazards`: Clears all registered hazard zones.

### Safe Havens & Evacuation Routing
- `GET /safe-havens`: Lists designated shelters, hospitals, and assembly points with dynamic compromise status.
- `POST /safe-havens`: Registers a new emergency safe haven.
- `POST /route`: Calculates a resilient route between origin and destination avoiding all active hazards.
- `POST /route/safety`: Automatically identifies the fastest reachable uncompromised safe haven and returns the evacuation path with turn-by-turn guidance.

---

## Safety and data provenance

OneBar is not a substitute for emergency services. Every hazard and safe haven carries a
`provenance` field, and the client renders each class differently:

| Provenance | Meaning | Rendering |
|---|---|---|
| `official` | Issued by NWS/USGS/EONET, or a mapped OSM feature | Solid outline, source link |
| `community` | Reported by another user, unverified | Dashed outline |
| `user` | Drawn on this device | Dashed outline |
| `drill` | Simulated for an exercise | Hatched fill + undismissable DRILL banner |

Two rules the code enforces, with regression tests:

1. **Empty feeds return zero hazards.** Simulated hazards appear only when a caller
   explicitly sets `drill_mode`.
2. **Coordinates outside the loaded graph are refused** with HTTP 422, rather than being
   snapped onto the nearest node and answered with a confident, wrong route.

Safe havens marked `verified: false` exist in OpenStreetMap but have not been confirmed
open or staffed by an authority.

### Reports are private by default

A hazard you draw stays on your device: it is stored against an opaque per-device key,
shown to nobody else, and applied only to your own routing. Turning on **Share this with
other people nearby** uploads it as a `community` report, which other people can see,
confirm, or mark as clear. It never becomes an `official` alert, whatever `source` the
client sends.

Every user-originated report expires — 24 hours for a private one, about 6 hours for a
shared one, extended by confirmations up to a 24-hour ceiling and retired early once three
people say the road is clear. Emergency conditions change, and a stale report still removes
edges from the routing graph. Official alerts expire only on their issuer's own schedule.

A shelter a client adds is stricter still: always `provenance="user"`, never `verified`,
and private to the adding device with no sharing switch. A fabricated hazard costs other
people a detour; a fabricated shelter is somewhere they are sent to.

Writes require an `X-OneBar-Device` header and are rate limited per device **and** per
network origin — a device id is chosen by the client, so limiting on it alone stops honest
users and nothing else. Retiring a community report likewise needs denials from more than
one origin. `DELETE /hazards` and `clear_existing` are operator actions behind
`ONEBAR_ADMIN_TOKEN`; ordinary users delete their own reports one at a time and can delete
nobody else's.

### Privacy

Your location is used on the device and is not sent to OneBar's servers once a region pack
is installed. There are no accounts, no analytics and no third-party tracking. Emergency
contacts and saved trips never leave the phone. See [PRIVACY.md](PRIVACY.md) for the full
statement, including exactly what a shared report uploads.

---

## Running the Automated Test Suite

```bash
.venv\Scripts\python -m pytest
```

Node.js and `npm install` are required for three groups of tests: the cross-engine
route-parity tests (which assert the on-device JavaScript router and the server's Python
router produce identical routes), the frontend boot check (which loads the real page in
jsdom and drives the dialogs), and the client module tests. Without them those tests skip —
and CI fails if they do, because a silent skip removes the only guard against the two
routers diverging or the app failing to load at all.

The automated test suite verifies:
- API endpoint contracts (`tests/test_api.py`)
- Hazard feed parsing and categorization (`tests/test_hazard_feed.py`)
- Safe haven threat evaluation (`tests/test_safe_havens.py`)
- A* routing, fallback penalties, and maneuver calculations (`tests/test_router.py`)
- Spatial STRtree geometric indexing (`tests/test_spatial.py`)
- Hazard persistence store (`tests/test_hazard_store.py`)
- Offline/server routing parity and hazard blocking (`tests/test_route_parity.py`)
- Coverage refusal, provenance guarantees and endpoint authorisation (`tests/test_api.py`)
- Per-device report scoping, community voting, expiry and rate limiting
  (`tests/test_device_scoping.py`)
- Offline and online destination search (`tests/test_geocode.py`)
- The real page booting in jsdom, the onboarding flow, dialog focus trapping and the
  hazard popup's handling of hostile input (`tests/test_frontend_boot.py`)
- The browser modules that carry pure logic, run under Node
  (`tests/test_client_modules.py`)

---

## License

This project is licensed under the MIT License. See [LICENSE.txt](LICENSE.txt) for details.