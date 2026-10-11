import crypto from 'node:crypto';
import { Cipher } from '../../src/crypto.js';
import { openDatabase } from '../../src/db.js';
import { Repo } from '../../src/core/repo.js';
import { ProfilesService } from '../../src/core/service.js';
import { StremioClient } from '../../src/stremio/client.js';
import { FakeStremio, addon, libItem, notif } from './fakeStremio.js';

export const noSleep = async () => {};

/** A service wired to an in-memory database and a fake Stremio. */
export function makeService({ fake = new FakeStremio(), key = crypto.randomBytes(32) } = {}) {
  const db = openDatabase(null, { filename: ':memory:' });
  const cipher = new Cipher(key);
  let clock = Date.parse('2026-10-10T12:00:00.000Z');
  const now = () => (clock += 1000);
  const repo = new Repo(db, cipher, now);
  const stremio = new StremioClient({ fetchImpl: fake.fetch, sleep: noSleep });
  const service = new ProfilesService({ repo, stremio, sleep: noSleep, now });
  return { fake, db, cipher, repo, stremio, service };
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

/** Linked service with "Original" active and an empty "Kids" profile. */
export async function linkedWithKids(opts = {}) {
  const ctx = makeService({ fake: seededFake(), ...opts });
  await ctx.service.linkAccount('kyle@example.com', 'hunter22');
  const kids = await ctx.service.createProfile({ name: 'Kids', from: 'empty' });
  const original = ctx.repo.listProfiles().find((p) => p.name === 'Original');
  return { ...ctx, kids, original };
}
