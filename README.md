# OneBar

A mobile-first emergency evacuation map and resilient routing application designed specifically for crisis scenarios where cellular connectivity is degraded ("one bar" of signal) or intermittent.

---

## Core Philosophy

During natural disasters (wildfires, flash floods, earthquakes, severe storms) and civil crises, cellular bandwidth drops dramatically while roads become impassable. OneBar is engineered for this exact condition:

- **Ultra-Lightweight Payload Footprint**: No heavy frontend frameworks or bulky UI bundles. Native HTML5, Vanilla CSS, and lightweight Leaflet.js.
- **Fail-Safe Spatial Routing**: Real-time A* routing on OpenStreetMap graphs avoiding dynamic hazard perimeters with zero external third-party routing dependencies.
- **Real-Time Emergency Feed Ingestion**: Ingests active alerts from NOAA/NWS, USGS Earthquakes, and NASA EONET feeds.
- **Offline Resilience**: Caches map tiles, regional graph data, and hazard zones locally in IndexedDB and Service Workers.
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

### Hazard Management
- `GET /hazards`: Lists all active hazard zones with geometries.
- `POST /hazards`: Registers a new radial or polygon hazard zone.
- `POST /hazards/sync-api`: Pulls real-time hazard data from external APIs (NWS, USGS, NASA EONET, Crisis Feed).
- `DELETE /hazards/{hazard_id}`: Removes an active hazard zone.
- `DELETE /hazards`: Clears all registered hazard zones.

### Safe Havens & Evacuation Routing
- `GET /safe-havens`: Lists designated shelters, hospitals, and assembly points with dynamic compromise status.
- `POST /safe-havens`: Registers a new emergency safe haven.
- `POST /route`: Calculates a resilient route between origin and destination avoiding all active hazards.
- `POST /route/safety`: Automatically identifies the fastest reachable uncompromised safe haven and returns the evacuation path with turn-by-turn guidance.

---

## Running the Automated Test Suite

```bash
.venv\Scripts\python -m pytest
```

The automated test suite verifies:
- API endpoint contracts (`tests/test_api.py`)
- Hazard feed parsing and categorization (`tests/test_hazard_feed.py`)
- Safe haven threat evaluation (`tests/test_safe_havens.py`)
- A* routing, fallback penalties, and maneuver calculations (`tests/test_router.py`)
- Spatial STRtree geometric indexing (`tests/test_spatial.py`)
- Hazard persistence store (`tests/test_hazard_store.py`)

---

## License

This project is licensed under the MIT License. See [LICENSE.txt](LICENSE.txt) for details.