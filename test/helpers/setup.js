import crypto from 'node:crypto';
import { createSelfAddon } from '../../src/addon/manifest.js';
import { Cipher } from '../../src/crypto.js';
import { openDatabase } from '../../src/db.js';
import { AccountsService } from '../../src/core/accounts.js';
import { Settings } from '../../src/core/settings.js';
import { FetchError } from '../../src/core/fetchGuard.js';
import { StremioClient } from '../../src/stremio/client.js';
import { CINEMETA_URL, FakeStremio, addon, cinemetaManifest, libItem, notif } from './fakeStremio.js';

export const noSleep = async () => {};

export const PUBLIC_URL = 'https://profiles.example.com';

/**
 * Stands in for fetching add-on manifests over the internet: `manifests`
 * maps link → manifest (stock Cinemeta is there by default). Unknown links fail
 * like an unreachable add-on. `fetched` records each link asked for.
 */
export function fakeManifests() {
  const manifests = new Map([[CINEMETA_URL, cinemetaManifest()]]);
  const fetched = [];
  const fetchManifest = async (url) => {
    fetched.push(url);
    const m = manifests.get(url);
    if (!m) throw new FetchError('UNREACHABLE', "Couldn't reach that add-on.");
    return structuredClone(m);
  };
  return { manifests, fetched, fetchManifest };
}

/**
 * An AccountsService on an in-memory database and a fake Stremio.
 * `ctx.signIn()` signs in to the fake (creating the account the first time)
 * and points `ctx.service` / `ctx.repo` at that account.
 * `withAddon` turns on the M2 self-insert. `access` is the sign-in rule, given
 * to `ctx.settings` as if it came from the environment (the Server tab can
 * then override it); `env` adds other environment settings.
 */
export function makeService({ fake = new FakeStremio(), key = crypto.randomBytes(32), withAddon = false, access = { mode: 'owner' }, env = {}, admins = [], web = fakeManifests() } = {}) {
  const db = openDatabase(null, { filename: ':memory:' });
  const cipher = new Cipher(key);
  let clock = Date.parse('2026-10-10T12:00:00.000Z');
  const now = () => (clock += 1000);
  const stremio = new StremioClient({ fetchImpl: fake.fetch, sleep: noSleep });
  const settings = new Settings({
    db,
    now,
    env: {
      ACCESS: access.mode,
      ALLOWED_ACCOUNTS: (access.allowed ?? []).join(','),
      MAX_ACCOUNTS: access.maxAccounts != null && Number.isFinite(access.maxAccounts) ? String(access.maxAccounts) : '',
      ...env,
    },
  });
  const selfAddon = withAddon ? createSelfAddon({ publicUrl: PUBLIC_URL }, () => settings.addon()) : null;
  const accounts = new AccountsService({
    db, cipher, stremio, sleep: noSleep, now, selfAddon, access: () => settings.access(), admins, fetchManifest: web.fetchManifest,
  });
  const ctx = {
    fake, db, cipher, stremio, accounts, settings, web, service: null, repo: null,
    advance(ms) { clock += ms; },
    async signIn(email = fake.user.email, password = fake.password) {
      const result = await accounts.signIn(email, password);
      ctx.service = accounts.forAccount(result.accountId);
      ctx.repo = ctx.service.repo;
      return result;
    },
  };
  return ctx;
}

/** Account with a two-show library, two add-ons and one notification. */
export function seededFake(opts) {
  return new FakeStremio(opts).seed({
    library: [
      libItem('tt-a', { lastWatched: '2026-10-01T00:00:00.000Z', timeOffset: 1200, temp: true }),
      libItem('tt-b', { lastWatched: '2026-09-01T00:00:00.000Z' }),
    ],
    notifs: [notif('tt-a 1 3')],
    addons: [addon('cinemeta'), addon('debrid', 'https://debrid.example/SECRETKEY/manifest.json')],
  });
}

/** Signed-in account with "Original" active and an empty "Kids" profile. */
export async function linkedWithKids(opts = {}) {
  const ctx = makeService({ fake: seededFake(), ...opts });
  await ctx.signIn();
  const kids = await ctx.service.createProfile({ name: 'Kids', from: 'empty' });
  const original = ctx.repo.listProfiles().find((p) => p.name === 'Original');
  return { ...ctx, kids, original };
}
