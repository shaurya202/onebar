# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All Python commands assume the checked-in virtualenv at `.venv` (Windows layout).

```powershell
# Install dependencies (requirements-dev.txt is requirements.txt plus pytest,
# httpx and ruff — the runtime file alone leaves you with no test runner)
.venv\Scripts\python -m pip install -r requirements-dev.txt

# Backend dev server (serves the frontend at http://localhost:8000 too)
.venv\Scripts\python -m uvicorn app.index:app --host 0.0.0.0 --port 8000 --reload

# Full test suite
.venv\Scripts\python -m pytest

# Lint (CI enforces this)
.venv\Scripts\python -m ruff check app tools tests

# Build an offline region pack
.venv\Scripts\python tools/build_pack.py --id lower-manhattan --point 40.7075,-74.0113 --radius 1200

# Single file / single test
.venv\Scripts\python -m pytest tests/test_router.py
.venv\Scripts\python -m pytest tests/test_api.py::test_route_calculation_with_maneuvers
.venv\Scripts\python -m pytest -k maneuver

# Frontend tests. boot_check boots the real page in jsdom; client_tests runs the
# pure browser modules under Node. Both are also driven by pytest
# (tests/test_frontend_boot.py, tests/test_client_modules.py) and both need
# `npm install` first; CI fails if either silently skips.
node tools/boot_check.mjs                 # first run
node tools/boot_check.mjs --onboarded     # returning user
node tools/client_tests.mjs tests/fixtures/packs/test-region.obp

# Native builds (no JS build step — `static/` is the Capacitor webDir verbatim)
npm install               # Capacitor CLI, plus jsdom for the frontend tests
npm run cap:sync          # copy static/ into android/ and ios/
cd android && ./gradlew assembleDebug   # -> android/app/build/outputs/apk/debug/app-debug.apk
npm run cap:android       # open Android Studio
npm run cap:ios           # open Xcode workspace
```

Ruff is configured in `ruff.toml`; there is still no formatter or frontend bundler —
Leaflet is vendored in `static/vendor/` rather than bundled.

## Runtime configuration

Read at startup in `app/index.py`'s lifespan: `ONEBAR_PLACE`, `ONEBAR_BBOX` ("north,south,east,west"), `ONEBAR_POINT` ("lat,lon") + `ONEBAR_RADIUS` (metres, default 5000), `ONEBAR_CACHE` (default `region_graph.graphml`), `ONEBAR_HAZARDS_FILE`, `ONEBAR_HAVENS_FILE`. `ONEBAR_API_BASE` (or the `onebar_api_host` localStorage key) points the native client at a remote backend.

Multi-user and search behaviour: `ONEBAR_ADMIN_TOKEN` (operator token for `DELETE /hazards`
and `clear_existing`; unset disables those entirely), `ONEBAR_RATE_LIMIT=0` (disables
per-device limiting), `ONEBAR_DEVICE_SALT` / `ONEBAR_DEVICE_SALT_FILE` (salt for hashing
device ids — generated beside the hazard store on first run if unset),
`ONEBAR_USER_HAZARD_TTL_H` (default 24), `ONEBAR_COMMUNITY_TTL_H` (default 6),
`ONEBAR_COMMUNITY_MAX_TTL_H` (default 24), `ONEBAR_OFFICIAL_MAX_AGE_H` (default 6),
`ONEBAR_DRILL_TTL_H` (default 2), `ONEBAR_FEED_CACHE_SECONDS` (default 120),
`ONEBAR_GEOCODING=0` (disables the network geocoder), `ONEBAR_GEOCODER_URL` /
`ONEBAR_GEOCODER_REVERSE_URL` (self-hosted Nominatim), `ONEBAR_ALLOWED_ORIGINS`,
`ONEBAR_HAVEN_DISCOVERY=0`, `ONEBAR_PACK_DIR`.

## Architecture

### Import convention (unusual — get this right first)

