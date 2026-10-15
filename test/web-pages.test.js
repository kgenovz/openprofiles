import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { decodeSnapshot } from '../src/core/guard.js';
import { Settings } from '../src/core/settings.js';
import { silentLogger } from '../src/log.js';
import { createApp } from '../src/web/app.js';
import { Browser } from './helpers/browser.js';
import { FakeStremio, cinemetaAddon, libItem, richAddon } from './helpers/fakeStremio.js';
import { makeService } from './helpers/setup.js';

// The M6 pages: tabs, the wizard, the profile editor and the add-on manager.

describe('web pages', () => {
  let server;
  let base;
  let ctx;
  let b;
  const repo = () => ctx.accounts.forAccount(1).repo;
  const saved = (id) => decodeSnapshot(repo().cipher, repo().getProfileRow(id), 'p');
  const refOf = (html, name) => html.match(new RegExp(`data-ref="([0-9a-f]{16})" data-name="${name}"`))[1];

  before(async () => {
    ctx = makeService({
      fake: new FakeStremio().seed({
        library: [libItem('tt-a', { timeOffset: 600 })],
        addons: [cinemetaAddon(), richAddon('tmdb', { resources: ['catalog', 'meta'] }), richAddon('debrid', { resources: ['stream'] })],
      }),
      withAddon: true,
    });
    const config = { publicUrl: 'https://profiles.example.com', trustProxy: false };
    const app = createApp({ config, db: ctx.db, accounts: ctx.accounts, settings: ctx.settings, log: silentLogger });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  beforeEach(async () => {
    b = new Browser(base);
    await b.signIn();
  });

  it('starts with a set-up checklist, and every tab opens', async () => {
    const page = (await b.request('/configure')).text;
    assert.match(page, /Get set up/);
    assert.match(page, /href="\/profiles\/new"/);
    assert.match(page, /aria-current="page">Profiles</);
    for (const [path, heading] of [['/backups', "You're covered"], ['/install', 'Switch from inside Stremio'], ['/account', 'Signed in with Stremio']]) {
      const res = await b.request(path);
      assert.equal(res.status, 200, path);
      assert.ok(res.text.includes(heading), path);
    }
  });

  it('the wizard lists every add-on and creates a profile with the ones ticked, in order', async () => {
    const wizard = (await b.request('/profiles/new')).text;
    for (const step of ['Name and picture', 'Start from', 'Add-ons', 'Cinemeta', 'Review']) assert.ok(wizard.includes(step), step);
    const cinemeta = refOf(wizard, 'Cinemeta');
    const tmdb = refOf(wizard, 'tmdb');
    const res = await b.post('/profiles', [
      ['name', 'Kids'], ['from', 'empty'], ['colour', '#d6409f'], ['picture', 'char:spark'],
      ['addons_shown', '1'], ['addon', tmdb], ['addon', cinemeta],
      ['cm_shown', '1'], ['cm_popular', '1'], ['cm_search', '1'], ['cm_meta', '1'],
    ]);
    assert.equal(res.status, 303);
    const kids = repo().listProfiles().find((p) => p.name === 'Kids');
    assert.equal(kids.avatar_preset, 'char:spark');
    const snap = saved(kids.id);
    assert.deepEqual(snap.addons.map((a) => a.manifest.name), ['tmdb', 'Cinemeta']);
    assert.ok(!snap.addons[1].manifest.catalogs.some((c) => c.id === 'year'), 'New hidden');
    assert.match((await b.request('/configure')).text, /Created &quot;Kids&quot;/);
  });

  it('a refused wizard comes back with what was picked', async () => {
    const res = await b.post('/profiles', [['wizard', '1'], ['name', 'Original'], ['from', 'empty']]);
    assert.equal(res.status, 400);
    assert.match(res.text, /already a profile called/);
    assert.match(res.text, /name="name" value="Original"/);
  });

  it('the profile page has its sections, and the manager saves, warns and undoes', async () => {
    const kids = repo().listProfiles().find((p) => p.name === 'Kids');
    const pageText = (await b.request(`/profiles/${kids.id}`)).text;
    for (const s of ['Basics', 'Picture', 'Add-ons', 'Cinemeta', "What&#39;s saved", 'Danger zone']) assert.ok(pageText.includes(s), s);

    const manager = (await b.request(`/profiles/${kids.id}/addons`)).text;
    const baseHash = manager.match(/name="base" value="([0-9a-f]+)"/)[1];
    const [tmdb, cinemeta] = ['tmdb', 'Cinemeta'].map((n) => refOf(manager, n));
    await b.post(`/profiles/${kids.id}/addons`, [['base', baseHash], ['ref', cinemeta], ['ref', tmdb], ['remove', tmdb]]);
    assert.deepEqual(saved(kids.id).addons.map((a) => a.manifest.name), ['Cinemeta', 'OpenProfiles'], 'the switcher is kept in every list');

    const after1 = (await b.request(`/profiles/${kids.id}/addons`)).text;
    assert.match(after1, /Saved Kids&#39;s add-ons/);
    const undo = after1.match(/action="\/edits\/(\d+)\/undo"/)[1];

    // Hide only hides the bar, in this browser; undo still works.
    await b.post(`/edits/${undo}/hide`);
    assert.doesNotMatch((await b.request(`/profiles/${kids.id}/addons`)).text, /\/edits\/\d+\/undo/);
    const other = new Browser(base);
    await other.signIn();
    assert.match((await other.request(`/profiles/${kids.id}/addons`)).text, /\/edits\/\d+\/undo/, 'another browser still shows it');

    await b.post(`/edits/${undo}/undo`);
    assert.deepEqual(saved(kids.id).addons.map((a) => a.manifest.name), ['tmdb', 'Cinemeta', 'OpenProfiles']);
  });

  it("a crafted rename field can't reach Object.prototype", async () => {
    const kids = repo().listProfiles().find((p) => p.name === 'Kids');
    const manager = (await b.request(`/profiles/${kids.id}/addons`)).text;
    const baseHash = manager.match(/name="base" value="([0-9a-f]+)"/)[1];
    const refs = [...manager.matchAll(/name="ref" value="([0-9a-f]{16})"/g)].map((m) => ['ref', m[1]]);
    await b.post(`/profiles/${kids.id}/addons`, [['base', baseHash], ...refs, ['name:__proto__:redirect', 'https://evil.example/'], ['name:constructor:x', 'y']]);
    assert.equal(({}).redirect, undefined, 'Object.prototype untouched');
    const after = await b.post(`/profiles/${kids.id}/switch`);
    assert.doesNotMatch(String(after.location), /evil/);
  });

  it('Cinemeta switches save and warn when details pages have no other source', async () => {
    const kids = repo().listProfiles().find((p) => p.name === 'Kids');
    const manager = (await b.request(`/profiles/${kids.id}/addons`)).text;
    const baseHash = manager.match(/name="base" value="([0-9a-f]+)"/)[1];
    await b.post(`/profiles/${kids.id}/cinemeta`, { base: baseHash, popular: '1', new: '1', featured: '1', search: '1' });
    const cm = saved(kids.id).addons.find((a) => a.manifest.name === 'Cinemeta').manifest;
    assert.ok(!cm.resources.includes('meta'));
    assert.ok(cm.catalogs.some((c) => c.id === 'year'), 'New back, from the stock copy');
    const page = (await b.request(`/profiles/${kids.id}/addons`)).text;
    assert.match(page, /Saved Kids&#39;s Cinemeta/);
  });

  it('a shared server says who runs it and what it keeps; the privacy page is public', async () => {
    const shared = createApp({
      config: { publicUrl: 'https://profiles.example.com', trustProxy: false },
      db: ctx.db, accounts: ctx.accounts, log: silentLogger,
      settings: new Settings({ db: ctx.db, env: { ACCESS: 'open', OPERATOR: 'kgenovz', PRIVACY_NOTE: 'The web proxy keeps no access logs.' } }),
    }).listen(0);
    await new Promise((resolve) => shared.once('listening', resolve));
    const other = `http://127.0.0.1:${shared.address().port}`;
    try {
      const signin = await (await fetch(`${other}/signin`)).text();
      assert.match(signin, /A shared server, run by kgenovz/);
      assert.match(signin, /href="\/privacy"/);
      assert.match(signin, /github\.com\/kgenovz\/openprofiles/);
      const privacy = await fetch(`${other}/privacy`);
      assert.equal(privacy.status, 200, 'no sign-in needed');
      const text = await privacy.text();
      assert.match(text, /Not your password/);
      assert.match(text, /The web proxy keeps no access logs/);
      assert.match(text, /An account nobody uses for 90 days/);
    } finally {
      shared.close();
    }
    // A self-hosted (owner) server doesn't show the shared note.
    assert.doesNotMatch(await (await fetch(`${base}/signin?again=1`)).text(), /A shared server/);
  });

  it('the backups page shows the newest few of each group and folds the rest', async () => {
    const service = ctx.accounts.forAccount(1);
    for (let i = 1; i <= 7; i++) await service.createBackup(`Mine ${i}`);
    const page = (await b.request('/backups')).text;
    const mine = page.slice(page.indexOf('Made by you'));
    const group = mine.slice(0, mine.indexOf('</details>'));
    assert.match(group, /Show older \(2\)/);
    assert.ok(group.indexOf('Mine 7') < group.indexOf('Show older'), 'the newest is shown');
    assert.ok(group.indexOf('Mine 1') > group.indexOf('Show older'), 'the oldest is folded');
  });

  it('looks up an add-on by link for the page, behind the CSRF check', async () => {
    ctx.web.manifests.set('https://youtube.example/manifest.json', richAddon('YouTube').manifest);
    const noToken = await fetch(`${base}/addons/lookup`, { method: 'POST', headers: { cookie: b.cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noToken.status, 403);
    const ok = await b.postJson('/addons/lookup', { url: 'https://youtube.example/manifest.json', for: 'manager' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.name, 'YouTube');
    assert.match(ok.body.html, /name="ref" value="[0-9a-f]{16}"/);
    assert.ok(!ok.body.html.includes('youtube.example/manifest.json'), 'the link itself stays on the server');
    const bad = await b.postJson('/addons/lookup', { url: 'http://192.168.1.5/manifest.json' });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error);

    // A long configured add-on link is taken; one too long gets a plain answer. (Seen live: a
    // configured add-on's link over 8 KB was refused with an HTML error page.)
    const long = `https://configured.example/${'c'.repeat(20_000)}/manifest.json`;
    ctx.web.manifests.set(long, richAddon('Configured').manifest);
    const longOk = await b.postJson('/addons/lookup', { url: long, for: 'manager' });
    assert.equal(longOk.status, 200);
    assert.equal(longOk.body.name, 'Configured');

    const huge = await b.postJson('/addons/lookup', { url: `https://x.example/${'c'.repeat(70_000)}/manifest.json` });
    assert.equal(huge.status, 413);
    assert.match(huge.body.error, /add-on link is too long: OpenProfiles takes links up to 64 KB/);
  });
});
