import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { Cipher } from '../src/crypto.js';
import { migrate } from '../src/db.js';
import { AccountsService, accessDecision } from '../src/core/accounts.js';
import { decodeSnapshot } from '../src/core/guard.js';
import { upgradeLegacyEncryption } from '../src/core/rekey.js';
import { NATIVE_PROFILES_WARNING } from '../src/core/service.js';
import { StremioClient } from '../src/stremio/client.js';
import { FakeStremio, addon, libItem } from './helpers/fakeStremio.js';
import { makeService, noSleep, seededFake } from './helpers/setup.js';

/** Several fake Stremio accounts behind one fetch, routed by email (login) or auth key. */
function fakeFleet(...fakes) {
  return {
    fakes,
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      const target = body.email
        ? fakes.find((f) => f.user.email === body.email) ?? fakes[0]
        : fakes.find((f) => f.authKey === body.authKey) ?? fakes[0];
      return target.fetch(url, init);
    },
  };
}

function person(n) {
  return new FakeStremio({ userId: `user-${n}`, email: `person${n}@example.com`, authKey: `${n}`.repeat(40) })
    .seed({ library: [libItem(`tt-${n}`)], addons: [addon('cinemeta'), addon(`extra-${n}`)] });
}

function server(fleet, access) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  const cipher = new Cipher(crypto.randomBytes(32));
  const stremio = new StremioClient({ fetchImpl: fleet.fetch, sleep: noSleep });
  return { db, cipher, accounts: new AccountsService({ db, cipher, stremio, sleep: noSleep, access }) };
}

const signIn = (accounts, fake) => accounts.signIn(fake.user.email, fake.password);

describe('signing in with Stremio', () => {
  it('the first sign-in creates the account: "Original" from the live state plus the permanent backup', async () => {
    const ctx = makeService({ fake: seededFake() });
    const { created } = await ctx.signIn();
    assert.equal(created, true);
    const [original] = ctx.repo.listProfiles();
    assert.equal(original.name, 'Original');
    assert.equal(original.library_count, 2);
    assert.equal(original.addon_count, 2);
    assert.equal(original.notif_count, 1);
    assert.equal(ctx.repo.getState().active_profile_id, original.id);
    assert.deepEqual(ctx.repo.listBackups().map((b) => b.kind), ['original']);
    assert.equal(ctx.fake.callCount('datastorePut'), 0, 'setup never writes to Stremio');
    assert.equal(ctx.fake.callCount('addonCollectionSet'), 0);
  });

  it('signing in again renews the stored key and keeps everything', async () => {
    const ctx = makeService({ fake: seededFake() });
    const first = await ctx.signIn();
    ctx.fake.authKey = 'n'.repeat(40);
    const again = await ctx.signIn();
    assert.equal(again.created, false);
    assert.equal(again.accountId, first.accountId);
    assert.equal(ctx.repo.getAuthKey(), 'n'.repeat(40));
    assert.equal(ctx.repo.listProfiles().length, 1);
  });

  it('refuses a child-profile key and warns about native profiles', async () => {
    const child = makeService({ fake: seededFake() });
    child.fake.user.parent_id = 'master';
    await assert.rejects(child.signIn(), (e) => e.code === 'CHILD_PROFILE');

    const supporter = makeService({ fake: seededFake() });
    supporter.fake.user.premiumPrefs = { userProfiles: { 'user-1': { name: 'Me' }, p2: { name: 'Kid' } } };
    const { warnings } = await supporter.signIn();
    assert.deepEqual(warnings, [NATIVE_PROFILES_WARNING]);
  });

  it('a wrong password is an auth error and creates nothing', async () => {
    const ctx = makeService({ fake: seededFake() });
    await assert.rejects(ctx.signIn(ctx.fake.user.email, 'wrong'), (e) => e.kind === 'auth');
    assert.equal(ctx.accounts.accounts.count(), 0);
  });
});