`app/index.py` prepends `app/` to `sys.path`, so every backend module imports its siblings as **top-level** modules: `from api import api_router`, `from schemas import LatLon` — never `from app.api import ...`. Test files repeat the same `sys.path.insert` and do `from index import app`. Adding an `app.`-prefixed import will break at runtime.

### Request path

`app/index.py` (FastAPI app, CORS + GZip middleware, static/PWA routes) builds three singletons into `app.state` during lifespan and every endpoint in `app/api.py` reaches them via `request.app.state`:

- **`GraphManager`** (`app/graph_loader.py`) — loads the road network with a three-step fallback: cached `.graphml` → OSMnx download (then cached to disk) → a synthetic 5×5 NYC grid. The grid sets `is_synthetic`, and **routing endpoints refuse with 503 when it is set**: its edges are invented streets at real Lower Manhattan coordinates, so a user actually standing there would pass the coverage check and be handed directions down roads that do not exist. It exists so the process starts, not so it can route. It builds two `STRtree` indices: one over edge LineStrings (for hazard intersection) and one over node Points (for `nearest_node`).
- **`HazardStore`** (`app/hazard_store.py`) — each hazard is kept as `{"zone": HazardZone, "polygon": Shapely Polygon, "reporter": str | None, "votes": {owner: "confirm"|"deny"}}`; the polygon is the *effective* (buffered) geometry. Radial hazards are converted to 32-point polygons at creation. Persists to `hazards_store.json` via atomic temp-file + `os.replace` on every mutation. **Every read takes a `viewer`** — see "Report scoping" below.
- **`DeviceIdentity`** (`app/device.py`) — turns the `X-OneBar-Device` header into a salted, non-reversible owner key. The raw header is never persisted.
- **`RateLimiter`** (`app/ratelimit.py`) — in-memory fixed-window counters per device per endpoint bucket. Process-local by design; a multi-worker deployment needs a shared store behind the same interface.
- **`SafeHavenStore`** (`app/safe_havens.py`) — seeded from `DEFAULT_NYC_SAFE_HAVENS`, or replaced with generated regional havens by `seed_for_region` when the graph centre is >25 km from NYC. Compromise status is *not* stored; it is recomputed on every read by testing the haven point against live hazard polygons.

Routing (`app/router.py`) is a copy-and-mutate pipeline: `_build_routing_graph` copies the graph, writes a mode-dependent `w` weight onto every edge, then **removes** blocked edges. If A\* raises `NetworkXNoPath` and fallback is allowed, it rebuilds with blocked edges weighted ×100 instead of removed and flags `is_fallback` with a warning. `/route/safety` runs that whole routine once per uncompromised haven and ranks results by (non-fallback first, then travel time), returning up to 4 runners-up as `alternatives`.

Hazard ingestion (`app/hazard_feed.py`) normalises NWS, USGS and NASA EONET GeoJSON into a common dict shape that `HazardStore.add` accepts. Each fetcher swallows its own exceptions and returns `[]`, and `fetch_all_external_hazards` falls back to `generate_scenario_hazards` (synthetic drill hazards, source `crisis_feed`) when nothing was collected — so `/hazards/sync-api` always returns something.

### Frontend (`static/`)

Vanilla ES modules, no framework, Leaflet 1.9.4 from unpkg CDN. Roles are strictly separated:

- `js/app.js` — the only stateful module (`appState` machine: `idle | planner | route | draw | pick_origin | pick_dest`), owns all DOM wiring, GPS watch, connectivity polling, wake lock and compass.
- `js/map.js` — owns every Leaflet layer and marker; exports imperative functions (`addHazardLayer`, `showRoute`, `startDraw`, …). `app.js` never touches Leaflet directly.
- `js/api.js` — the only `fetch` layer. Hazard reads/writes degrade to IndexedDB: failed adds become `local-*` zones plus a queued mutation, and `api.syncPending()` replays the queue when connectivity returns.
- `js/offline-store.js` — IndexedDB (`hazards` + `mutations` stores).
- `js/pack-store.js`, `js/pack-format.js`, `js/route-engine.js`, `js/router-worker.js`, `js/offline-router.js` — the offline routing stack (see below).
- `sw.js` — cache-first for the shell, static assets and tiles; network-first (never stale) for API calls. Leaflet is served from `static/vendor/`, so the app boots with no CDN.

