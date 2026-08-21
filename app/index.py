import os
import sys
from contextlib import asynccontextmanager

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from api import api_router
from device import DeviceIdentity
from graph_loader import GraphManager
from hazard_store import HazardStore
from ratelimit import RateLimiter
from safe_havens import SafeHavenStore

# Resolve paths relative to project root (parent of this file's directory)
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_STATIC_DIR = os.path.join(_ROOT, "static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Env vars:
      ONEBAR_PLACE        — named place string
      ONEBAR_BBOX         — "north,south,east,west"
      ONEBAR_POINT        — "lat,lon"
      ONEBAR_RADIUS       — metres around ONEBAR_POINT (default 5000)
      ONEBAR_CACHE        — .graphml cache path (default region_graph.graphml)
      ONEBAR_HAZARDS_FILE — hazards persistence file path (default hazards_store.json)
      ONEBAR_HAVENS_FILE  — safe havens persistence file path (default safe_havens_store.json)
      ONEBAR_ADMIN_TOKEN  — operator token for destructive endpoints (unset = disabled)
      ONEBAR_RATE_LIMIT   — "0" disables per-device rate limiting
      ONEBAR_DEVICE_SALT  — overrides the generated salt used to hash device ids
    """
    cache_file = os.getenv("ONEBAR_CACHE", "region_graph.graphml")
    radius = float(os.getenv("ONEBAR_RADIUS", "5000"))
    hazard_file = os.getenv("ONEBAR_HAZARDS_FILE", os.path.join(_ROOT, "hazards_store.json"))
    haven_file = os.getenv("ONEBAR_HAVENS_FILE", os.path.join(_ROOT, "safe_havens_store.json"))
    bbox = point = None

    if raw := os.getenv("ONEBAR_BBOX"):
        n, s, e, w = (float(x) for x in raw.split(","))
        bbox = (n, s, e, w)
    elif raw := os.getenv("ONEBAR_POINT"):
        lat, lon = (float(x) for x in raw.split(","))
        point = (lat, lon)

    app.state.graph_manager = GraphManager(
        place_name=os.getenv("ONEBAR_PLACE"),
        bbox=bbox, point=point, radius=radius, cache_file=cache_file,
    )
    app.state.hazard_store = HazardStore(persistence_file=hazard_file)
    app.state.safe_haven_store = SafeHavenStore(persistence_file=haven_file)
    # Reports are attributed to an opaque per-device key so a device can manage its
    # own reports without OneBar holding an account, an email address or a name.
    app.state.device_identity = DeviceIdentity(neighbour_file=hazard_file)
    app.state.rate_limiter = RateLimiter()

    # Seed havens if region is initialized
    summary = app.state.graph_manager.get_summary()
    if summary and summary.get("bounds"):
        b = summary["bounds"]
        center_lat = (b["min_lat"] + b["max_lat"]) / 2 if b["min_lat"] != 0 else 40.7128
        center_lon = (b["min_lon"] + b["max_lon"]) / 2 if b["min_lon"] != 0 else -74.0060
        app.state.safe_haven_store.seed_for_region(center_lat, center_lon, b)

    yield


app = FastAPI(
    title="OneBar",
    description="Mobile-first emergency map and evacuation routing API.",
    version="0.4.0",
    lifespan=lifespan,
)

# CORS was allow_origins=["*"] with allow_credentials=True — a combination browsers
# reject for credentialed requests anyway, and one that left every endpoint open to
# any site. Native builds send no Origin header, so they are unaffected by this.
# Capacitor 7 is configured here with `androidScheme`/`iosScheme` of "https", so the
# WebView's origin is `https://localhost` — not the `capacitor://` and `ionic://`
# schemes older versions used. Both are listed: the first is what this build sends, the
# rest keep an older or differently-configured client working.
_allowed_origins = [
    o.strip() for o in os.getenv("ONEBAR_ALLOWED_ORIGINS", "").split(",") if o.strip()
] or [
    "https://localhost",
    "http://localhost",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "capacitor://localhost",
    "ionic://localhost",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-OneBar-Device", "X-OneBar-Admin"],
)
app.add_middleware(GZipMiddleware, minimum_size=500)
app.include_router(api_router)

# Serve frontend SPA and PWA essentials at root scope
@app.get("/", include_in_schema=False)
async def spa_root():
    return FileResponse(os.path.join(_STATIC_DIR, "index.html"), media_type="text/html")


@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    return FileResponse(
        os.path.join(_STATIC_DIR, "sw.js"),
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
    )


@app.get("/privacy", include_in_schema=False)
async def privacy_policy():
    """Serve the privacy statement.

    Both app stores require a reachable policy URL, and the app links here from its
    first-run flow. Served as plain text so it renders in a browser and inside the
    native WebView without a Markdown renderer or a second stylesheet.
    """
    return FileResponse(
        os.path.join(_ROOT, "PRIVACY.md"),
        media_type="text/plain; charset=utf-8",
    )


@app.get("/manifest.webmanifest", include_in_schema=False)
async def web_manifest():
    return FileResponse(
        os.path.join(_STATIC_DIR, "manifest.webmanifest"),
        media_type="application/manifest+json",
    )


app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")