describe('access rules', () => {
  const user = { id: 'u1', email: 'Me@Example.com' };

  it('owner: the first account claims the server, then only it may sign in', () => {
    assert.equal(accessDecision({ mode: 'owner' }, { user, existing: null, accountCount: 0 }), null);
    assert.match(accessDecision({ mode: 'owner' }, { user, existing: null, accountCount: 1 }), /belongs to someone/);
    assert.equal(accessDecision({ mode: 'owner' }, { user, existing: { id: 1 }, accountCount: 1 }), null);
  });

  it('list: only listed emails (any case) or user ids, even for existing accounts', () => {
    const rule = { mode: 'list', allowed: ['me@example.com'] };
    assert.equal(accessDecision(rule, { user, existing: null, accountCount: 3 }), null);
    assert.equal(accessDecision({ mode: 'list', allowed: ['u1'] }, { user, existing: null, accountCount: 0 }), null);
    assert.match(accessDecision({ mode: 'list', allowed: ['other@example.com'] }, { user, existing: { id: 1 }, accountCount: 1 }), /list/);
  });

  it('open: anyone, until the server is full', () => {
    assert.equal(accessDecision({ mode: 'open', maxAccounts: 2 }, { user, existing: null, accountCount: 1 }), null);
    assert.match(accessDecision({ mode: 'open', maxAccounts: 2 }, { user, existing: null, accountCount: 2 }), /full/);
    assert.equal(accessDecision({ mode: 'open', maxAccounts: 2 }, { user, existing: { id: 1 }, accountCount: 2 }), null);
  });

  it('an owner server refuses a second Stremio account', async () => {
    const fleet = fakeFleet(person(1), person(2));
    const { accounts } = server(fleet, { mode: 'owner' });
    await signIn(accounts, fleet.fakes[0]);
    await assert.rejects(signIn(accounts, fleet.fakes[1]), (e) => e.code === 'NOT_ALLOWED');
    assert.equal(accounts.accounts.count(), 1);
  });
});

