"""
The service worker shell.

A module that is imported by the app but absent from `SHELL` in `static/sw.js` is not
cached, so the app fails to boot with no connection — the one thing it exists to do. The
failure is invisible online, which is exactly when it would be introduced.
"""

import os
import re

REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
SW = os.path.join(REPO_ROOT, "static", "sw.js")
JS_DIR = os.path.join(REPO_ROOT, "static", "js")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def shell_entries():
    return set(re.findall(r"'(/[^']+)'", read(SW).split("];")[0]))


def test_every_frontend_module_is_precached():
    shell = shell_entries()
    modules = {f for f in os.listdir(JS_DIR) if f.endswith(".js")}
    missing = sorted(m for m in modules if f"/static/js/{m}" not in shell)
    assert not missing, f"not cached by the service worker: {', '.join(missing)}"


def test_the_shell_lists_nothing_that_does_not_exist():
    """A 404 in the pre-cache list makes `cache.addAll` reject and caches nothing."""
    for entry in shell_entries():
        if entry in ("/", "/manifest.webmanifest"):
            continue        # served by routes, not from disk at this path
        path = os.path.join(REPO_ROOT, entry.lstrip("/"))
        assert os.path.exists(path), f"SHELL lists a missing file: {entry}"


def test_leaflet_is_vendored_not_hot_linked():
    """An offline-first app that needs a CDN to boot is a contradiction."""
    sw = read(SW)
    html = read(os.path.join(REPO_ROOT, "static", "index.html"))
    assert "unpkg.com" not in sw and "unpkg.com" not in html
    assert "/static/vendor/leaflet/leaflet.js" in sw
