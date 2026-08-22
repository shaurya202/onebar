"""
Per-device rate limiting for write endpoints.

The hazard map is shared state reachable by any client on the internet. Without a
limiter, a single script can fill it with thousands of polygons — and because hazards
remove edges from the routing graph, flooding the map is not merely noise, it is a
denial of evacuation routing for everyone in the region.

This is a fixed-window counter held in memory. That is the right size of solution for
a single-process deployment and is honest about its limits: it does not survive a
restart and does not coordinate across workers. A multi-worker deployment should put a
shared store behind the same interface rather than assume this is enough.
"""

import os
import threading
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class Limit:
    """`count` requests allowed per `window_seconds`."""
    count: int
    window_seconds: float


# Deliberately generous: these exist to stop scripted abuse, not to ration the app.
# A person reporting hazards during an actual emergency will never come close.
DEFAULT_LIMITS: dict[str, Limit] = {
    "hazard_write": Limit(count=30, window_seconds=60.0),
    "hazard_vote": Limit(count=60, window_seconds=60.0),
    "feed_sync": Limit(count=10, window_seconds=60.0),
    "geocode": Limit(count=60, window_seconds=60.0),
    "push_write": Limit(count=30, window_seconds=60.0),
    # One build can hammer Overpass for minutes and tens of megabytes; a handful per
    # device per hour is plenty for "download where I am".
    "pack_build": Limit(count=5, window_seconds=3600.0),
    # A device id is minted by the client, so rotating it mints a fresh allowance and
    # the per-device limit alone stops nothing. Every bucket is therefore also charged
    # against the peer address, at a ceiling high enough that a household or a café
    # behind one NAT is never affected but a single host cannot flood the map.
    "hazard_write.peer": Limit(count=120, window_seconds=60.0),
    "hazard_vote.peer": Limit(count=180, window_seconds=60.0),
    "feed_sync.peer": Limit(count=40, window_seconds=60.0),
    "geocode.peer": Limit(count=240, window_seconds=60.0),
    "push_write.peer": Limit(count=120, window_seconds=60.0),
    "pack_build.peer": Limit(count=30, window_seconds=3600.0),
}


class RateLimiter:
    def __init__(self, limits: dict[str, Limit] | None = None, enabled: bool | None = None) -> None:
        self.limits = dict(limits or DEFAULT_LIMITS)
        if enabled is None:
            enabled = os.getenv("ONEBAR_RATE_LIMIT", "1") not in ("0", "false", "False")
        self.enabled = enabled
        self._buckets: dict[tuple[str, str], tuple[float, int]] = {}
        self._lock = threading.Lock()

    def check(self, bucket: str, key: str) -> float:
        """Consume one unit. Returns 0.0 when allowed, else seconds until it resets."""
        if not self.enabled:
            return 0.0
        limit = self.limits.get(bucket)
        if limit is None:
            return 0.0

        now = time.monotonic()
        with self._lock:
            window_start, used = self._buckets.get((bucket, key), (now, 0))
            if now - window_start >= limit.window_seconds:
                window_start, used = now, 0
            if used >= limit.count:
                return max(0.0, limit.window_seconds - (now - window_start))
            self._buckets[(bucket, key)] = (window_start, used + 1)

            # Opportunistic sweep so a long-lived process does not accumulate a bucket
            # per device it has ever seen.
            if len(self._buckets) > 4096:
                self._buckets = {
                    k: v for k, v in self._buckets.items()
                    if now - v[0] < self.limits.get(k[0], limit).window_seconds
                }
        return 0.0

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()
