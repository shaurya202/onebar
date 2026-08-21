"""
Device identity for write operations.

OneBar has no accounts and asks for no personal data, but the hazard map is shared
state: before this module any anonymous client could delete another user's report, and
a hazard drawn on one phone appeared on every phone in the deployment. Ownership is
therefore established by an opaque identifier the client generates once and stores
locally, sent as the `X-OneBar-Device` header.

Two properties matter:

* The identifier is **not** a credential for anything except "these are my own
  reports". It grants no read access to other devices' data and carries no PII.
* It is never persisted in the clear. The raw header value is a bearer token — anyone
  who read `hazards_store.json` could otherwise impersonate a reporter — so only a
  keyed hash of it is stored, using a salt generated on first run and kept beside the
  store it protects.
"""

import hmac
import os
import re
import secrets
from hashlib import blake2s

from fastapi import HTTPException, Request

# Clients generate these; keep the accepted shape narrow so a malformed or hostile
# header cannot become a storage key.
_DEVICE_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

SALT_FILENAME = ".onebar_device_salt"


def _salt_path(neighbour_file: str | None) -> str:
    """Locate the salt file beside the store it protects.

    Deriving the path rather than configuring it separately means the test fixtures
    that redirect the hazard store into `tmp_path` automatically isolate the salt too,
    so a test run cannot leave one behind in the repository.
    """
    directory = os.path.dirname(os.path.abspath(neighbour_file)) if neighbour_file else os.getcwd()
    return os.path.join(directory, SALT_FILENAME)


class DeviceIdentity:
    """Turns a client-supplied device header into a stable, non-reversible owner key."""

    def __init__(self, salt_file: str | None = None, neighbour_file: str | None = None) -> None:
        self.salt_file = salt_file or os.getenv("ONEBAR_DEVICE_SALT_FILE") or _salt_path(neighbour_file)
        self._salt = self._load_or_create_salt()

    def _load_or_create_salt(self) -> bytes:
        env_salt = os.getenv("ONEBAR_DEVICE_SALT")
        if env_salt:
            return env_salt.encode("utf-8")
        try:
            if os.path.exists(self.salt_file):
                with open(self.salt_file, encoding="utf-8") as f:
                    existing = f.read().strip()
                if existing:
                    return existing.encode("utf-8")
            generated = secrets.token_hex(32)
            temp = f"{self.salt_file}.tmp"
            with open(temp, "w", encoding="utf-8") as f:
                f.write(generated)
            os.replace(temp, self.salt_file)
            return generated.encode("utf-8")
        except OSError:
            # A read-only deployment still needs ownership to work within the process.
            # Ownership then resets on restart, which is safe: reports become
            # unowned-by-anyone rather than owned-by-everyone.
            return secrets.token_bytes(32)

    def owner_key(self, raw_device_id: str) -> str:
        return blake2s(raw_device_id.encode("utf-8"), key=self._salt[:32], digest_size=16).hexdigest()


def raw_device_header(request: Request) -> str | None:
    """The `X-OneBar-Device` header, or None when it is absent or malformed."""
    value = request.headers.get("X-OneBar-Device", "").strip()
    return value if _DEVICE_RE.fullmatch(value) else None


def viewer_key(request: Request) -> str | None:
    """Owner key for read paths. None means "an anonymous caller", not "an error"."""
    raw = raw_device_header(request)
    if raw is None:
        return None
    return request.app.state.device_identity.owner_key(raw)


def require_device(request: Request) -> str:
    """Owner key for write paths, rejecting callers that did not identify themselves.

    Writes are attributed so that a report can later be edited, retired or attributed
    back to its reporter. An unattributable write to a shared emergency map is exactly
    the abuse vector this endpoint used to be.
    """
    key = viewer_key(request)
    if key is None:
        raise HTTPException(400, {
            "detail": (
                "This request needs an X-OneBar-Device header so the report can be "
                "attributed to your device. Update the app if you are seeing this."
            ),
            "missing_device_header": True,
        })
    return key


def is_admin(request: Request) -> bool:
    """True when the caller presented the operator token, if one is configured.

    Compared in constant time: `==` on a secret returns as soon as two bytes differ,
    which leaks the token one byte at a time to anyone who can measure the response.
    That token gates wiping the hazard map — live official alerts included — for every
    user of the deployment.
    """
    expected = os.getenv("ONEBAR_ADMIN_TOKEN")
    if not expected:
        return False
    return hmac.compare_digest(request.headers.get("X-OneBar-Admin", ""), expected)


def peer_source(request: Request) -> str:
    """A coarse network origin for the caller.

    Used to make abuse cost something a client cannot mint for free, unlike the device
    header. Truncated to a /24 (or a v6 /64) so it identifies a network rather than a
    person, and so it survives the address churn of a mobile carrier.
    """
    host = request.client.host if request.client else ""
    if not host:
        return "unknown"
    if ":" in host:
        return ":".join(host.split(":")[:4])
    parts = host.split(".")
    return ".".join(parts[:3]) if len(parts) == 4 else host
