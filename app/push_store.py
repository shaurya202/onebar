"""
Push subscription storage for nearby-hazard alerts.

A subscription binds three facts: an opaque Web Push endpoint URL (minted by the
browser's push service), the encryption keys needed to speak to it, and the area
the device asked to be watched. No account, email address or name is involved —
the subscription is attributed to the same opaque hashed device key that owns
hazard reports, so a device can manage (but not read) its own subscriptions.

The endpoint URL is itself a bearer capability: whoever holds it can push a
notification to that browser. It is therefore never logged and only ever sent
back to the device that registered it.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import UTC, datetime

logger = logging.getLogger("onebar.push")


class PushSubscriptionStore:
    """In-memory map of push subscriptions, persisted atomically like the other stores."""

    def __init__(self, persistence_file: str | None = "push_subscriptions.json") -> None:
        self.persistence_file = persistence_file
        # endpoint URL -> subscription record
        self._subs: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._load()

    def _load(self) -> None:
        if self.persistence_file and os.path.exists(self.persistence_file):
            try:
                with open(self.persistence_file, encoding="utf-8") as f:
                    data = json.load(f)
                for item in data:
                    endpoint = item.get("endpoint")
                    if endpoint:
                        self._subs[endpoint] = item
            except Exception as e:
                logger.warning(f"Failed to load push subscriptions from {self.persistence_file}: {e}")

    def _save(self) -> None:
        if not self.persistence_file:
            return
        try:
            temp_file = f"{self.persistence_file}.tmp"
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(list(self._subs.values()), f, indent=2)
            os.replace(temp_file, self.persistence_file)
        except Exception as e:
            logger.warning(f"Failed to save push subscriptions: {e}")

    def upsert(
        self,
        endpoint: str,
        keys: dict,
        device: str,
        watch_area: dict | None,
    ) -> dict:
        """Register or refresh a subscription. Re-subscribing updates keys and area."""
        with self._lock:
            existing = self._subs.get(endpoint)
            record = {
                "endpoint": endpoint,
                "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]},
                "device": device,
                "watch_area": watch_area,
                "created_at": existing["created_at"] if existing
                else datetime.now(UTC).isoformat(),
            }
            self._subs[endpoint] = record
            self._save()
            return dict(record, keys=dict(record["keys"]), watch_area=watch_area)

    def remove(self, endpoint: str) -> dict | None:
        """Drop one subscription. Returns the removed record, or None."""
        with self._lock:
            record = self._subs.pop(endpoint, None)
            if record is not None:
                self._save()
            return record

    def for_device(self, device: str) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._subs.values() if r["device"] == device]

    def get(self, endpoint: str) -> dict | None:
        with self._lock:
            record = self._subs.get(endpoint)
            return dict(record) if record else None

    def matching(self, bbox: dict) -> list[dict]:
        """Subscriptions whose watched rectangle intersects the given bounds.

        A record with no watch area matches nothing: it was either written by an
        older client or corrupted, and guessing "everywhere" would spam devices
        with alerts about places they have never been.
        """
        area = bbox
        with self._lock:
            out = []
            for r in self._subs.values():
                w = r.get("watch_area")
                if not w:
                    continue
                if (
                    w["min_lat"] <= area["max_lat"]
                    and w["max_lat"] >= area["min_lat"]
                    and w["min_lon"] <= area["max_lon"]
                    and w["max_lon"] >= area["min_lon"]
                ):
                    out.append(dict(r))
            return out

    def drop(self, endpoint: str) -> None:
        """Remove a dead subscription discovered while sending (404/410 from the service)."""
        with self._lock:
            if self._subs.pop(endpoint, None) is not None:
                self._save()

    def count(self) -> int:
        with self._lock:
            return len(self._subs)
