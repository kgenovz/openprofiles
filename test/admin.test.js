import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { normaliseLogo } from '../src/addon/art.js';
import { createSelfAddon, isSelfAddon } from '../src/addon/manifest.js';
import { createAddonRouter } from '../src/addon/routes.js';
import { loadConfig } from '../src/config.js';
import { AccountsService, accessDecision } from '../src/core/accounts.js';
import { USED_SINCE } from '../src/core/repo.js';
import { runDaily } from '../src/core/scheduler.js';
import { Settings } from '../src/core/settings.js';
import { serverStats } from '../src/core/stats.js';
import { migrate } from '../src/db.js';
import { createLogger, silentLogger } from '../src/log.js';
import { createApp } from '../src/web/app.js';
import { buttonColours, contrast, themeCss } from '../src/web/theme.js';
import { Browser } from './helpers/browser.js';
import { FakeStremio, addon, libItem } from './helpers/fakeStremio.js';
import { PUBLIC_URL, makeService, seededFake } from './helpers/setup.js';

function memoryDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** Several fake Stremio accounts behind one fetch, routed by email (login) or auth key. */
function fakeFleet(...fakes) {
  return {
    fakes,
    user: fakes[0].user,
    password: fakes[0].password,
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

describe('server settings', () => {
  it('come from the Server tab, else the environment, else the default', () => {
    const db = memoryDb();
    const settings = new Settings({ db, env: { MAX_ACCOUNTS: '20', ACCESS: 'open', OPERATOR: 'kgenovz' } });
    assert.deepEqual(settings.access(), { mode: 'open', allowed: [], maxAccounts: 20 });
    assert.equal(settings.describe('maxAccounts').source, 'env');
    assert.equal(settings.describe('serverName').source, 'default');

    settings.saveSection('access', { access: 'open', maxAccounts: '50' });
    assert.equal(settings.access().maxAccounts, 50);
    assert.deepEqual(settings.describe('maxAccounts'), { value: 50, source: 'saved', env: 'MAX_ACCOUNTS', envSet: true, envRaw: '20' });
    assert.equal(settings.describe('access').source, 'env', "a value equal to the environment's isn't saved as an override");

    // A fresh Settings on the same database reads what was saved.
    assert.equal(new Settings({ db, env: { MAX_ACCOUNTS: '20' } }).get('maxAccounts'), 50);

    settings.reset('maxAccounts');
    assert.equal(settings.get('maxAccounts'), 20);
    assert.equal(settings.describe('maxAccounts').source, 'env');
  });

  it('saving the value it would have anyway removes the override', () => {
    const settings = new Settings({ db: memoryDb(), env: { MAX_ACCOUNTS: '20' } });
    settings.saveSection('access', { access: 'owner', maxAccounts: '30' });
    assert.equal(settings.describe('maxAccounts').source, 'saved');
    settings.saveSection('access', { access: 'owner', maxAccounts: '20' });
    assert.equal(settings.describe('maxAccounts').source, 'env');
  });

  it('checks a whole form before saving any of it, and says everything that is wrong', () => {
    const settings = new Settings({ db: memoryDb() });
    assert.throws(
      () => settings.saveSection('access', { access: 'list', allowedAccounts: '', maxAccounts: 'lots' }),
      (e) => e.code === 'SETTINGS' && /whole number/.test(e.userMessage) && /at least one/.test(e.userMessage),
    );
    assert.equal(settings.get('access'), 'owner', 'nothing saved');
    assert.throws(() => settings.saveSection('about', { contact: 'javascript:alert(1)' }), /email address or a web address/);
    assert.throws(() => settings.saveSection('about', { contact: 'http://example.com' }), /https/);
    assert.throws(() => settings.saveSection('look', { serverName: 'x'.repeat(41), accent: '#abc', appearance: 'auto' }), /at most 40.*hex colour/);
    assert.throws(() => settings.saveSection('nope', {}), /section/);
  });

  it('emptied texts go back to their defaults; the stock violet means "no custom accent"', () => {
    const settings = new Settings({ db: memoryDb() });
    settings.saveSection('look', { serverName: 'Genovy Profiles', accent: '#0F8F80', appearance: 'dark' });
    assert.equal(settings.branding().name, 'Genovy Profiles');
    assert.equal(settings.branding().accent, '#0f8f80');
    settings.saveSection('look', { serverName: '  ', accent: '#8b6dff', appearance: 'auto' });
    assert.equal(settings.branding().name, 'OpenProfiles');
    assert.equal(settings.branding().accent, null);
    assert.equal(settings.describe('serverName').source, 'default');
  });

  it("an unticked switch is off; the list takes commas or new lines", () => {
    const settings = new Settings({ db: memoryDb() });
    settings.saveSection('signin', { signinHeadline: 'Hi', signinIntro: '' });
    assert.equal(settings.get('selfHostLinks'), false);
    settings.saveSection('access', { access: 'list', allowedAccounts: 'a@example.com\r\nb@example.com, user-9', maxAccounts: '' });
    assert.deepEqual(settings.access().allowed, ['a@example.com', 'b@example.com', 'user-9']);
    assert.throws(() => settings.reset('allowedAccounts'), /nobody on the list/);
  });

  it('tells listeners what changed, and only when something did', () => {
    const settings = new Settings({ db: memoryDb() });
    const seen = [];
    settings.onChange((keys) => seen.push(keys));
    settings.saveSection('log', { logLevel: 'debug' });
    settings.saveSection('log', { logLevel: 'debug' });
    assert.deepEqual(seen, [['logLevel']]);
  });

  it('the manifest version of the logo changes with the accent and with an upload', () => {
    const settings = new Settings({ db: memoryDb() });
    const drawn = settings.logoVersion();
    settings.saveSection('look', { serverName: '', accent: '#0a7fe0', appearance: 'auto' });
    assert.notEqual(settings.logoVersion(), drawn);
    settings.setLogo(Buffer.from('png bytes'));
    assert.equal(settings.logo().toString(), 'png bytes');
    assert.equal(settings.branding().customLogo, true);
    settings.setLogo(null);
    assert.equal(settings.logo(), null);
  });
});

describe('who runs the server', () => {
  it('always gets in, whatever the rule', () => {
    const user = { id: 'u1', email: 'me@example.com' };
    assert.equal(accessDecision({ mode: 'list', allowed: [] }, { user, existing: { id: 1 }, accountCount: 1, admin: true }), null);
    assert.equal(accessDecision({ mode: 'open', maxAccounts: 1 }, { user, existing: null, accountCount: 5, admin: true }), null);
  });

  it('is the first account set up; ADMINS can name more', async () => {
    const fleet = fakeFleet(person(1), person(2), person(3));
    const ctx = makeService({ fake: fleet, access: { mode: 'open' }, admins: ['person3@example.com'] });
    const first = await ctx.accounts.signIn('person1@example.com', 'hunter22');
    const second = await ctx.accounts.signIn('person2@example.com', 'hunter22');
    const third = await ctx.accounts.signIn('person3@example.com', 'hunter22');
    assert.equal(ctx.accounts.ownerId(), first.accountId);
    assert.equal(ctx.accounts.isAdmin(first.accountId), true);
    assert.equal(ctx.accounts.isAdmin(second.accountId), false);
    assert.equal(ctx.accounts.isAdmin(third.accountId), true);

    // A list that leaves the owner off still lets the owner in, and nobody else off it.
    ctx.settings.saveSection('access', { access: 'list', allowedAccounts: 'person3@example.com' });
    await ctx.accounts.signIn('person1@example.com', 'hunter22');
    await assert.rejects(ctx.accounts.signIn('person2@example.com', 'hunter22'), (e) => e.code === 'NOT_ALLOWED');
  });

  it('an existing server records its first account as the owner when it upgrades', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, { upTo: 6 });
    for (const id of [4, 2]) {
      db.prepare(`INSERT INTO accounts (id, stremio_user_id, stremio_email, auth_key_enc, addon_token, created_at, last_login_at)
        VALUES (?, ?, ?, x'00', ?, 1, 1)`).run(id, `u${id}`, `p${id}@example.com`, `token-${id}-xxxxxxxxxxxxxxxx`);
    }
    migrate(db);
    const meta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
    assert.equal(meta('owner_stremio_user_id'), 'u2');
    assert.equal(meta('owner_account_id'), undefined, 'the id is no longer what makes the owner');
    assert.equal(new AccountsService({ db, cipher: null, stremio: null }).ownerId(), 2);
  });

  it('a server whose owner already deleted their account upgrades with nobody as owner', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, { upTo: 10 });
    db.prepare(`INSERT INTO accounts (id, stremio_user_id, stremio_email, auth_key_enc, addon_token, created_at, last_login_at)
      VALUES (3, 'u3', 'p3@example.com', x'00', 'token-3-xxxxxxxxxxxxxxxx', 1, 1)`).run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('owner_account_id', '1')").run();
    migrate(db);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'owner_stremio_user_id'").get().value, '');
    assert.equal(new AccountsService({ db, cipher: null, stremio: null }).ownerId(), null);
  });

  it("is a Stremio account: deleting it hands the server to nobody, and signing in again takes it back", async () => {
    const fleet = fakeFleet(person(1), person(2), person(3));
    const ctx = makeService({ fake: fleet, access: { mode: 'open', maxAccounts: 1 } });
    const owner = await ctx.accounts.signIn('person1@example.com', 'hunter22');
    await ctx.accounts.deleteAccount(owner.accountId);

    // The next account set up gets the same id the owner had.
    const stranger = await ctx.accounts.signIn('person2@example.com', 'hunter22');
    assert.equal(stranger.accountId, owner.accountId);
    assert.equal(ctx.accounts.isAdmin(stranger.accountId), false);
    assert.equal(ctx.accounts.ownerId(), null);

    // The server is full, but its owner always gets in, and owns it again.
    await assert.rejects(ctx.accounts.signIn('person3@example.com', 'hunter22'), (e) => e.code === 'NOT_ALLOWED');
    const back = await ctx.accounts.signIn('person1@example.com', 'hunter22');
    assert.equal(ctx.accounts.ownerId(), back.accountId);
    assert.equal(ctx.accounts.isAdmin(back.accountId), true);
    assert.equal(ctx.accounts.isAdmin(stranger.accountId), false);
  });
});

