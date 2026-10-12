import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { Cipher } from '../src/crypto.js';
import { migrate } from '../src/db.js';
import { openExport } from '../src/core/exporter.js';
import { WrongKeyError, checkSecretKey } from '../src/core/keycheck.js';
import { runDaily, snapshotDatabase } from '../src/core/scheduler.js';
import { MAX_PROFILES } from '../src/core/service.js';
import { libItem } from './helpers/fakeStremio.js';
import { linkedWithKids } from './helpers/setup.js';

const DAY = 24 * 60 * 60 * 1000;

describe('the bin', () => {
  it('a deleted profile goes to the bin and can be brought back', async () => {
    const { service, repo, kids } = await linkedWithKids();
    await service.deleteProfile(kids.id);
    assert.equal(repo.getProfile(kids.id), null, 'gone from the profile list');
    assert.deepEqual(service.listBin().map((p) => p.name), ['Kids']);
    const back = await service.restoreFromBin(kids.id);
    assert.equal(back.name, 'Kids');
    assert.equal(service.listBin().length, 0);
    assert.match(repo.listActivity()[0].detail, /back from the bin/);
  });

  it('a name reused meanwhile comes back as "(restored)"', async () => {
    const { service, kids } = await linkedWithKids();
    await service.deleteProfile(kids.id);
    await service.createProfile({ name: 'Kids', from: 'empty' });
    assert.equal((await service.restoreFromBin(kids.id)).name, 'Kids (restored)');
  });

  it('is emptied of profiles deleted more than 30 days ago', async () => {
    const { db, service, repo, kids } = await linkedWithKids();
    await service.deleteProfile(kids.id);
    db.prepare('UPDATE profiles SET deleted_at = ? WHERE id = ?').run(Date.now() - 31 * DAY, kids.id);
    assert.equal(repo.purgeBin(Date.now() - 30 * DAY), 1);
    assert.equal(service.listBin().length, 0);
  });

  it(`an account holds at most ${MAX_PROFILES} profiles`, async () => {
    const { service } = await linkedWithKids();
    for (let i = 2; i < MAX_PROFILES; i++) await service.createProfile({ name: `P${i}`, from: 'empty' });
    await assert.rejects(service.createProfile({ name: 'One too many', from: 'empty' }), (e) => e.code === 'TOO_MANY');
  });
});

describe('automatic backups', () => {
  it('backs up daily, but only when something changed', async () => {
    const { service, repo, fake } = await linkedWithKids();
    assert.equal((await service.autoBackup()).done, true);
    assert.deepEqual(await service.autoBackup(), { done: false, reason: 'unchanged' });
    fake.seed({ library: [libItem('tt-new')] });
    assert.equal((await service.autoBackup()).done, true);
    assert.equal(repo.listBackups().filter((b) => b.kind === 'auto').length, 2);
  });

  it('skips an account Stremio has signed out, without failing', async () => {
    const { service, fake } = await linkedWithKids();
    fake.authKey = 'z'.repeat(40);
    assert.deepEqual(await service.autoBackup(), { done: false, reason: 'signed out of Stremio' });
  });
});

describe('undoing an edit', () => {
  it("restoring an edit's backup of a profile not in use puts only that profile back, without touching Stremio", async () => {
    const { service, repo, fake, kids } = await linkedWithKids();
    const before = repo.getProfile(kids.id);
    const backupId = service.backupProfileBeforeChange(kids.id, 'Before editing Kids add-ons');
    repo.saveProfileSnapshot(kids.id, { library: [libItem('tt-edited')], addons: [{ transportUrl: 'x', manifest: {} }], notifs: [] });
    const calls = fake.calls.length;
    const result = await service.restoreBackup(backupId);
    assert.equal(result.profileOnly, true);
    assert.equal(fake.calls.length, calls, 'no Stremio calls');
    const after = repo.getProfile(kids.id);
    assert.equal(after.library_count, before.library_count);
    assert.equal(after.addon_count, before.addon_count);
    assert.ok(repo.listBackups().some((b) => b.kind === 'pre_change' && /undoing/.test(b.label)), 'the undo itself can be undone');
  });
});

