import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { silentLogger } from '../src/log.js';
import { createApp } from '../src/web/app.js';
import { makeService, seededFake } from './helpers/setup.js';

const PASSWORD = 'correct horse battery';

/** Minimal cookie-keeping client for the test server. */
class Browser {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async request(path, { method = 'GET', form } = {}) {
    const res = await fetch(this.base + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, text: await res.text() };
  }

  async csrf() {
    const page = await this.request('/configure');
    return page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  }

  async post(path, fields = {}) {
    return this.request(path, { method: 'POST', form: { _csrf: await this.csrf(), ...fields } });
  }

  async signIn() {
    return this.request('/login', { method: 'POST', form: { password: PASSWORD } });
  }
}

describe('web', () => {
  let server;
  let base;
  let ctx;

  before(async () => {
    ctx = makeService({ fake: seededFake() });
    const config = { publicUrl: 'http://localhost', adminPassword: PASSWORD, trustProxy: false };
    const app = createApp({ config, db: ctx.db, service: ctx.service, log: silentLogger });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  it('sends signed-out visitors to the login page', async () => {
    const res = await new Browser(base).request('/configure');
    assert.equal(res.status, 303);
    assert.equal(res.location, '/login');
  });

  it('rejects a wrong password and sets a strict, http-only cookie on success', async () => {
    const b = new Browser(base);
    const bad = await b.request('/login', { method: 'POST', form: { password: 'nope' } });
    assert.equal(bad.status, 401);
    const good = await b.signIn();
    assert.equal(good.status, 303);
    const cookie = good.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  it('rejects POSTs without the CSRF token', async () => {
    const b = new Browser(base);
    await b.signIn();
    const res = await b.request('/profiles', { method: 'POST', form: { name: 'X', from: 'empty' } });
    assert.equal(res.status, 403);
  });

  it('walks through setup, creating a profile and switching', async () => {
    const b = new Browser(base);
    await b.signIn();
    assert.match((await b.request('/configure')).text, /Connect your Stremio account/);

    await b.post('/account/link', { email: 'kyle@example.com', password: 'hunter22' });
    let page = (await b.request('/configure')).text;
    assert.match(page, /Saved as the &quot;Original&quot; profile|saved as the &quot;Original&quot; profile/i);
    assert.match(page, /Original/);
    assert.ok(!page.includes('hunter22'), 'the Stremio password never appears');

    await b.post('/profiles', { name: 'Kids <script>', from: 'empty', colour: '#e5484d' });
    page = (await b.request('/configure')).text;
    assert.ok(page.includes('Kids &lt;script&gt;'), 'names are escaped');
    assert.ok(!page.includes('Kids <script>'));

    const kids = ctx.repo.listProfiles().find((p) => p.name.startsWith('Kids'));
    await b.post(`/profiles/${kids.id}/switch`);
    page = (await b.request('/configure')).text;
    assert.match(page, /Switched to/);
    assert.equal(ctx.repo.getState().active_profile_id, kids.id);
  });

  it('shows service errors as a flash message', async () => {
    const b = new Browser(base);
    await b.signIn();
    const active = ctx.repo.getState().active_profile_id;
    await b.post(`/profiles/${active}/delete`);
    const page = (await b.request('/configure')).text;
    assert.match(page, /flash-error/);
    assert.match(page, /is the profile in use/);
  });

  it('downloads a backup as JSON without caching', async () => {
    const b = new Browser(base);
    await b.signIn();
    const backup = ctx.repo.listBackups().find((x) => x.kind === 'original');
    const res = await b.request(`/backups/${backup.id}/download`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-disposition'), /attachment/);
    assert.equal(JSON.parse(res.text).format, 'openprofiles-backup');
  });

  it('rate-limits repeated wrong passwords', async () => {
    const b = new Browser(base);
    let last;
    for (let i = 0; i < 12; i++) last = await b.request('/login', { method: 'POST', form: { password: 'wrong' } });
    assert.equal(last.status, 429);
    const blocked = await b.request('/login', { method: 'POST', form: { password: PASSWORD } });
    assert.equal(blocked.status, 429, 'even the right password is refused while limited');
  });
});
