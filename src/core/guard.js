import { DecryptError } from '../crypto.js';
import { countActive, hasId } from './library.js';

export const MAX_LIBRARY_ITEMS = 10000;
export const MAX_ADDONS = 50;

/** A refusal that happens before anything is written to Stremio. */
export class GuardError extends Error {
  constructor(code, userMessage) {
    super(userMessage);
    this.code = code;
    this.userMessage = userMessage;
  }
}

function decrypt(cipher, blob, purpose, label) {
  try {
    return cipher.decryptJson(blob, purpose);
  } catch (err) {
    if (err instanceof DecryptError) {
      throw new GuardError('UNREADABLE', `${label}'s saved ${purpose} can't be read (wrong secret key or a damaged database). Nothing was changed.`);
    }
    throw err;
  }
}

export function checkLibrary(library, label) {
  if (!Array.isArray(library) || !library.every(hasId)) {
    throw new GuardError('MALFORMED', `${label}'s saved library is damaged. Nothing was changed.`);
  }
  if (library.length > MAX_LIBRARY_ITEMS) {
    throw new GuardError('TOO_LARGE', `${label}'s library has ${library.length} items; the limit is ${MAX_LIBRARY_ITEMS}. Nothing was changed.`);
  }
}

export function checkAddons(addons, label) {
  if (!Array.isArray(addons)) {
    throw new GuardError('MALFORMED', `${label}'s saved add-on list is damaged. Nothing was changed.`);
  }
  // Writing [] uninstalls Cinemeta and everything else.
  if (addons.length === 0) {
    throw new GuardError('NO_ADDONS', `${label} has no add-ons saved. Switching would uninstall everything, so it was refused.`);
  }
  if (addons.length > MAX_ADDONS) {
    throw new GuardError('TOO_LARGE', `${label} has ${addons.length} add-ons; the limit is ${MAX_ADDONS}. Nothing was changed.`);
  }
  const ok = addons.every((a) => a && typeof a === 'object' && typeof a.transportUrl === 'string' && a.manifest && typeof a.manifest === 'object');
  if (!ok) throw new GuardError('MALFORMED', `${label}'s saved add-on list is damaged. Nothing was changed.`);
}

export function checkNotifs(notifs, label) {
  if (notifs !== null && (!Array.isArray(notifs) || !notifs.every(hasId))) {
    throw new GuardError('MALFORMED', `${label}'s saved notifications are damaged. Nothing was changed.`);
  }
}

/**
 * Decode and validate a stored snapshot (a profile or backup row) BEFORE any
 * write. Throws instead of truncating or substituting.
 */
export function decodeSnapshot(cipher, row, label) {
  const library = decrypt(cipher, row.library_enc, 'library', label);
  checkLibrary(library, label);
  if (row.library_count > 0 && countActive(library) === 0) {
    throw new GuardError('EMPTY_MISMATCH', `${label} should have ${row.library_count} library items but none could be read. Nothing was changed.`);
  }
  const addons = decrypt(cipher, row.addons_enc, 'addons', label);
  checkAddons(addons, label);
  const notifs = row.notifs_enc == null ? null : decrypt(cipher, row.notifs_enc, 'notifs', label);
  checkNotifs(notifs, label);
  return { library, addons, notifs };
}