describe('configuration', () => {
  const env = (extra) => ({ PUBLIC_URL: 'https://profiles.example.com', ...extra });

  it('a REMOVE_UNUSED_DAYS or MAX_ACCOUNTS the Server tab could not read stops the boot', () => {
    for (const value of ['abc', '7', '45.5', '-1', '9999']) {
      assert.throws(() => loadConfig(env({ REMOVE_UNUSED_DAYS: value })), /REMOVE_UNUSED_DAYS must be 0/, value);
    }
    for (const value of ['0', '30', '365', ' 90 ', '']) assert.doesNotThrow(() => loadConfig(env({ REMOVE_UNUSED_DAYS: value })), value);
    for (const value of ['abc', '0', '2.5', '200000']) {
      assert.throws(() => loadConfig(env({ MAX_ACCOUNTS: value })), /MAX_ACCOUNTS must be a whole number/, value);
    }
    assert.equal(loadConfig(env({ MAX_ACCOUNTS: '50' })).access.maxAccounts, 50);
    assert.equal(loadConfig(env({})).access.maxAccounts, Infinity);
  });
});

describe('unused accounts', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-unused-'));
  const daily = (ctx, log = silentLogger) => runDaily({
    db: ctx.db, dataDir, accounts: ctx.accounts, settings: ctx.settings, log, now: () => ctx.accounts.now(), pause: async () => {},
  });
  /** The server up for `days` days, running its daily jobs once a day. Returns what each run removed. */
  async function runFor(ctx, days, log) {
    const removed = [];
    for (let i = 0; i < days; i++) {
      removed.push((await daily(ctx, log)).removed);
      ctx.advance(DAY);
    }
    return removed;
  }
  const sum = (list) => list.reduce((a, b) => a + b, 0);
  const ids = (ctx) => ctx.db.prepare('SELECT id FROM accounts ORDER BY id').all().map((r) => r.id);

  async function accountsFor(count, opts = {}) {
    const people = Array.from({ length: count }, (_, i) => person(i + 1));
    const ctx = makeService({ fake: fakeFleet(...people), access: { mode: 'open' }, ...opts });
    const signed = [];
    for (let n = 1; n <= count; n++) signed.push((await ctx.accounts.signIn(`person${n}@example.com`, 'hunter22')).accountId);
    return { ctx, signed };
  }
  const fourAccounts = (opts = {}) => accountsFor(4, { admins: ['person4@example.com'], ...opts });

  it('on an open server, removes accounts unused for 90 days, never the owner or ADMINS', async () => {
    const { ctx, signed: [owner, fromStremio, idle, admin] } = await fourAccounts();
    await runFor(ctx, 45);
    // Only used from Stremio: its add-on was asked for the Switch profile row.
    const app = express().use(createAddonRouter({ config: { publicUrl: 'https://profiles.example.com' }, accounts: ctx.accounts, settings: ctx.settings, log: silentLogger }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const token = ctx.accounts.getAccount(fromStremio).addon_token;
      assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/${token}/manifest.json`)).status, 200);
    } finally {
      server.close();
    }

    assert.equal(sum(await runFor(ctx, 47)), 1);
    assert.deepEqual(ids(ctx), [owner, fromStremio, admin], `account ${idle} removed`);
  });

  it('keeps everyone with another sign-in rule, or with the setting at 0', async () => {
    const list = await fourAccounts();
    list.ctx.settings.saveSection('access', { access: 'list', allowedAccounts: 'person2@example.com', removeUnusedDays: '90' });
    assert.equal(sum(await runFor(list.ctx, 92)), 0);
    assert.equal(ids(list.ctx).length, 4);

    const never = await fourAccounts({ env: { REMOVE_UNUSED_DAYS: '0' } });
    assert.equal(sum(await runFor(never.ctx, 92)), 0);
    assert.equal(ids(never.ctx).length, 4);
  });

  it('only counts days the server was running: after an outage, nobody goes at once', async () => {
    const { ctx, signed: [owner, a, b] } = await accountsFor(3);
    await runFor(ctx, 10);
    ctx.accounts.noteAddonUse(a);
    ctx.accounts.noteAddonUse(b);
    ctx.advance(95 * DAY); // the server was down, then starts again
    assert.equal((await daily(ctx)).removed, 0);
    assert.deepEqual(ids(ctx), [owner, a, b]);
    ctx.advance(DAY);

    // Unused for 90 days of it running again, they do go.
    const removed = await runFor(ctx, 91);
    assert.equal(sum(removed.slice(0, 88)), 0);
    assert.equal(sum(removed), 2);
    assert.deepEqual(ids(ctx), [owner]);
  });

  it('removes at most 5 a night, and says how many are left', async () => {
    const { ctx, signed: [owner] } = await accountsFor(8);
    const lines = [];
    const log = { ...silentLogger, info: (message, fields) => lines.push({ message, fields }) };
    const removed = await runFor(ctx, 93, log).then((list) => list.filter(Boolean));
    assert.deepEqual(removed, [5, 2]);
    assert.deepEqual(ids(ctx), [owner]);
    assert.deepEqual(lines.find((l) => l.message.startsWith('More unused accounts')).fields, { removed: 5, left: 2 });
  });

  it('never removes an account whose switch never finished (its Stremio may be half-switched)', async () => {
    const fleet = fakeFleet(person(1), person(2));
    const ctx = makeService({ fake: fleet, access: { mode: 'open' }, withAddon: true });
    await ctx.accounts.signIn('person1@example.com', 'hunter22');
    const { accountId } = await ctx.accounts.signIn('person2@example.com', 'hunter22');
    const service = ctx.accounts.forAccount(accountId);
    const kids = await service.createProfile({ name: 'Kids', from: 'empty' });
    fleet.fakes[1].failWhen((m) => m === 'addonCollectionSet', { network: true });
    await assert.rejects(service.switchTo(kids.id));
    assert.ok(service.repo.getOpenJournal());

    assert.equal(sum(await runFor(ctx, 100)), 0);
    assert.ok(ids(ctx).includes(accountId));
  });

  it('visits to the pages count after the session is gone', async () => {
    const ctx = makeService({ fake: seededFake(), access: { mode: 'open' } });
    const server = createApp({ config: { publicUrl: 'http://localhost', trustProxy: false }, db: ctx.db, accounts: ctx.accounts, settings: ctx.settings, log: silentLogger }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const browser = new Browser(`http://127.0.0.1:${server.address().port}`);
      await browser.signIn();
      const seen = () => ctx.db.prepare('SELECT last_seen_at FROM accounts').get().last_seen_at;
      assert.ok(seen() > Date.now() - 60_000, 'signing in counts');

      // An old session visits again; then signs out, so its row is gone.
      ctx.db.prepare('UPDATE accounts SET last_seen_at = 0, last_login_at = 0, last_addon_at = 0').run();
      ctx.db.prepare('DELETE FROM activity').run();
      ctx.db.prepare('UPDATE sessions SET last_seen_at = 0').run();
      await browser.request('/configure');
      assert.ok(seen() > Date.now() - 60_000, 'the visit counts');
      const first = seen();
      await new Promise((resolve) => setTimeout(resolve, 5));
      ctx.db.prepare('UPDATE sessions SET last_seen_at = 0').run();
      await browser.request('/configure');
      assert.equal(seen(), first, 'written at most hourly');
      await browser.post('/logout');
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
      const used = ctx.db.prepare(`SELECT COUNT(*) AS n FROM accounts a WHERE ${USED_SINCE}`).get({ since: Date.now() - 60_000 }).n;
      assert.equal(used, 1);
    } finally {
      server.close();
    }
  });

  it('takes 0, or 30 days and up', () => {
    const settings = new Settings({ db: memoryDb() });
    assert.equal(settings.get('removeUnusedDays'), 90);
    assert.throws(() => settings.saveSection('access', { access: 'open', removeUnusedDays: '7' }), /0 \(never\) or a whole number from 30/);
    settings.saveSection('access', { access: 'open', removeUnusedDays: '180' });
    assert.equal(settings.get('removeUnusedDays'), 180);
  });

  it('accounts from before this was recorded: add-on use starts from the upgrade, visits from their latest session or sign-in', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, { upTo: 8 });
    for (const id of [1, 2]) {
      db.prepare(`INSERT INTO accounts (id, stremio_user_id, stremio_email, auth_key_enc, addon_token, created_at, last_login_at)
        VALUES (?, ?, ?, x'00', ?, 1, 100)`).run(id, `u${id}`, `p${id}@example.com`, `token-${id}-xxxxxxxxxxxxxxxx`);
    }
    db.prepare(`INSERT INTO sessions (id_hash, account_id, csrf, created_at, last_seen_at, expires_at)
      VALUES (x'01', 1, 'c', 100, 5000, 99999)`).run();
    migrate(db);
    const rows = db.prepare('SELECT id, last_addon_at, last_seen_at FROM accounts ORDER BY id').all();
    assert.ok(rows.every((r) => r.last_addon_at > Date.now() - 60_000));
    assert.deepEqual(rows.map((r) => r.last_seen_at), [5000, 100], 'the latest session, else the last sign-in');
  });
});