Newer modules: `js/device.js` (the opaque per-device id sent on every request),
`js/focus-trap.js` (**the only** way to show or hide a dialog — `openModal`/`closeModal`),
`js/contacts.js` (emergency contacts in localStorage), `js/trip-store.js` (the in-progress
journey, in IndexedDB), `js/search.js` (merges pack search, server geocoding and pasted
coordinates), `js/pack-search.js` (the offline street/shelter index, built in the worker).

`app.js`'s boot block is **deliberately the last thing in the module**. It used to sit
mid-file, above `const` declarations that the init functions close over; function
declarations hoist and `const` does not, so it threw a `ReferenceError` at module load —
which, with no build step and no error boundary, is a blank screen. Keep it at the bottom.

Adding an endpoint means touching three files in order: a Pydantic model in `app/schemas.py`, the route in `app/api.py`, and a wrapper in `static/js/api.js`.

### Report scoping (get this right or one user's map leaks into another's)

The stores are process-global singletons shared by every client, so **every read path takes
a `viewer` owner key** and every write path takes a `reporter`:

- `HazardStore.list/get/iter_polygons/blocked_edges(..., viewer=)` — a `visibility="private"`
  report is visible to, and routed around by, its reporter alone.
- `SafeHavenStore.list/get/get_safe_candidates(..., viewer=)` — passes it through to the
  hazard polygons that decide whether a shelter is compromised.
- `app/api.py` gets the key from `viewer_key(request)` for reads and `require_device(request)`
  for writes. **Forgetting to thread `viewer` into a new routing path silently applies one
  device's private reports to everybody else's routes.**

`POST /hazards` writes `provenance="user"` + `visibility="private"` by default, or
`provenance="community"` + `visibility="shared"` when the client sends `share: true`.
A client can never produce `provenance="official"`.

**`POST /safe-havens` has no sharing switch at all.** A haven a client adds is always
`provenance="user"`, `verified=False` and private to the adding device. A fabricated
hazard costs other people a detour; a fabricated shelter is a destination they are sent
to, and no stranger can check whether a building is open. Publishing a shelter to
everyone requires an authoritative source — the OSM discovery path, or a verified feed.

Community reports carry confirm/deny votes (one per device, the reporter excluded).
Retirement needs 3 denials outweighing confirmations **from at least 2 distinct network
origins** (`device.peer_source`): device ids are client-minted, so counting them alone
lets one script delete a real report of a real blockage.

Everything expires. User reports on their own TTL; drill fixtures in 2 h; official alerts
on the issuer's `expires_at` when it publishes one, otherwise on a bounded window that
every re-sync refreshes — an alert nobody is publishing any more must not block roads for
ever. Feed items get a deterministic id from `stable_feed_id(...)`, keyed on the issuer's
own identifier, so a re-sync (or a revised headline) updates rather than duplicates.

**Drill fixtures are private to the device that started the drill** and their ids are
namespaced by it. Written into shared state they put fabricated hazards, at coordinates of
the caller's choosing, onto every other device's map.

Rate limiting is charged twice per request: once against the device, once against
`peer_source(request)`. The device header is minted by the client, so a per-device limit
alone stops honest users and nothing else.

## Offline routing (the core of the product)

