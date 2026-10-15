import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { normaliseLogo, normalisePhoto, renderPoster } from '../src/addon/art.js';
import { parseAvatar } from '../src/addon/avatars.js';
import { silentLogger } from '../src/log.js';
import { createApp } from '../src/web/app.js';
import { Browser } from './helpers/browser.js';
import { PUBLIC_URL, linkedWithKids, makeService, seededFake } from './helpers/setup.js';

const solid = (colour, width = 900, height = 600) => sharp({ create: { width, height, channels: 3, background: colour } }).jpeg().toBuffer();

/** The RGB of one pixel of a PNG. */
async function pixel(png, x, y) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [...data.slice(i, i + 3)];
}

const near = (rgb, [r, g, b], slack = 30) => Math.abs(rgb[0] - r) < slack && Math.abs(rgb[1] - g) < slack && Math.abs(rgb[2] - b) < slack;

describe('profile photos', () => {
  it('an upload is redrawn as a 512 px square JPEG; other files are refused', async () => {
    const jpeg = await normalisePhoto(await solid('#e05d0c'));
    const meta = await sharp(jpeg).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 512, 512]);
    assert.equal(await normalisePhoto(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.equal(await normalisePhoto(Buffer.alloc(0)), null);
  });

  it('refuses a picture over 25 megapixels before decoding it, however small the file', async () => {
    const huge = await solid('#e05d0c', 5100, 5000);
    assert.ok(huge.length < 4 * 1024 * 1024);
    assert.equal(await normalisePhoto(huge), null);
    assert.equal(await normaliseLogo(huge), null);
  });

  it('one per profile: a new upload replaces the old one and becomes the picture', async () => {
    const { service, repo, kids } = await linkedWithKids();
    const first = await normalisePhoto(await solid('#e05d0c'));
    const p = service.setPhoto(kids.id, first);
    assert.equal(parseAvatar(p.avatar_preset).kind, 'photo');
    assert.equal(p.avatar_preset, `photo:${p.photo_hash}`);
    assert.deepEqual(repo.getProfilePhoto(kids.id), first);

    const second = await normalisePhoto(await solid('#0a7fe0'));
    const q = service.setPhoto(kids.id, second);
    assert.notEqual(q.photo_hash, p.photo_hash);
    assert.deepEqual(repo.getProfilePhoto(kids.id), second);
    assert.throws(() => service.setAvatar(kids.id, q.avatar_colour, p.avatar_preset), /isn't this profile's/, 'the old photo is gone');

    // Picking a character keeps the photo, so it can be picked again.
    service.setAvatar(kids.id, q.avatar_colour, 'char:cat');
    service.setAvatar(kids.id, q.avatar_colour, q.avatar_preset);
    assert.equal(repo.getProfile(kids.id).avatar_preset, q.avatar_preset);

    const removed = service.removePhoto(kids.id);
    assert.equal(removed.avatar_preset, 'initial');
    assert.equal(removed.photo_hash, null);
    assert.equal(repo.getProfilePhoto(kids.id), null);
  });

  it("a profile can't show another profile's photo, and a new profile can't start with one", async () => {
    const { service, repo, kids, original } = await linkedWithKids();
    const p = service.setPhoto(kids.id, await normalisePhoto(await solid('#e05d0c')));
    assert.throws(() => service.setAvatar(original.id, original.avatar_colour, p.avatar_preset), /isn't this profile's/);
    await assert.rejects(service.createProfile({ name: 'Guest', from: 'empty', picture: p.avatar_preset }), /Pick one of the listed pictures/);
    assert.equal(repo.getProfile(original.id).avatar_preset, 'initial');
  });

  it('is stored encrypted, bound to its account', async () => {
    const { service, db, kids } = await linkedWithKids();
    const jpeg = await normalisePhoto(await solid('#e05d0c'));
    service.setPhoto(kids.id, jpeg);
    const stored = db.prepare('SELECT photo_enc FROM profiles WHERE id = ?').get(kids.id).photo_enc;
    assert.ok(!stored.includes(jpeg.subarray(0, 64)), 'not the plain JPEG');
  });

  it("fills the poster in Stremio, under the name band", async () => {
    const photo = await normalisePhoto(await solid('#e05d0c'));
    const poster = await renderPoster({ name: 'Kids', colour: '#0a7fe0', avatar: 'photo:0123456789abcdef', photo });
    assert.ok(near(await pixel(poster, 20, 20), [224, 93, 12]), 'photo in the corner, not the profile colour');
    const missing = await renderPoster({ name: 'Kids', colour: '#0a7fe0', avatar: 'photo:0123456789abcdef', photo: null });
    assert.ok(near(await pixel(missing, 20, 20), [10, 127, 224]), 'no photo: the profile colour and letter');
  });

  it('goes into "everything" downloads and comes back with them', async () => {
    const { service, kids } = await linkedWithKids();
    const jpeg = await normalisePhoto(await solid('#e05d0c'));
    service.setPhoto(kids.id, jpeg);
    const file = service.exportEverything(null);
    assert.equal(typeof file.profiles.find((p) => p.name === 'Kids').photo, 'string');

    const other = makeService({ fake: seededFake() });
    await other.signIn();
    await other.service.importEverything(file, {});
    const back = other.repo.listProfiles().find((p) => p.name.startsWith('Kids'));
    assert.equal(parseAvatar(back.avatar_preset).kind, 'photo');
    assert.equal(back.avatar_preset, `photo:${back.photo_hash}`);
    assert.ok(other.repo.getProfilePhoto(back.id));
  });
});

