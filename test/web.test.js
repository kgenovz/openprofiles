import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { silentLogger } from '../src/log.js';
import { createApp } from '../src/web/app.js';
import { Browser } from './helpers/browser.js';
import { makeService, seededFake } from './helpers/setup.js';

const STREMIO_PASSWORD = 'hunter22';

describe('web', () => {
  let server;
  let base;
  let ctx;
  const repo = () => ctx.accounts.forAccount(1).repo;

  before(async () => {
    ctx = makeService({ fake: seededFake() });
    const config = { publicUrl: 'http://localhost', trustProxy: false };
    const app = createApp({ config, db: ctx.db, accounts: ctx.accounts, settings: ctx.settings, log: silentLogger });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  it('sends signed-out visitors to the sign-in page', async () => {
    const res = await new Browser(base).request('/configure');
    assert.equal(res.status, 303);
    assert.equal(res.location, '/signin');
    const page = await new Browser(base).request('/signin');
    assert.match(page.text, /Sign in with Stremio/);
    assert.doesNotMatch(page.text, /Admin password/);
  });

  it('a wrong Stremio password is refused and creates nothing', async () => {
    const res = await new Browser(base).signIn('nope');
    assert.equal(res.status, 401);
    assert.match(res.text, /Stremio rejected that email or password/);
    assert.equal(ctx.accounts.accounts.count(), 0);
  });

  it('the first sign-in creates the account and lands on the page with a welcome', async () => {
    const b = new Browser(base);
    const res = await b.signIn();
    assert.equal(res.status, 303);
    assert.equal(res.location, '/configure');
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const page = (await b.request('/configure')).text;
    assert.match(page, /Welcome!/);
    assert.match(page, /Original/);
    assert.ok(!page.includes(STREMIO_PASSWORD), 'the Stremio password never appears');
  });

  it('rejects POSTs without the CSRF token', async () => {
    const b = new Browser(base);
    await b.signIn();
    const res = await b.request('/profiles', { method: 'POST', form: { name: 'X', from: 'empty' } });
    assert.equal(res.status, 403);
  });

  it('creates a profile (escaping its name) and switches to it', async () => {
    const b = new Browser(base);
    await b.signIn();
    await b.post('/profiles', { name: 'Kids <script>', from: 'empty', colour: '#e5484d' });
    let page = (await b.request('/configure')).text;
    assert.ok(page.includes('Kids &lt;script&gt;'), 'names are escaped');
    assert.ok(!page.includes('Kids <script>'));

    const kids = repo().listProfiles().find((p) => p.name.startsWith('Kids'));
    await b.post(`/profiles/${kids.id}/switch`);
    page = (await b.request('/configure')).text;
    assert.match(page, /Switched to/);
    assert.equal(repo().getState().active_profile_id, kids.id);
  });

  it('shows service errors as a flash message', async () => {
    const b = new Browser(base);
    await b.signIn();
    const active = repo().getState().active_profile_id;
    await b.post(`/profiles/${active}/delete`);
    const page = (await b.request('/configure')).text;
    assert.match(page, /flash-error/);
    assert.match(page, /is the profile in use/);
  });

  it('downloads a backup as JSON without caching', async () => {
    const b = new Browser(base);
    await b.signIn();
    const backup = repo().listBackups().find((x) => x.kind === 'original');
    const res = await b.request(`/backups/${backup.id}/download`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-disposition'), /attachment/);
    assert.equal(JSON.parse(res.text).format, 'openprofiles-backup');
  });

  it('import preview needs the CSRF header and answers bad files with a message', async () => {
    const b = new Browser(base);
    await b.signIn();
    const noToken = await fetch(`${base}/import/preview`, { method: 'POST', headers: { cookie: b.cookie }, body: '{}' });
    assert.equal(noToken.status, 403);
    const csrf = await b.csrf();
    const bad = await fetch(`${base}/import/preview`, {
      method: 'POST', headers: { cookie: b.cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: 'not json',
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /valid JSON/);
  });

  it('lists where you are signed in, and can sign the other places out', async () => {
    const phone = new Browser(base);
    await phone.signIn();
    const desk = new Browser(base);
    await desk.signIn();
    const page = (await desk.request('/account')).text;
    assert.match(page, /This device/);
    await desk.post('/account/sessions/others/signout');
    assert.equal((await phone.request('/configure')).status, 303, 'the other session is gone');
    assert.equal((await desk.request('/configure')).status, 200, 'this one stays');
  });

  it('deleting the account needs DELETE typed, then removes it and signs out', async () => {
    const b = new Browser(base);
    await b.signIn();
    await b.post('/account/delete', { confirm: 'nope' });
    assert.equal(ctx.accounts.accounts.count(), 1, 'not deleted without the confirmation');
    const res = await b.post('/account/delete', { confirm: 'DELETE' });
    assert.equal(res.location, '/signin?deleted=1');
    assert.match((await b.request(res.location)).text, /were deleted/);
    assert.equal(ctx.accounts.accounts.count(), 0);
    assert.equal((await b.request('/configure')).status, 303);
  });

  it('rate-limits repeated sign-in attempts', async () => {
    const b = new Browser(base);
    let last;
    for (let i = 0; i < 12; i++) last = await b.signIn('wrong');
    assert.equal(last.status, 429);
    const blocked = await b.signIn();
    assert.equal(blocked.status, 429, 'even the right password is refused while limited');
  });
});

// Its own server: the sign-ins here would otherwise count against the suite's per-address limit.
describe('where a sign-in may come from', () => {
  let server;
  let base;

  before(async () => {
    const ctx = makeService({ fake: seededFake() });
    server = createApp({ config: { publicUrl: 'http://localhost', trustProxy: false }, db: ctx.db, accounts: ctx.accounts, settings: ctx.settings, log: silentLogger }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  const signIn = (headers) => fetch(`${base}/signin`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ email: 'kyle@example.com', password: STREMIO_PASSWORD }),
  });

  it('its own page, the way browsers post it', async () => {
    // A form post from a page with a strict referrer policy says `Origin: null` (2026-10-12: this was refused).
    assert.equal((await signIn({ 'sec-fetch-site': 'same-origin', origin: 'null' })).status, 303);
    assert.equal((await signIn({ 'sec-fetch-site': 'same-origin', origin: base })).status, 303);
    assert.equal((await signIn({})).status, 303, 'no browser headers at all (scripts, old browsers)');
  });

  it('never another site', async () => {
    for (const headers of [
      { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      { 'sec-fetch-site': 'same-site', origin: 'https://other.example.com' },
      { 'sec-fetch-site': 'cross-site', origin: 'null' },
      { origin: 'https://evil.example' },
    ]) {
      const res = await signIn(headers);
      assert.equal(res.status, 403, JSON.stringify(headers));
      assert.match(await res.text(), /Sign in from this page/);
    }
  });

  it('pages send no referrer to other sites', async () => {
    const res = await fetch(`${base}/signin`);
    assert.equal(res.headers.get('referrer-policy'), 'same-origin');
    assert.match(await res.text(), /<meta name="referrer" content="same-origin">/);
  });
});
