import crypto from 'node:crypto';
import { accountCipher } from './repo.js';

export class WrongKeyError extends Error {}

const fingerprintOf = (key) => crypto.createHmac('sha256', key).update('openprofiles key check').digest('hex').slice(0, 24);

/**
 * Refuse to run with a secret key that doesn't match the data. Without this,
 * a lost or swapped secret.key shows up later as "can't read" errors on every
 * profile, and anything written meanwhile is encrypted with a key that the
 * rest of the data doesn't use. The fingerprint is stored on first boot; a
 * database from before fingerprints is checked by decrypting a stored key.
 */
export function checkSecretKey(db, key, cipher) {
  const fingerprint = fingerprintOf(key);
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'key_fingerprint'").get()?.value;
  if (stored) {
    if (stored !== fingerprint) throw new WrongKeyError(wrongKeyMessage());
    return;
  }
  const sample = db.prepare('SELECT id, auth_key_enc FROM accounts WHERE enc_version = 2 LIMIT 1').get();
  // Data from before accounts were bound into the encryption (enc_version 1) is checked the old way.
  const legacy = sample ? null : db.prepare('SELECT auth_key_enc FROM accounts WHERE enc_version = 1 LIMIT 1').get();
  try {
    if (sample) accountCipher(cipher, sample.id).decryptJson(sample.auth_key_enc, 'authkey');
    else if (legacy) cipher.decryptJson(legacy.auth_key_enc, 'authkey');
  } catch {
    throw new WrongKeyError(wrongKeyMessage());
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('key_fingerprint', ?)").run(fingerprint);
}

function wrongKeyMessage() {
  return 'The secret key does not match this database, so stored profiles and backups cannot be read. '
    + 'Restore the secret.key (or SECRET_KEY) that was used with this data. OpenProfiles will not start '
    + 'with a different key, so nothing gets written that the rest of the data could not be read with.';
}