describe('profile photos on the page', () => {
  let server;
  let base;
  let ctx;
  let kids;
  const b = () => ctx.browser;

  before(async () => {
    ctx = await linkedWithKids({ withAddon: true });
    kids = ctx.kids;
    const config = { publicUrl: PUBLIC_URL, trustProxy: false };
    server = createApp({ config, db: ctx.db, accounts: ctx.accounts, settings: ctx.settings, log: silentLogger }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    ctx.browser = new Browser(base);
    await ctx.browser.signIn();
  });

  after(() => server.close());

  const upload = async (body, type = 'image/jpeg', id = kids.id) => fetch(`${base}/profiles/${id}/photo`, {
    method: 'POST', headers: { cookie: b().cookie, 'x-csrf-token': await b().csrf(), 'content-type': type }, body,
  });

  it('the Picture section has a Photo tab with an upload', async () => {
    const page = (await b().request(`/profiles/${kids.id}`)).text;
    assert.match(page, /data-tab-for="photo"/);
    assert.match(page, new RegExp(`data-url="/profiles/${kids.id}/photo"`));
    assert.doesNotMatch((await b().request('/profiles/new')).text, /data-tab-for="photo"/, 'not in the wizard');
  });

  it('a photo over the limit gets an answer that says so, not an error page', async () => {
    const res = await upload(Buffer.alloc(5 * 1024 * 1024));
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /That photo is too big: the limit is 4 MB/);
  });

  it('uploads, shows on the page and in Stremio, and can be removed', async () => {
    assert.equal((await upload('not a picture', 'text/plain')).status, 400);
    const noToken = await fetch(`${base}/profiles/${kids.id}/photo`, { method: 'POST', headers: { cookie: b().cookie, 'content-type': 'image/jpeg' }, body: await solid('#e05d0c') });
    assert.equal(noToken.status, 403);

    const res = await upload(await solid('#e05d0c', 3000, 2000));
    assert.equal(res.status, 200);
    const p = ctx.repo.getProfile(kids.id);
    assert.equal(p.avatar_preset, `photo:${p.photo_hash}`);

    const page = (await b().request(`/profiles/${kids.id}`)).text;
    assert.match(page, /New photo for Kids/);
    assert.match(page, new RegExp(`value="photo:${p.photo_hash}" checked`));
    const photo = await fetch(`${base}/avatars/profile/${kids.id}/photo.jpg`, { headers: { cookie: b().cookie } });
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
    const tile = await (await fetch(`${base}/avatars/profile/${kids.id}.svg`, { headers: { cookie: b().cookie } })).text();
    assert.match(tile, /<image href="data:image\/jpeg;base64,/);

    const token = ctx.repo.getState().addon_token;
    const poster = Buffer.from(await (await fetch(`${base}/${token}/poster/${kids.id}.png`)).arrayBuffer());
    assert.ok(near(await pixel(poster, 20, 20), [224, 93, 12]));

    const removed = await b().post(`/profiles/${kids.id}/photo/remove`);
    assert.equal(removed.location, `/profiles/${kids.id}#picture`);
    assert.equal(ctx.repo.getProfile(kids.id).avatar_preset, 'initial');
    assert.equal((await fetch(`${base}/avatars/profile/${kids.id}/photo.jpg`, { headers: { cookie: b().cookie } })).status, 404);
  });

  it("another account's profile can't be given a photo", async () => {
    assert.equal((await upload(await solid('#e05d0c'), 'image/jpeg', 9999)).status, 400);
  });
});

describe('one upload at a time', () => {
  it('a body sent too slowly is cut off, so the next upload gets its turn', async () => {
    const ctx = await linkedWithKids({ withAddon: true });
    const config = { publicUrl: PUBLIC_URL, trustProxy: false };
    const server = createApp({ config, db: ctx.db, accounts: ctx.accounts, settings: ctx.settings, log: silentLogger, uploadReadMs: 300 }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const browser = new Browser(base);
      await browser.signIn();
      const csrf = await browser.csrf();
      const path = `/profiles/${ctx.kids.id}/photo`;
      const headers = { cookie: browser.cookie, 'x-csrf-token': csrf, 'content-type': 'image/jpeg' };

      // Says 100 kB are coming, sends 10 bytes, then nothing.
      const slow = http.request(`${base}${path}`, { method: 'POST', headers: { ...headers, 'content-length': 100_000 } });
      const cut = new Promise((resolve) => {
        slow.on('error', resolve);
        slow.on('response', (res) => res.resume().on('end', resolve));
      });
      slow.write(Buffer.alloc(10));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const upload = async () => (await fetch(`${base}${path}`, { method: 'POST', headers, body: await solid('#e05d0c') })).status;
      assert.equal(await upload(), 429, 'the slow one holds the turn');
      await cut;
      assert.equal(await upload(), 200);
    } finally {
      server.close();
    }
  });
});