Routing is **client-authoritative**. `tools/build_pack.py` produces a binary `.obp`
region pack (~70 B/node, ~20x smaller than GraphML) containing a CSR road graph, street
names and real OSM safe havens. The client downloads it (`static/js/pack-store.js`),
parses it into typed arrays with no copying (`pack-format.js`) and runs A* in a Web
Worker (`route-engine.js` + `router-worker.js`). The server's `/route` endpoints are a
fallback for the browser PWA before a pack is installed.

Because two implementations of the same algorithm exist, `tests/test_route_parity.py`
runs the JS engine under Node and asserts it agrees with `app/router.py`. **If you change
routing logic, change both and keep that test green** — it is the only thing preventing
the offline and online routes from diverging.

## Non-negotiable safety invariants

These are enforced by tests; do not weaken them.

- **Never fabricate emergency data.** `generate_scenario_hazards()` is reachable only via
  an explicit `drill_mode` flag, and its output is stamped `provenance="drill"` with
  "NOT REAL" in the name. An empty feed returns `fetched_count: 0`.
- **Never route from or to a point outside the graph.** `nearest_node()` will snap any
  coordinate on Earth; every routing entry point must call `_require_coverage()` first.
- **Never offer a haven the graph cannot reach.** Snapping a distant haven to a boundary
  node produces a route that claims to arrive somewhere it does not.
- **Never claim authority for user input.** `POST /hazards` writes `provenance="user"`
  or `"community"`, whatever `source` the client sends — never `"official"`. The same
  applies to `POST /safe-havens`, and to records loaded from a store file that predate
  the `provenance` field: they default to `"user"` unless they carry an `osm_id`.
- **Never route on an invented road network.** `_require_real_graph()` refuses when the
  synthetic fallback grid is loaded. Directions along streets that do not exist are the
  same class of fabrication as an invented shelter.
- **Every stored record must have a bound.** A hazard loaded from a file written before
  expiry existed is backfilled from its `created_at`, not from now — otherwise it never
  expires, belongs to nobody, blocks everyone's routing, and no endpoint an ordinary
  user can reach will delete it.
- **Never render another device's text as markup.** Reports are shareable, so hazard
  names, descriptions and `source_url`s are attacker-controlled. `static/js/map.js` sets
  them with `textContent` and filters links to `http(s)` via `safeHttpUrl()`.
- **Never say a report was filed when the server refused it.** `static/js/api.js` only
  degrades to a queued local write on a *connectivity* failure (`isConnectivityFailure`);
  a 4xx is surfaced as an error.

## Gotchas

- **The shipped runtime is Python 3.12** — the Dockerfile builds on `python:3.12-slim`
  and CI runs the suite on 3.12 — while the checked-in dev venv is 3.14. 3.14 postpones
  annotation evaluation (PEP 649) and 3.12 does not, so a module that imports fine
  locally can raise at import time in CI. `HazardStore.list`/`get` and
  `SafeHavenStore.list`/`get` shadow the builtins inside their class bodies, which made
  every later `list[...]` annotation a `TypeError: 'function' object is not
  subscriptable` on 3.12; both modules carry `from __future__ import annotations` for
  that reason. Don't drop those imports, and don't trust a green local run alone.
- **Coordinate order flips at the boundary.** Shapely, OSMnx and graph node attributes use `(x=lon, y=lat)`; the API schemas, Leaflet and all JSON payloads use `{lat, lon}`. `GraphManager.nearest_node(lon, lat)` takes lon first. Verify ordering on any new spatial code.
- **Test isolation is mandatory.** `tests/conftest.py` redirects `ONEBAR_HAZARDS_FILE`,
  `ONEBAR_HAVENS_FILE` and `ONEBAR_CACHE` into `tmp_path` and disables network haven
  discovery. Runs previously rewrote the repo-root JSON stores, and the residue was
  committed and shipped as real shelter data. CI fails if a test run dirties the tree.
- **The A\* heuristic divisor comes from the graph.** `GraphManager.max_speed_mps` is the
  true maximum edge speed, so admissibility holds by construction. Both routers use it;
  don't reintroduce a hardcoded constant.
