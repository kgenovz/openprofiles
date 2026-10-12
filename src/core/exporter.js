import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { GuardError } from './guard.js';

const scrypt = promisify(crypto.scrypt);

/**
 * "Download everything": one file holding every profile and backup of an
 * account, and its reverse. The file can be sealed with a passphrase
 * (scrypt → AES-256-GCM), because it contains add-on links with debrid keys
 * and the whole watch history.
 */

export const EXPORT_FORMAT = 'openprofiles-export';
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase).normalize('NFKC'), salt, 32, SCRYPT);
}

/** Wrap `payload` (an object) in the export envelope, encrypted when a passphrase is given. */
export function sealExport(payload, passphrase) {
  if (!passphrase) return { format: EXPORT_FORMAT, version: 1, encrypted: false, ...payload };
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  c.setAAD(Buffer.from(EXPORT_FORMAT));
  const data = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return {
    format: EXPORT_FORMAT,
    version: 1,
    encrypted: true,
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/** Unwrap an export file. Rejects with GuardError for anything that isn't a readable export. */
export async function openExport(file, passphrase) {
  if (!file || typeof file !== 'object' || file.format !== EXPORT_FORMAT) {
    throw new GuardError('NOT_AN_EXPORT', "That file isn't an OpenProfiles export.");
  }
  if (file.version !== 1) throw new GuardError('UNSUPPORTED', `This export is version ${file.version}; this server reads version 1.`);
  if (!file.encrypted) return file;
  if (!passphrase) throw new GuardError('PASSPHRASE_NEEDED', 'This export is protected. Enter its passphrase.');
  // The cost settings come from the file, so only the ones this server writes are
  // accepted: anything else could keep the server busy for hours.
  const { kdf } = file;
  if (kdf?.name !== 'scrypt' || kdf.N !== SCRYPT.N || kdf.r !== SCRYPT.r || kdf.p !== SCRYPT.p || typeof kdf.salt !== 'string') {
    throw new GuardError('NOT_AN_EXPORT', "This export's protection isn't one OpenProfiles makes, so it can't be opened here.");
  }
  try {
    // Async, so a long derivation doesn't hold up everyone else's requests.
    const key = await scrypt(String(passphrase).normalize('NFKC'), Buffer.from(kdf.salt, 'base64'), 32, SCRYPT);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
    d.setAAD(Buffer.from(EXPORT_FORMAT));
    d.setAuthTag(Buffer.from(file.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(file.data, 'base64')), d.final()]);
    return { format: EXPORT_FORMAT, version: 1, ...JSON.parse(plain.toString('utf8')) };
  } catch {
    throw new GuardError('WRONG_PASSPHRASE', "That passphrase doesn't open this export.");
  }
}