describe('download everything', () => {
  it('round-trips every profile and backup into a fresh account, with and without a passphrase', async () => {
    const first = await linkedWithKids();
    await first.service.createBackup('Holidays');
    for (const passphrase of [null, 'correct horse battery']) {
      const file = JSON.parse(JSON.stringify(first.service.exportEverything(passphrase)));
      assert.equal(file.encrypted, Boolean(passphrase));
      if (passphrase) assert.ok(!JSON.stringify(file).includes('SECRETKEY'), 'sealed: add-on links are not readable');

      const second = await linkedWithKids();
      const result = await second.service.importEverything(file, { passphrase });
      assert.equal(result.profiles, 2);
      assert.equal(result.backups, first.repo.listBackups().length);
      const names = second.repo.listProfiles().map((p) => p.name).sort();
      assert.deepEqual(names, ['Kids', 'Kids (imported)', 'Original', 'Original (imported)']);
    }
  });

  it('refuses a wrong passphrase, and a file from another account unless confirmed', async () => {
    const a = await linkedWithKids();
    const sealed = JSON.parse(JSON.stringify(a.service.exportEverything('right passphrase')));
    await assert.rejects(openExport(sealed, 'wrong passphrase'), (e) => e.code === 'WRONG_PASSPHRASE');
    await assert.rejects(openExport(sealed, null), (e) => e.code === 'PASSPHRASE_NEEDED');
    // A file can't pick its own (expensive) key-derivation settings.
    const costly = { ...sealed, kdf: { ...sealed.kdf, p: 100000 } };
    await assert.rejects(openExport(costly, 'right passphrase'), (e) => e.code === 'NOT_AN_EXPORT');

    const plain = JSON.parse(JSON.stringify(a.service.exportEverything(null)));
    plain.stremio_user_id = 'someone-else';
    const b = await linkedWithKids();
    await assert.rejects(b.service.importEverything(plain), (e) => e.code === 'OTHER_ACCOUNT');
    const ok = await b.service.importEverything(plain, { acceptOtherAccount: true });
    assert.equal(ok.profiles, 2);
  });
});

describe('the secret key check', () => {
  function freshDb() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    return db;
  }

  it('remembers the key, and refuses a different one', () => {
    const db = freshDb();
    const key = crypto.randomBytes(32);
    checkSecretKey(db, key, new Cipher(key));
    checkSecretKey(db, key, new Cipher(key)); // same key: fine
    const other = crypto.randomBytes(32);
    assert.throws(() => checkSecretKey(db, other, new Cipher(other)), WrongKeyError);
  });

  it('catches a wrong key on a database from before fingerprints by trying to read it', async () => {
    const { db } = await linkedWithKids();
    db.prepare("DELETE FROM meta WHERE key = 'key_fingerprint'").run();
    const wrong = crypto.randomBytes(32);
    assert.throws(() => checkSecretKey(db, wrong, new Cipher(wrong)), WrongKeyError);
  });
});

describe('daily jobs', () => {
  it('keeps 7 daily snapshots plus Sundays of the last 4 weeks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-snap-'));
    const snaps = path.join(dir, 'snapshots');
    fs.mkdirSync(snaps);
    const today = Date.parse('2026-10-11T12:00:00Z'); // a Sunday
    for (let d = 1; d <= 40; d++) fs.writeFileSync(path.join(snaps, `openprofiles-${new Date(today - d * DAY).toISOString().slice(0, 10)}.db`), '');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (x)');
    snapshotDatabase(db, dir, today);
    const kept = fs.readdirSync(snaps).sort();
    assert.ok(kept.includes('openprofiles-2026-10-11.db'), "today's snapshot made");
    assert.ok(kept.includes('openprofiles-2026-10-05.db'), '6 days old: kept');
    assert.ok(!kept.includes('openprofiles-2026-10-03.db'), '8 days old, a Saturday: removed');
    assert.ok(kept.includes('openprofiles-2026-09-20.db'), 'a Sunday 3 weeks back: kept');
    assert.ok(!kept.includes('openprofiles-2026-09-06.db'), 'a Sunday 5 weeks back: removed');
    assert.equal(kept.length, 7 + 3);
  });

  it('backs up every account, empties old bins and records the run', async () => {
    const { db, accounts, service, kids } = await linkedWithKids();
    await service.deleteProfile(kids.id);
    db.prepare('UPDATE profiles SET deleted_at = ? WHERE id = ?').run(Date.now() - 31 * DAY, kids.id);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-daily-'));
    const summary = await runDaily({ db, dataDir: dir, accounts, pause: async () => {} });
    assert.equal(summary.backedUp, 1);
    assert.equal(summary.purged, 1);
    assert.ok(summary.snapshot && fs.existsSync(summary.snapshot));
    assert.ok(db.prepare("SELECT value FROM meta WHERE key = 'last_daily'").get());
  });
});

describe('activity log', () => {
  it('records switches and other changes, newest first', async () => {
    const { service, repo, kids } = await linkedWithKids();
    await service.switchTo(kids.id);
    const [latest] = repo.listActivity();
    assert.match(latest.detail, /Switched from "Original" to "Kids"/);
    assert.ok(repo.listActivity().some((a) => /Created "Kids"/.test(a.detail)));
  });
});