- **Bumping `CACHE_NAME` in `sw.js` requires updating the `SHELL` list in the same file.**
  The old `tile-cache.js` bulk OSM tile scraper has been removed: it violated the OSM
  tile usage policy and wrote into a cache the service worker then deleted.
- Use `HazardStore.iter_polygons(viewer)` rather than reaching into `_hazards`.
- **`HazardStore` never hands out its stored `HazardZone` instances.** `mine` and
  `my_vote` differ per caller, so `_decorate()` returns a `model_copy`. Mutating the
  stored instance would leak one device's ownership into the next request's response.
- **Dialogs must go through `openModal`/`closeModal`** (`static/js/focus-trap.js`), not
  `show()`/`hide()`. They own focus trapping, Escape, focus restoration and the body
  scroll lock; a dialog shown by toggling `.hidden` has none of that.
- **Both routing paths go through `tryOfflineRoute()` first.** `autoEvacuateToSafety`
  *and* `requestRoute` — the second had no offline path at all, so a searched address, a
  tapped shelter, a dropped pin and a restored trip each needed a connection with a pack
  sitting unused on the device. A failing worker returns null and falls back to the
  server rather than aborting the request.
- **Anything a client can type is rendered with `textContent`, never interpolated into
  `innerHTML`.** Hazard names, descriptions, shelter names, addresses and
  `compromised_reason` all now arrive from other devices. Links go through
  `safeHttpUrl()` in `map.js`, which drops anything that is not http(s).
- **The frontend has real tests now.** `tools/boot_check.mjs` boots the actual page in
  jsdom (driven by `tests/test_frontend_boot.py`) and `tools/client_tests.mjs` runs the
  pure browser modules under Node (`tests/test_client_modules.py`). Both skip if Node or
  `npm install` has not run, and CI fails if they skip. Adding a DOM id or a dialog
  without updating `boot_check.mjs` leaves it untested.
  The boot check has four scenarios, and they test different things:
  no flags (first run, everything offline), `--onboarded` (returning user, dialogs),
  `--onboarded --online` (canned API, full route flow), and
  `--onboarded --online --pack` (a real region pack in a fake IndexedDB — asserts routing
  does **not** touch the network). `tools/fake_idb.mjs` is the in-memory IndexedDB the
  last two lean on.
- **Adding a `static/js/` module means adding it to `SHELL` in `sw.js` and bumping
  `CACHE_NAME`.** A module missing from the shell makes the app fail to boot offline —
  the one thing it exists to do. `tests/test_service_worker.py` enforces both directions.
- **The server runs one worker, and the Dockerfile must keep it that way.**
  `HazardStore`, `SafeHavenStore`, `RateLimiter` and `DeviceIdentity` are per-process
  singletons that persist by rewriting their entire dict to one JSON file; a second
  worker makes reports vanish at random. Scaling out means a shared store first.
- **`ensureRegionLoaded()` caches the *merged* region record**, not the catalogue entry
  from localStorage. The haven list exists only inside the pack, so returning the bare
  entry on the second call emptied `offlineHavens()` for the rest of the session — and
  an empty list then wiped every shelter from the map.
- **An empty array from the network is an answer; an empty array from a failed offline
  lookup is not.** `loadSafeHavens()` distinguishes them; conflating the two clears the
  shelter layer precisely when the network is gone.

## Conventions

From `AGENTS.md` (contributor guidance) and `README.md`:

- Android is the primary target, iOS must reach parity. Interactive controls are minimum 48×48 px for gloved, one-handed use.
- Keep the payload small and framework-free; the app must stay usable on 2G-grade links and fully offline.
- Prefer graceful degradation over hard failure — routing falls back to penalised paths,
  graph loading falls back to a synthetic grid, and the client falls back to IndexedDB.
  **The one exception is data provenance:** degrading into invented hazards or shelters is
  never acceptable. Where the honest answer is "no data", say so and refuse.
