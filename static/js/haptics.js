// Tactile Haptic Vibration Feedback for Native Android, iOS Taptic Engine, and Mobile Web

const hasCapacitorHaptics = () => Boolean(window.Capacitor?.Plugins?.Haptics);
const canVibrate = typeof navigator !== 'undefined' && 'vibrate' in navigator;

export const haptics = {
  // Quick subtle tap for button clicks
  async tap() {
    if (hasCapacitorHaptics()) {
      try {
        await window.Capacitor.Plugins.Haptics.impact({ style: 'LIGHT' });
        return;
      } catch { /* fallback */ }
    }
    if (canVibrate) {
      try { navigator.vibrate(25); } catch { /* ignore */ }
    }
  },

  // Double pulse for successful actions (route computed, hazard added)
  async success() {
    if (hasCapacitorHaptics()) {
      try {
        await window.Capacitor.Plugins.Haptics.notification({ type: 'SUCCESS' });
        return;
      } catch { /* fallback */ }
    }
    if (canVibrate) {
      try { navigator.vibrate([35, 45, 35]); } catch { /* ignore */ }
    }
  },

  // Warning pulse for fallbacks, weak signals, or hazard proximity
  async warning() {
    if (hasCapacitorHaptics()) {
      try {
        await window.Capacitor.Plugins.Haptics.notification({ type: 'WARNING' });
        return;
      } catch { /* fallback */ }
    }
    if (canVibrate) {
      try { navigator.vibrate([60, 40, 60, 40, 60]); } catch { /* ignore */ }
    }
  },

  // Heavy double buzz for blocked routes or critical errors
  async error() {
    if (hasCapacitorHaptics()) {
      try {
        await window.Capacitor.Plugins.Haptics.notification({ type: 'ERROR' });
        return;
      } catch { /* fallback */ }
    }
    if (canVibrate) {
      try { navigator.vibrate([120, 60, 120]); } catch { /* ignore */ }
    }
  },

  // SOS Morse Code pattern (. . . - - - . . .)
  async sos() {
    if (hasCapacitorHaptics()) {
      try {
        await window.Capacitor.Plugins.Haptics.vibrate({ duration: 500 });
        return;
      } catch { /* fallback */ }
    }
    if (canVibrate) {
      try {
        navigator.vibrate([
          80, 50, 80, 50, 80, 120,    // S: . . .
          180, 50, 180, 50, 180, 120, // O: - - -
          80, 50, 80, 50, 80          // S: . . .
        ]);
      } catch { /* ignore */ }
    }
  },
};