describe('signing up again after the account was removed', () => {
  async function removedOnce() {
    const fleet = fakeFleet(person(1), person(2));
    const ctx = makeService({ fake: fleet, access: { mode: 'open' }, withAddon: true });
    await ctx.accounts.signIn('person1@example.com', 'hunter22');
    const { accountId } = await ctx.accounts.signIn('person2@example.com', 'hunter22');
    const service = ctx.accounts.forAccount(accountId);
    await service.switchTo((await service.createProfile({ name: 'Kids', from: 'empty' })).id);
    const oldToken = service.repo.getState().addon_token;
    await ctx.accounts.deleteAccount(accountId, { reason: 'unused' });
    return { ctx, fleet, oldToken };
  }
  const links = (fake) => fake.addons.filter(isSelfAddon).map((a) => a.transportUrl);

  it("points the add-on Stremio still has (with the old, dead link) at the new account's", async () => {
    const { ctx, fleet, oldToken } = await removedOnce();
    assert.ok(links(fleet.fakes[1])[0].includes(oldToken));
    const { accountId } = await ctx.accounts.signIn('person2@example.com', 'hunter22');
    const service = ctx.accounts.forAccount(accountId);
    const token = service.repo.getState().addon_token;
    assert.notEqual(token, oldToken);
    assert.deepEqual(links(fleet.fakes[1]), [`${PUBLIC_URL}/${token}/manifest.json`]);
    assert.equal(service.addonInfo().installed, true);
  });

  it("if Stremio won't take the change, the sign-in still works and the page offers Install", async () => {
    const { ctx, fleet, oldToken } = await removedOnce();
    fleet.fakes[1].failWhen((m) => m === 'addonCollectionSet', { network: true });
    const { accountId } = await ctx.accounts.signIn('person2@example.com', 'hunter22');
    assert.equal(ctx.accounts.forAccount(accountId).addonInfo().installed, false);
    assert.ok(links(fleet.fakes[1])[0].includes(oldToken));
  });

  it("leaves another server's OpenProfiles alone, and doesn't count it as installed", async () => {
    const fake = person(1);
    const other = createSelfAddon({ publicUrl: 'https://other.example.org' }).descriptor('someone-elses-token-xxxxxxxx');
    fake.addons.push(other);
    const ctx = makeService({ fake, withAddon: true });
    const { accountId } = await ctx.signIn('person1@example.com', 'hunter22');
    assert.deepEqual(links(fake), [other.transportUrl]);
    assert.equal(ctx.accounts.forAccount(accountId).addonInfo().installed, false);
  });
});

