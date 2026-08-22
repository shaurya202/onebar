"""
Web Push relay: turns new shared hazards into encrypted push notifications.

Delivery is deliberately fire-and-forget. A push that fails to send must never
fail the request that created the hazard — the map write is the important part;
the notification is a courtesy to everyone else watching that area.

pywebpush is an optional dependency. A deployment without it (or without VAPID
keys configured) still runs; the relay simply reports that it sent nothing, and
the client's subscribe endpoint says push is unavailable so nobody subscribes
into a void.
"""

from __future__ import annotations

import json
import logging
import math
import os

logger = logging.getLogger("onebar.push")

_VAPID_PRIVATE = "ONEBAR_VAPID_PRIVATE_KEY"
_VAPID_PUBLIC = "ONEBAR_VAPID_PUBLIC_KEY"


def vapid_public_key() -> str | None:
    key = os.getenv(_VAPID_PUBLIC)
    return key or None


def vapid_configured() -> bool:
    return bool(os.getenv(_VAPID_PRIVATE) and os.getenv(_VAPID_PUBLIC))


def _vapid_claims() -> dict:
    return {"sub": os.getenv("ONEBAR_VAPID_SUBJECT", "mailto:ops@onebar.example")}


def hazard_bbox(zone) -> dict | None:
    """The bounds of a hazard zone, from polygon points or a centre plus radius."""
    coords = getattr(zone, "coordinates", None) or []
    lats = [c.lat for c in coords]
    lons = [c.lon for c in coords]
    center = getattr(zone, "center", None)
    if center:
        radius = float(getattr(zone, "radius_meters", 0.0) or 0.0)
        deg_lat = max(0.0, radius) / 111_320.0
        deg_lon = deg_lat / max(0.1, abs(math.cos(center.lat * 0.0174533)))
        lats.extend([center.lat - deg_lat, center.lat + deg_lat])
        lons.extend([center.lon - deg_lon, center.lon + deg_lon])
    if not lats:
        return None
    return {
        "min_lat": min(lats), "max_lat": max(lats),
        "min_lon": min(lons), "max_lon": max(lons),
    }


def alert_payload(zone) -> dict:
    """The JSON delivered to the service worker. Kept small — push messages cap at 4 KB."""
    name = getattr(zone, "name", None) or "Hazard alert"
    kind = (getattr(zone, "hazard_type", "") or "hazard").capitalize()
    severity = getattr(zone, "severity", None)
    body = f"{kind}: {name}"
    if severity and severity != "moderate":
        body = f"{severity.capitalize()} {body[0].lower()}{body[1:]}"
    return {
        "title": "OneBar hazard alert",
        "body": body,
        "tag": f"hazard-{getattr(zone, 'hazard_id', '')}",
        "hazard_id": getattr(zone, "hazard_id", None),
    }


def send_to_subscription(record: dict, payload: dict) -> str:
    """Encrypt and push one message. Returns 'ok' | 'gone' | 'error' | 'disabled'."""
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        logger.warning("pywebpush is not installed; push notifications are disabled.")
        return "disabled"

    try:
        webpush(
            subscription_info={
                "endpoint": record["endpoint"],
                "keys": {"p256dh": record["keys"]["p256dh"], "auth": record["keys"]["auth"]},
            },
            data=json.dumps(payload),
            vapid_private_key=os.getenv(_VAPID_PRIVATE),
            vapid_claims=_vapid_claims(),
        )
        return "ok"
    except WebPushException as e:
        response = getattr(e, "response", None)
        status = getattr(response, "status_code", None)
        if status in (404, 410):
            # The browser revoked this subscription (site cleared, permission
            # withdrawn, endpoint expired). Keeping it would poison every future send.
            return "gone"
        logger.warning("Push delivery failed (%s): %s", status, e)
        return "error"
    except Exception as e:
        logger.warning("Push delivery failed unexpectedly: %s", e)
        return "error"


def notify_hazard(store, zone, exclude_device: str | None = None) -> dict:
    """Send one hazard to every subscriber watching its area.

    `exclude_device` keeps a device from being woken by its own report.
    """
    summary = {"matched": 0, "sent": 0, "pruned": 0}
    bbox = hazard_bbox(zone)
    if bbox is None or not vapid_configured():
        return summary

    payload = alert_payload(zone)
    for record in store.matching(bbox):
        summary["matched"] += 1
        if exclude_device and record.get("device") == exclude_device:
            continue
        outcome = send_to_subscription(record, payload)
        if outcome == "ok":
            summary["sent"] += 1
        elif outcome == "gone":
            store.drop(record["endpoint"])
            summary["pruned"] += 1
    return summary
