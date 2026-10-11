import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

export class DecryptError extends Error {}

function decodeKey(text, source) {
  const trimmed = text.trim();
  const buf = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (buf.length !== 32) {
    throw new Error(`${source} must be 32 bytes (64 hex characters or 44 base64 characters)`);
  }
  return buf;
}

/**
 * The 32-byte data key: SECRET_KEY if set, else `<dataDir>/secret.key`,
 * generated on first boot. Losing it makes every stored snapshot unreadable,
 * so it lives on the same volume as the database.
 */
export function loadOrCreateKey({ secretKey, dataDir }) {
  if (secretKey) return decodeKey(secretKey, 'SECRET_KEY');
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) return decodeKey(fs.readFileSync(file, 'utf8'), file);
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  return key;
}

/**
 * AES-256-GCM over deflated JSON. Layout: [version][iv][tag][ciphertext].
 * `purpose` is bound as associated data so a blob can't be decrypted as a
 * different kind of value (an add-on list as a library, etc.).
 */
export class Cipher {
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Cipher key must be 32 bytes');
    this.key = key;
  }

  encryptJson(value, purpose) {
    const plain = zlib.deflateRawSync(Buffer.from(JSON.stringify(value), 'utf8'));
    const iv = crypto.randomBytes(IV_BYTES);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(`openprofiles:${purpose}`));
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, c.getAuthTag(), body]);
  }

  decryptJson(blob, purpose) {
    const buf = Buffer.isBuffer(blob) ? blob : blob ? Buffer.from(blob) : null;
    if (!buf || buf.length < HEADER_BYTES || buf[0] !== FORMAT_VERSION) {
      throw new DecryptError('Not an OpenProfiles encrypted value');
    }
    try {
      const iv = buf.subarray(1, 1 + IV_BYTES);
      const tag = buf.subarray(1 + IV_BYTES, HEADER_BYTES);
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      d.setAAD(Buffer.from(`openprofiles:${purpose}`));
      d.setAuthTag(tag);
      const plain = Buffer.concat([d.update(buf.subarray(HEADER_BYTES)), d.final()]);
      return JSON.parse(zlib.inflateRawSync(plain).toString('utf8'));
    } catch {
      throw new DecryptError('Encrypted value is corrupt or was written with a different key');
    }
  }
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest();
}

/** Constant-time string comparison (hashes first so lengths can differ). */
export function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));
}