describe('server log counts', () => {
  it('counts errors and warnings by message, keeping nothing of their fields', () => {
    const lines = [];
    const log = createLogger('error', { log: (l) => lines.push(l), error: (l) => lines.push(l) });
    log.warn('Sign-in rate-limited', { email: 'secret@example.com' });
    log.warn('Sign-in rate-limited');
    log.error('Unexpected error', { path: '/x' });
    log.info('ignored');
    const problems = log.problems();
    assert.deepEqual(problems.map((p) => [p.level, p.message, p.count]), [['error', 'Unexpected error', 1], ['warn', 'Sign-in rate-limited', 2]]);
    assert.ok(!JSON.stringify(problems).includes('secret@example.com'));
    assert.equal(lines.length, 1, 'only the error was written at level "error"');
    log.setLevel('warn');
    log.warn('now written');
    assert.equal(lines.length, 2);
  });
});

describe('the accent colour', () => {
  it('keeps button labels and links readable on both themes', () => {
    assert.equal(themeCss({ accent: null }), '', 'no custom accent, no stylesheet');
    for (const accent of ['#0a7fe0', '#0f8f80', '#ffd400', '#e5484d', '#111111', '#f0f0f0']) {
      const b = buttonColours(accent);
      assert.ok(contrast(b.background, b.text) >= 4.5, `${accent} button`);
      const css = themeCss({ accent });
      const [light, dark] = [...css.matchAll(/--link: (#[0-9a-f]{6})/g)].map((m) => m[1]);
      assert.ok(contrast(light, '#ffffff') >= 4.5 && contrast(light, '#f4f4f7') >= 4.5, `${accent} light link`);
      assert.ok(contrast(dark, '#1c1c22') >= 4.5 && contrast(dark, '#121216') >= 4.5, `${accent} dark link`);
    }
  });

  it('an uploaded logo is redrawn as a 256 px PNG; other files are refused', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    assert.equal(await normaliseLogo(svg), null);
    assert.equal(await normaliseLogo(Buffer.from('not an image')), null);
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#e05d0c' } }).jpeg().toBuffer();
    const png = await normaliseLogo(jpeg);
    const meta = await sharp(png).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', 256, 256]);
  });
});

describe('the Server tab', () => {
  let server;
  let base;
  let ctx;
  let owner;
  let other;

  const signInAs = (b, n) => b.request('/signin', { method: 'POST', form: { email: `person${n}@example.com`, password: 'hunter22' } });

  before(async () => {
    ctx = makeService({ fake: fakeFleet(person(1), person(2), person(3)), withAddon: true, access: { mode: 'open', maxAccounts: 20 }, env: { OPERATOR: 'kgenovz' } });
    const config = { publicUrl: 'http://localhost', trustProxy: false };
    server = createApp({ config, db: ctx.db, accounts: ctx.accounts, settings: ctx.settings, log: silentLogger }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    owner = new Browser(base);
    other = new Browser(base);
    assert.equal((await signInAs(owner, 1)).status, 303);
    assert.equal((await signInAs(other, 2)).status, 303);
  });

  after(() => server.close());

  it('only whoever runs the server sees it', async () => {
    const page = await owner.request('/admin');
    assert.equal(page.status, 200);
    assert.match(page.text, /href="\/admin"/);
    assert.match(page.text, /2<\/strong><span class="hint">of 20/);

    assert.doesNotMatch((await other.request('/configure')).text, /href="\/admin"/);
    assert.equal((await other.request('/admin')).status, 404);
    const csrf = await other.csrf();
    const res = await other.request('/admin/settings/look', { method: 'POST', form: { _csrf: csrf, serverName: 'Mine now' } });
    assert.equal(res.status, 404);
    assert.equal(ctx.settings.get('serverName'), 'OpenProfiles');
    assert.equal((await new Browser(base).request('/admin')).status, 303, 'signed out: off to sign in');
  });

  it("shows counts, never who: no emails, ids or profile names", async () => {
    await ctx.accounts.forAccount(2).createProfile({ name: 'Secret Kids', from: 'empty' });
    const page = (await owner.request('/admin')).text;
    for (const leak of ['person1@example.com', 'person2@example.com', 'user-2', 'Secret Kids']) {
      assert.ok(!page.replace(/<header[\s\S]*?<\/header>/, '').includes(leak), `${leak} isn't on the Server tab`);
    }
    const stats = serverStats({ db: ctx.db, dataDir: '.', settings: ctx.settings, log: silentLogger, startedAt: Date.now() });
    assert.equal(stats.accounts.total, 2);
    assert.equal(stats.server.profiles, 3);
    assert.ok(!JSON.stringify(stats).includes('@example.com'));
  });

  it('the account limit applies at once, and env values can be put back', async () => {
    let res = await owner.post('/admin/settings/access', { access: 'open', maxAccounts: '2' });
    assert.equal(res.location, '/admin#access');
    const refused = await signInAs(new Browser(base), 3);
    assert.equal(refused.status, 400);
    assert.match(refused.text, /This server is full/);
    const page = (await owner.request('/admin')).text;
    assert.match(page, /Overrides .env \(20\)/);
    assert.match(page, /Full: nobody new can sign in/);

    res = await owner.post('/admin/reset/maxAccounts');
    assert.equal(res.location, '/admin#access');
    assert.equal(ctx.settings.get('maxAccounts'), 20);
    assert.equal((await signInAs(new Browser(base), 3)).status, 303);
  });

  it('the look, texts and announcement show on every page, signed out too', async () => {
    await owner.post('/admin/settings/look', { serverName: 'Genovy Profiles', accent: '#0f8f80', appearance: 'dark' });
    await owner.post('/admin/settings/signin', { signinHeadline: 'Profiles for the Genovy house', signinIntro: '' });
    await owner.post('/admin/settings/announcement', { announcement: 'Moving servers <Sunday>' });
    await owner.post('/admin/settings/about', { operator: 'kgenovz', contact: 'help@example.com', privacyNote: '' });

    const signin = (await new Browser(base).request('/signin')).text;
    assert.match(signin, /<title>Sign in · Genovy Profiles<\/title>/);
    assert.match(signin, /<html lang="en" data-theme="dark">/);
    assert.match(signin, /<link rel="stylesheet" href="\/theme.css\?v=[0-9a-f]+">/);
    assert.match(signin, /<h1>Profiles for the Genovy house<\/h1>/);
    assert.match(signin, /Moving servers &lt;Sunday&gt;/, 'escaped');
    assert.match(signin, /href="mailto:help@example.com"/);
    assert.doesNotMatch(signin, /host your own/, 'the GitHub links were switched off');
    assert.doesNotMatch(signin, /OpenProfiles on GitHub/);

    const css = await (await fetch(`${base}/theme.css`)).text();
    assert.match(css, /--brand: #0f8f80/);
    assert.match((await owner.request('/configure')).text, /Moving servers/);
  });

  it('the add-on presents itself the way the Server tab says', async () => {
    await owner.post('/admin/settings/stremio', { addonName: 'Genovy Profiles', catalogName: "Who's watching", addonDescription: '' });
    const token = ctx.accounts.forAccount(1).repo.getState().addon_token;
    const manifest = await (await fetch(`${base}/${token}/manifest.json`)).json();
    assert.equal(manifest.name, 'Genovy Profiles');
    assert.equal(manifest.catalogs[0].name, "Who's watching");
    assert.equal(manifest.catalogs[0].type, 'OpenProfiles', 'the type never changes');
    assert.match(manifest.description, /^Switch between the profiles/, 'emptied: the default');
    assert.match(manifest.logo, /\/logo\.png\?v=[0-9a-f]+$/);
    // And the copy a switch writes into Stremio carries it too.
    assert.equal(ctx.accounts.forAccount(1).selfAddon.descriptor(token).manifest.name, 'Genovy Profiles');
  });

  it('the logo upload accepts pictures only, and only from whoever runs the server', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#e05d0c' } }).png().toBuffer();
    const upload = async (b, body, type) => fetch(`${base}/admin/logo`, {
      method: 'POST', headers: { cookie: b.cookie, 'x-csrf-token': await b.csrf(), 'content-type': type }, body,
    });
    assert.equal((await upload(other, png, 'image/png')).status, 404);
    const bad = await upload(owner, '<svg/>', 'image/svg+xml');
    assert.equal(bad.status, 400);
    assert.equal((await upload(owner, png, 'image/png')).status, 200);
    const logo = await fetch(`${base}/logo.png`);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.equal((await sharp(Buffer.from(await logo.arrayBuffer())).metadata()).width, 256);
    assert.match((await owner.request('/admin')).text, /class="brand-logo"/);
  });

  it('saving needs the CSRF token', async () => {
    const res = await owner.request('/admin/settings/look', { method: 'POST', form: { serverName: 'No token' } });
    assert.equal(res.status, 403);
  });
});
