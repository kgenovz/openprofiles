import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import sharp from 'sharp';
import { createAddonRouter } from '../src/addon/routes.js';
import { posterSvg, renderPoster } from '../src/addon/art.js';
import {
  ADDON_ID, CATALOG_TYPE, buildManifest, ensureSelfAddon, isCatalogId, isSelfAddon, parseProfileMetaId,
} from '../src/addon/manifest.js';
import { silentLogger } from '../src/log.js';
import { createApp } from '../src/web/app.js';
import { addon } from './helpers/fakeStremio.js';
import { PUBLIC_URL, linkedWithKids, makeService, seededFake } from './helpers/setup.js';

describe('manifest', () => {
  it('declares exactly one meta resource, with the profile id prefix', () => {
    const m = buildManifest({ publicUrl: PUBLIC_URL });
    const metas = m.resources.filter((r) => (typeof r === 'string' ? r : r.name) === 'meta');
    assert.equal(metas.length, 1);
    assert.deepEqual(metas[0].idPrefixes, ['openprofiles:']);
    assert.ok(m.types.includes(CATALOG_TYPE), 'the catalog type is listed in types[]');
    assert.equal(m.catalogs[0].name, 'Switch profile');
  });

  it('ensureSelfAddon appends when missing and repoints in place when present', () => {
    const desc = { transportUrl: 'https://new/manifest.json', transportName: '', manifest: { id: ADDON_ID, v: 2 }, flags: {} };
    const appended = ensureSelfAddon([addon('cinemeta')], desc);
    assert.equal(appended.length, 2);
    assert.equal(appended[1], desc);

    const old = { transportUrl: 'https://old/manifest.json', manifest: { id: ADDON_ID, v: 1 }, flags: { keep: true } };
    const repointed = ensureSelfAddon([old, addon('cinemeta')], desc);
    assert.equal(repointed[0].transportUrl, 'https://new/manifest.json', 'keeps its position');
    assert.deepEqual(repointed[0].flags, { keep: true });
    assert.equal(repointed[0].manifest.v, 2);
  });

  it("the row's catalog id names the profile in use", () => {
    assert.equal(buildManifest({ publicUrl: PUBLIC_URL }).catalogs[0].id, 'openprofiles');
    assert.equal(buildManifest({ publicUrl: PUBLIC_URL }, undefined, 7).catalogs[0].id, 'openprofiles.7');
    for (const id of ['openprofiles', 'openprofiles.7']) assert.ok(isCatalogId(id), id);
    for (const id of ['top', 'openprofilesx', 'openprofiles:7']) assert.ok(!isCatalogId(id), id);
  });

  it('parses only well-formed profile ids', () => {
    assert.equal(parseProfileMetaId('openprofiles:12'), 12);
    for (const bad of ['openprofiles:', 'openprofiles:x', 'tt123', 'openprofiles:-1', 'openprofiles:1.5']) {
      assert.equal(parseProfileMetaId(bad), null, bad);
    }
  });
});

describe('switching keeps OpenProfiles installed', () => {
  it('inserts the add-on into a profile saved without it', async () => {
    const { service, fake, kids, repo } = await linkedWithKids({ withAddon: true });
    assert.ok(!fake.addons.some(isSelfAddon));
    await service.switchTo(kids.id);
    const self = fake.addons.find(isSelfAddon);
    assert.ok(self, 'the switcher row survives the switch');
    assert.equal(self.transportUrl, `${PUBLIC_URL}/${repo.getState().addon_token}/manifest.json`);
    assert.equal(repo.getState().addon_installed, 1);
  });

  it('every switch gives the row a new catalog id, so Stremio loads it again', async () => {
    const { service, fake, kids, original } = await linkedWithKids({ withAddon: true });
    const rowId = () => fake.addons.find(isSelfAddon).manifest.catalogs[0].id;
    await service.switchTo(kids.id);
    assert.equal(rowId(), `openprofiles.${kids.id}`);
    await service.switchTo(original.id);
    assert.equal(rowId(), `openprofiles.${original.id}`);
  });

  it('rotating the link repoints the installed copy before the old token stops working', async () => {
    const { service, fake, repo } = await linkedWithKids({ withAddon: true });
    const oldToken = repo.getState().addon_token;
    fake.addons.push(service.selfAddon.descriptor(oldToken));
    const info = await service.rotateAddonToken();
    const newToken = repo.getState().addon_token;
    assert.notEqual(newToken, oldToken);
    assert.equal(info.installed, true);
    assert.equal(fake.addons.find(isSelfAddon).transportUrl, `${PUBLIC_URL}/${newToken}/manifest.json`);
  });

  it('a failed repoint keeps the old token', async () => {
    const { service, fake, repo } = await linkedWithKids({ withAddon: true });
    const oldToken = repo.getState().addon_token;
    fake.addons.push(service.selfAddon.descriptor(oldToken));
    fake.failWhen((m) => m === 'addonCollectionSet', { error: { code: 99, message: 'nope' } });
    await assert.rejects(service.rotateAddonToken());
    assert.equal(repo.getState().addon_token, oldToken);
  });
});

