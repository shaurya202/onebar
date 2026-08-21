// Emergency contacts.
//
// The SOS screen composed a careful message — position, accuracy, hazard count, ETA,
// map links — and then opened the SMS composer with a **blank recipient**, so the last
// thing it asked of someone in an emergency was to scroll a contact list one-handed
// and pick a name. Contacts are captured once, during onboarding, and pre-filled from
// then on.
//
// They never leave the device: OneBar has no server-side account to attach them to,
// and does not send them anywhere. The SMS is composed by the phone's own messaging
// app, which is also why it still works with no data connection.

const KEY = 'onebar_contacts_v1';
export const MAX_CONTACTS = 3;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((c) => c && c.phone) : [];
  } catch {
    return [];
  }
}

function write(contacts) {
  try {
    localStorage.setItem(KEY, JSON.stringify(contacts.slice(0, MAX_CONTACTS)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the characters a dialler understands and drop the rest.
 * Spaces, brackets and dashes are how people write numbers and are meaningless to
 * `sms:`; `+`, digits and `#`/`*` are not.
 */
export function normalisePhone(raw) {
  const cleaned = String(raw || '').replace(/[^\d+#*]/g, '');
  if (!cleaned) return '';
  // A leading + is only meaningful in first position.
  return cleaned[0] === '+' ? `+${cleaned.slice(1).replace(/\+/g, '')}` : cleaned.replace(/\+/g, '');
}

export function listContacts() {
  return read();
}

export function saveContacts(contacts) {
  const cleaned = [];
  for (const contact of contacts) {
    const phone = normalisePhone(contact.phone);
    if (!phone || phone.length < 3) continue;
    cleaned.push({
      id: contact.id || `c-${cleaned.length}-${phone.slice(-4)}`,
      name: String(contact.name || '').trim().slice(0, 40) || phone,
      phone,
    });
    if (cleaned.length >= MAX_CONTACTS) break;
  }
  write(cleaned);
  return cleaned;
}

export function hasContacts() {
  return read().length > 0;
}

/**
 * Build the `sms:` URL for a set of recipients.
 *
 * The two platforms disagree on the separator between the address list and the body —
 * iOS wants `&`, everyone else wants `?` — and getting it wrong silently drops the
 * message text, leaving the user to type it out during an emergency.
 */
export function smsHref(numbers, body) {
  const recipients = (numbers || []).map(normalisePhone).filter(Boolean).join(',');
  const encoded = encodeURIComponent(body || '');
  // `globalThis` rather than `window`: this module is also exercised outside a
  // browser by tools/client_tests.mjs, and `window.MSStream` would throw there.
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !globalThis.MSStream;
  const separator = isIOS ? '&' : '?';
  return `sms:${recipients}${encoded ? `${separator}body=${encoded}` : ''}`;
}