describe('many accounts on one server', () => {
  it('each account only sees and switches its own profiles', async () => {
    const fleet = fakeFleet(person(1), person(2));
    const { accounts } = server(fleet, { mode: 'open' });
    const a = await signIn(accounts, fleet.fakes[0]);
    const b = await signIn(accounts, fleet.fakes[1]);
    assert.notEqual(a.accountId, b.accountId);
    const svcA = accounts.forAccount(a.accountId);
    const svcB = accounts.forAccount(b.accountId);

    const kidsA = await svcA.createProfile({ name: 'Kids', from: 'empty' });
    await svcB.createProfile({ name: 'Kids', from: 'empty' }); // same name, other account: fine
    assert.equal(svcA.repo.listProfiles().length, 2);
    assert.equal(svcB.repo.listProfiles().length, 2);

    const bOriginal = svcB.repo.listProfiles().find((p) => p.name === 'Original');
    assert.equal(svcA.repo.getProfile(bOriginal.id), null, "A can't read B's profile by id");
    await assert.rejects(svcA.switchTo(bOriginal.id), (e) => e.code === 'NOT_FOUND');
    assert.equal(svcA.repo.getBackup(svcB.repo.listBackups()[0].id), null, "A can't read B's backup by id");

    await svcA.switchTo(kidsA.id);
    assert.deepEqual(fleet.fakes[0].activeIds(), [], "A's Stremio account switched");
    assert.deepEqual(fleet.fakes[1].activeIds(), ['tt-2'], "B's Stremio account untouched");
  });

  it('blobs are bound to their account: copied into another account they refuse to decrypt', async () => {
    const fleet = fakeFleet(person(1), person(2));
    const { db, accounts } = server(fleet, { mode: 'open' });
    const a = await signIn(accounts, fleet.fakes[0]);
    const b = await signIn(accounts, fleet.fakes[1]);
    const svcB = accounts.forAccount(b.accountId);
    const rowA = accounts.forAccount(a.accountId).repo.getProfileRow(accounts.forAccount(a.accountId).repo.listProfiles()[0].id);
    const bOriginal = svcB.repo.listProfiles()[0];
    db.prepare('UPDATE profiles SET library_enc = ? WHERE id = ?').run(rowA.library_enc, bOriginal.id);
    assert.throws(() => decodeSnapshot(svcB.repo.cipher, svcB.repo.getProfileRow(bOriginal.id), 'Original'), (e) => e.code === 'UNREADABLE');
  });

  it('add-on tokens map to their own account', async () => {
    const fleet = fakeFleet(person(1), person(2));
    const { accounts } = server(fleet, { mode: 'open' });
    const a = await signIn(accounts, fleet.fakes[0]);
    const b = await signIn(accounts, fleet.fakes[1]);
    const tokenB = accounts.forAccount(b.accountId).repo.getState().addon_token;
    assert.equal(accounts.byAddonToken(tokenB).account.id, b.accountId);
    assert.notEqual(accounts.forAccount(a.accountId).repo.getState().addon_token, tokenB);
    assert.equal(accounts.byAddonToken('nope'), null);
    assert.equal(accounts.byAddonToken(''), null);
  });

  it('deleting an account removes everything of it and nothing of anyone else', async () => {
    const fleet = fakeFleet(person(1), person(2));
    const { db, accounts } = server(fleet, { mode: 'open' });
    const a = await signIn(accounts, fleet.fakes[0]);
    const b = await signIn(accounts, fleet.fakes[1]);
    await accounts.deleteAccount(a.accountId);
    const count = (t, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE account_id = ?`).get(id).n;
    for (const t of ['profiles', 'backups', 'switch_journal', 'sessions']) assert.equal(count(t, a.accountId), 0, t);
    assert.equal(count('profiles', b.accountId), 1);
    assert.deepEqual(fleet.fakes[0].activeIds(), ['tt-1'], 'the Stremio account itself is left as it was');
  });
});

describe('upgrading a database from before accounts existed', () => {
  it('moves the single account to account 1, keeps its token, and re-encrypts every blob', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, { upTo: 2 });
    const cipher = new Cipher(crypto.randomBytes(32));
    const library = [libItem('tt-old')];
    const addons = [addon('cinemeta')];
    const now = Date.now();
    db.prepare('INSERT INTO account (id, stremio_user_id, stremio_email, auth_key_enc, linked_at) VALUES (1, ?, ?, ?, ?)')
      .run('user-1', 'me@example.com', cipher.encryptJson('legacy-key'.repeat(4), 'authkey'), now);
    db.prepare(`INSERT INTO profiles (id, name, avatar_preset, avatar_colour, library_enc, addons_enc, notifs_enc, library_count,
      addon_count, notif_count, snapshot_taken_at, stremio_user_id, created_at) VALUES (7, 'Original', 'initial', '#0a7fe0', ?, ?, NULL, 1, 1, NULL, ?, 'user-1', ?)`)
      .run(cipher.encryptJson(library, 'library'), cipher.encryptJson(addons, 'addons'), now, now);
    db.prepare(`INSERT INTO backups (kind, label, library_enc, addons_enc, library_count, addon_count, stremio_user_id, created_at)
      VALUES ('original', 'setup', ?, ?, 1, 1, 'user-1', ?)`).run(cipher.encryptJson(library, 'library'), cipher.encryptJson(addons, 'addons'), now);
    db.prepare("INSERT INTO state (id, active_profile_id, addon_token, addon_installed) VALUES (1, 7, 'the-installed-token-abc', 1)").run();
    db.prepare("INSERT INTO sessions (id_hash, csrf, created_at, expires_at) VALUES (x'01', 'c', 1, 9999999999999)").run();

    migrate(db);
    upgradeLegacyEncryption(db, cipher);

    const accounts = new AccountsService({ db, cipher, stremio: null, sleep: noSleep, access: { mode: 'owner' } });
    const hit = accounts.byAddonToken('the-installed-token-abc');
    assert.equal(hit.account.id, 1, 'the installed add-on link still works');
    const repo = hit.service.repo;
    assert.equal(repo.getAuthKey(), 'legacy-key'.repeat(4));
    assert.equal(repo.getState().active_profile_id, 7);
    const snap = decodeSnapshot(repo.cipher, repo.getProfileRow(7), 'Original');
    assert.deepEqual(snap.library, library);
    assert.deepEqual(decodeSnapshot(repo.cipher, repo.getBackupRow(repo.listBackups()[0].id), 'b').addons, addons);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'old sessions are dropped');
    assert.equal(db.prepare('SELECT enc_version FROM accounts WHERE id = 1').get().enc_version, 2);
    upgradeLegacyEncryption(db, cipher); // a second run is a no-op
    assert.equal(repo.getAuthKey(), 'legacy-key'.repeat(4));
  });

  it('a fresh database migrates cleanly with no accounts', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
  });
});
