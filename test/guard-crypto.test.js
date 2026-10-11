import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Cipher, DecryptError, loadOrCreateKey } from '../src/crypto.js';
import { GuardError, decodeSnapshot } from '../src/core/guard.js';
import { addon, libItem } from './helpers/fakeStremio.js';

const cipher = new Cipher(crypto.randomBytes(32));

function row({ library = [libItem('a')], addons = [addon('cinemeta')], notifs = [], libraryCount } = {}) {
  return {
    library_enc: cipher.encryptJson(library, 'library'),
    addons_enc: cipher.encryptJson(addons, 'addons'),
    notifs_enc: notifs === null ? null : cipher.encryptJson(notifs, 'notifs'),
    library_count: libraryCount ?? (Array.isArray(library) ? library.filter((i) => !i.removed).length : 0),
  };
}

const refuses = (r, code) => assert.throws(() => decodeSnapshot(cipher, r, 'Kids'), (e) => e instanceof GuardError && e.code === code);

describe('Cipher', () => {
  it('round-trips JSON and binds the purpose', () => {
    const blob = cipher.encryptJson({ hello: ['world'] }, 'library');
    assert.deepEqual(cipher.decryptJson(blob, 'library'), { hello: ['world'] });
    assert.throws(() => cipher.decryptJson(blob, 'addons'), DecryptError);
  });

  it('detects tampering and wrong keys', () => {
    const blob = cipher.encryptJson([1, 2, 3], 'library');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => cipher.decryptJson(tampered, 'library'), DecryptError);
    assert.throws(() => new Cipher(crypto.randomBytes(32)).decryptJson(blob, 'library'), DecryptError);
  });

  it('generates a key file once and reuses it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-key-'));
    const k1 = loadOrCreateKey({ dataDir: dir });
    const k2 = loadOrCreateKey({ dataDir: dir });
    assert.equal(k1.length, 32);
    assert.deepEqual(k1, k2);
    assert.deepEqual(loadOrCreateKey({ secretKey: 'ab'.repeat(32), dataDir: dir }), Buffer.from('ab'.repeat(32), 'hex'));
    assert.throws(() => loadOrCreateKey({ secretKey: 'short', dataDir: dir }));
  });
});

describe('decodeSnapshot (target guard)', () => {
  it('accepts a healthy snapshot', () => {
    const out = decodeSnapshot(cipher, row(), 'Kids');
    assert.equal(out.library.length, 1);
    assert.equal(out.addons.length, 1);
    assert.deepEqual(out.notifs, []);
  });

  it('accepts an empty library when the count says empty, and null notifications', () => {
    const out = decodeSnapshot(cipher, row({ library: [], notifs: null }), 'Kids');
    assert.deepEqual(out.library, []);
    assert.equal(out.notifs, null);
  });

  it('refuses a blob it cannot decrypt', () => {
    refuses({ ...row(), library_enc: Buffer.from('garbage') }, 'UNREADABLE');
  });

  it('refuses a non-array library', () => {
    refuses(row({ library: { not: 'an array' }, libraryCount: 0 }), 'MALFORMED');
  });

  it('refuses when the count says items but none decoded', () => {
    refuses(row({ library: [], libraryCount: 12 }), 'EMPTY_MISMATCH');
    refuses(row({ library: [{ ...libItem('a'), removed: true }], libraryCount: 3 }), 'EMPTY_MISMATCH');
  });

  it('refuses an empty add-on list (writing [] uninstalls everything)', () => {
    refuses(row({ addons: [] }), 'NO_ADDONS');
  });

  it('enforces caps by throwing, never truncating', () => {
    refuses(row({ library: Array.from({ length: 10001 }, (_, i) => libItem(`tt${i}`)) }), 'TOO_LARGE');
    refuses(row({ addons: Array.from({ length: 51 }, (_, i) => addon(`a${i}`)) }), 'TOO_LARGE');
  });

  it('refuses malformed add-ons', () => {
    refuses(row({ addons: [{ transportUrl: 'x' }] }), 'MALFORMED');
  });
});
