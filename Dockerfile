# OneBar backend + static client.
#
# Serves the API, the PWA, and the pre-built offline region packs. Packs are large
# and immutable, so a real deployment should front this with a CDN and point
# ONEBAR_PACK_DIR at mounted storage rather than baking them into the image.

FROM python:3.12-slim AS base

# GeoPandas/Shapely/pyproj need GEOS and PROJ at runtime.
RUN apt-get update && apt-get install --no-install-recommends -y \
        libgeos-c1v5 \
        libproj25 \
        curl \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv/onebar

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY static/ ./static/
COPY tools/ ./tools/
# The first-run screen links to /privacy and both app stores require the URL to
# resolve; without this the route 500s in the shipped image.
COPY PRIVACY.md ./

# Region graph cache and pack storage. Mount a volume here in production so a
# restart doesn't re-download the road network.
RUN mkdir -p /srv/onebar/data /srv/onebar/packs
ENV ONEBAR_CACHE=/srv/onebar/data/region_graph.graphml \
    ONEBAR_HAZARDS_FILE=/srv/onebar/data/hazards_store.json \
    ONEBAR_HAVENS_FILE=/srv/onebar/data/safe_havens_store.json \
    ONEBAR_PACK_DIR=/srv/onebar/packs

RUN useradd --system --uid 10001 onebar && chown -R onebar /srv/onebar
USER onebar

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

# No --reload: that is a development flag and was the only documented way to run this.
#
# Single worker, deliberately. HazardStore, SafeHavenStore, RateLimiter and
# DeviceIdentity are per-process in-memory singletons that persist by rewriting their
# whole dict to one JSON file. With two workers, a report filed against one worker is
# invisible to the other, and the next save from either erases it from disk — reports
# would disappear at random. Scaling out means moving those four behind a shared store
# first; app/ratelimit.py says as much in its own docstring.
CMD ["python", "-m", "uvicorn", "app.index:app", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
