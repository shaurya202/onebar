// Build-time configuration for packaged native builds.
//
// `window.ONEBAR_API_BASE` was referenced by api.js but never defined anywhere in the
// repo, so a device build had no backend URL at all and every request went to the
// Capacitor origin. Set it here (or inject it during CI) before shipping.
//
// Leave empty for the web PWA, where the API is served from the same origin.
window.ONEBAR_API_BASE = window.ONEBAR_API_BASE || '';
