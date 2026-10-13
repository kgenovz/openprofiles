import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// Wrong codes in a row an account may enter (on any page) before codes are refused for a while.
export const MAX_WRONG_CODES = 5;
export const WRONG_CODE_WAIT_MS = 15 * 60 * 1000;

const KEY_BYTES = 32;
const SALT_BYTES = 16;
// Stored as "s1$<salt>$<hash>" (base64url). The "s1" names these scrypt settings.
const SCRYPT = { N: 16384, r: 8, p: 1 };
const STORED = /^s1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;

/** Exactly four digits. */
export const isPasscode = (code) => typeof code === 'string' && /^[0-9]{4}$/.test(code);

/** Whether a stored value (or one in an import file) is a hash this build can check. */
export const isPasscodeHash = (value) => typeof value === 'string' && STORED.test(value);

/** A salted hash of the code. The code itself is never kept. */
export async function hashPasscode(code) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(code, salt, KEY_BYTES, SCRYPT);
  return `s1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** False for a wrong code, and for a stored value that can't be read. */
export async function checkPasscode(code, stored) {
  if (!isPasscode(code) || !isPasscodeHash(stored)) return false;
  const [, salt, hash] = stored.split('$');
  const key = await scrypt(code, Buffer.from(salt, 'base64url'), KEY_BYTES, SCRYPT);
  return crypto.timingSafeEqual(key, Buffer.from(hash, 'base64url'));
}
