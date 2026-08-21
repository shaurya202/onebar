// Opaque per-device identity.
//
// OneBar has no accounts and asks for no personal data, but the hazard map is shared:
// without an identifier there is no way to let a person delete a report they made
// without also letting them delete everybody else's. This is that identifier — a
// random value generated once on this device, sent as `X-OneBar-Device`, and tied to
// nothing else. It is not a login, it identifies no person, and it is never displayed.

const KEY = 'onebar_device_id_v1';

let cached = null;

function generate() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function deviceId() {
  if (cached) return cached;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) {
      cached = stored;
      return cached;
    }
    cached = generate();
    localStorage.setItem(KEY, cached);
  } catch {
    // Private browsing, or storage denied. The app still works and reports still
    // upload; they just stop being manageable after a restart, because the server has
    // no way to recognise this device again. That is the honest trade — the
    // alternative is either no reports at all or reports nobody can retract.
    cached = cached || generate();
  }
  return cached;
}

/** Forget this device's identity. Its existing reports become unmanageable. */
export function resetDeviceId() {
  cached = null;
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