describe('poster art', () => {
  it('renders a 512 px square PNG', async () => {
    const png = await renderPoster({ name: 'Kids', colour: '#d6409f', active: true });
    const meta = await sharp(png).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', 512, 512]);
  });

  it('marks the active profile and handles names the font cannot draw', () => {
    assert.match(posterSvg({ name: 'Kids', colour: '#d6409f', active: true }), /#14141a/, 'check badge');
    assert.doesNotMatch(posterSvg({ name: 'Kids', colour: '#d6409f', active: false }), /#14141a/);
    assert.doesNotThrow(() => posterSvg({ name: '映画', colour: '#3b8f4b', active: false }));
    assert.doesNotThrow(() => posterSvg({ name: '', colour: '#3b8f4b', active: false }));
  });
});

describe('add-on routes', () => {
  let server;
  let base;
  let ctx;
  let token;

  before(async () => {
    ctx = makeService({ fake: seededFake(), withAddon: true });
    await ctx.signIn();
    ctx.kids = await ctx.service.createProfile({ name: 'Kids', from: 'empty' });
    const config = { publicUrl: PUBLIC_URL, trustProxy: false };
    server = createApp({ config, db: ctx.db, accounts: ctx.accounts, settings: ctx.settings, log: silentLogger }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  beforeEach(() => {
    token = ctx.repo.getState().addon_token;
  });

  const get = async (path) => {
    const res = await fetch(base + path, { redirect: 'manual' });
    const type = res.headers.get('content-type') || '';
    return { res, body: type.includes('json') ? await res.json() : null };
  };

  it('serves the manifest with CORS and no caching', async () => {
    const { res, body } = await get(`/${token}/manifest.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(body.id, ADDON_ID);
    assert.equal(body.catalogs[0].id, `openprofiles.${ctx.repo.getState().active_profile_id}`);
  });

  it('answers 404 for a wrong token', async () => {
    for (const path of ['/wrong/manifest.json', `/wrong/catalog/${CATALOG_TYPE}/openprofiles.json`, '/wrong/stream/x/openprofiles:1.json']) {
      assert.equal((await get(path)).res.status, 404, path);
    }
  });

  it('lists every profile with a versioned square poster, active one marked', async () => {
    const { body } = await get(`/${token}/catalog/${CATALOG_TYPE}/openprofiles.json`);
    assert.deepEqual(body.metas.map((m) => m.name), ['Original', 'Kids']);
    assert.ok(body.metas.every((m) => m.posterShape === 'square' && /\.png\?v=/.test(m.poster)));
    assert.match(body.metas[0].description, /in use/);
    for (const id of ['openprofiles.1', 'openprofiles.999']) {
      const again = await get(`/${token}/catalog/${CATALOG_TYPE}/${id}.json`);
      assert.deepEqual(again.body, body, 'any of the row ids gets the current list');
    }
    const other = await get(`/${token}/catalog/movie/top.json`);
    assert.deepEqual(other.body, { metas: [] });
  });

  it('meta echoes the requested type and 404s unknown ids', async () => {
    const { body } = await get(`/${token}/meta/other/openprofiles:${ctx.kids.id}.json`);
    assert.equal(body.meta.type, 'other');
    assert.equal(body.meta.behaviorHints.defaultVideoId, `openprofiles:${ctx.kids.id}`);
    assert.equal((await get(`/${token}/meta/${CATALOG_TYPE}/openprofiles:999.json`)).res.status, 404);
  });

  it('the stream request performs the switch, and repeating it is harmless', async () => {
    const path = `/${token}/stream/${CATALOG_TYPE}/${encodeURIComponent(`openprofiles:${ctx.kids.id}`)}.json`;
    const first = await get(path);
    assert.equal(ctx.repo.getState().active_profile_id, ctx.kids.id);
    for (const s of first.body.streams) {
      assert.equal(s.title, undefined, 'stremio-core treats title as description: both = duplicate field = "No streams were found"');
    }
    assert.equal(first.body.streams.length, 1);
    const [refresh] = first.body.streams;
    assert.match(refresh.description, /^Switched to Kids/);
    assert.equal(refresh.externalUrl, 'stremio:///library', 'no browser user agent (the Android app): deep link straight back in');
    assert.ok(first.body.streams.every((s) => !s.url), 'nothing plays, so nothing lands in Continue Watching');

    const puts = ctx.fake.calls.length;
    const again = await get(path);
    assert.match(again.body.streams[0].description, /^Kids is in use/);
    const desktop = await (await fetch(base + path, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0' },
    })).json();
    assert.equal(desktop.streams[0].externalUrl, `${PUBLIC_URL}/refresh/go?to=auto`, 'desktop bounces through the browser so the window refocuses');
    assert.equal(ctx.fake.calls.length, puts + 0, 'already active: no Stremio calls');
  });

  it('errors come back as a stream with the reason first, opening the OpenProfiles page', async () => {
    const original = ctx.repo.listProfiles().find((p) => p.name === 'Original');
    ctx.fake.failWhen((m) => m === 'getUser', { status: 529 });
    const { body } = await get(`/${token}/stream/${CATALOG_TYPE}/openprofiles:${original.id}.json`);
    ctx.fake.rules = [];
    assert.match(body.streams[0].description, /^Couldn't switch: Stremio is busy/);
    assert.equal(body.streams[0].externalUrl, `${PUBLIC_URL}/configure`);
    assert.equal(body.streams[0].url, undefined);
  });

  it('serves posters and the logo', async () => {
    const poster = await fetch(`${base}/${token}/poster/${ctx.kids.id}.png`);
    assert.equal(poster.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/logo.png`)).status, 200);
  });

  it('a slow switch answers "still switching" and finishes in the background', async () => {
    let finish;
    const slowService = { repo: ctx.repo, switchTo: () => new Promise((resolve) => { finish = resolve; }) };
    const slowAccounts = { byAddonToken: (t) => (t === token ? { account: {}, service: slowService } : null) };
    const app = express().use(createAddonRouter({ config: { publicUrl: PUBLIC_URL }, accounts: slowAccounts, log: silentLogger, waitMs: 20 }));
    const slow = app.listen(0);
    await new Promise((resolve) => slow.once('listening', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${slow.address().port}/${token}/stream/${CATALOG_TYPE}/openprofiles:${ctx.kids.id}.json`);
      const body = await res.json();
      assert.match(body.streams[0].description, /^Still switching to Kids/);
      finish({ alreadyActive: false, warnings: [] });
    } finally {
      slow.close();
    }
  });

  it('the refresh redirect sends Android to Library and everything else Home, and nowhere else', async () => {
    const go = async (query, ua) => {
      const res = await fetch(`${base}/refresh/go?${query}`, { redirect: 'manual', headers: ua ? { 'user-agent': ua } : {} });
      assert.equal(res.status, 302);
      return res.headers.get('location');
    };
    const android = 'Mozilla/5.0 (Linux; Android 15; SM-S901W) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36';
    const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36';
    assert.equal(await go('to=auto', android), 'stremio:///library');
    assert.equal(await go('to=auto', windows), 'stremio:///', 'Home is "/": /board is "page not found" in current Stremio');
    assert.equal(await go('to=library'), 'stremio:///library');
    assert.equal(await go('to=https%3A%2F%2Fevil.example'), 'stremio:///', 'unknown targets fall back to Home');
    const body = await (await fetch(`${base}/refresh/go?to=library`, { redirect: 'manual' })).text();
    assert.doesNotMatch(body, /Redirecting/, 'no "Found. Redirecting to…" flash in the browser tab');
    assert.match(body, /href="stremio:\/\/\/library"/);
  });

  it('the configure button redirects to the settings page', async () => {
    const { res } = await get(`/${token}/configure`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/configure');
  });
});
