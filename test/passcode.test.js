import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { posterSvg } from '../src/addon/art.js';
import { CATALOG_TYPE } from '../src/addon/manifest.js';
import { MAX_WRONG_CODES, WRONG_CODE_WAIT_MS, checkPasscode, hashPasscode, isPasscode, isPasscodeHash } from '../src/core/passcode.js';
import { createLogger } from '../src/log.js';
import { createApp } from '../src/web/app.js';
import { Browser } from './helpers/browser.js';
import { PUBLIC_URL, linkedWithKids, makeService, seededFake } from './helpers/setup.js';

const ANDROID = 'Mozilla/5.0 (Linux; Android 15; SM-S901W) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0';

const refusedWith = (code) => (err) => err.code === code;

describe('passcode hashes', () => {
  it('only 4 digits are a passcode, and only the hash is kept', async () => {
    for (const ok of ['0000', '4821']) assert.ok(isPasscode(ok), ok);
    for (const bad of ['', '123', '12345', 'abcd', '12 4', 1234, null]) assert.ok(!isPasscode(bad), String(bad));
    const hash = await hashPasscode('4821');
    assert.ok(isPasscodeHash(hash));
    assert.ok(!hash.includes('4821'));
    assert.notEqual(hash, await hashPasscode('4821'), 'salted: the same code hashes differently each time');
    assert.equal(await checkPasscode('4821', hash), true);
    assert.equal(await checkPasscode('4822', hash), false);
    assert.equal(await checkPasscode('4821', 'not a hash'), false);
  });
});

describe('passcodes in the service', () => {
  it('setting one needs nothing; changing or removing it needs the current one, unless just signed in', async () => {
    const { service, repo, kids } = await linkedWithKids();
    assert.equal((await service.setPasscode(kids.id, { code: '4821' })).kind, 'set');
    assert.ok(repo.getProfile(kids.id).has_passcode);
    await assert.rejects(service.setPasscode(kids.id, { code: '1111' }), refusedWith('PASSCODE_NEEDED'));
    await assert.rejects(service.setPasscode(kids.id, { code: '1111', current: '0000' }), refusedWith('WRONG_PASSCODE'));
    await assert.rejects(service.setPasscode(kids.id, { code: null, current: '0000' }), refusedWith('WRONG_PASSCODE'));
    await assert.rejects(service.setPasscode(kids.id, { code: '12a4', current: '4821' }), refusedWith('BAD_PASSCODE'));
    assert.equal((await service.setPasscode(kids.id, { code: '1111', current: '4821' })).kind, 'change');
    assert.equal((await service.setPasscode(kids.id, { code: '2222', fresh: true })).kind, 'change', 'a fresh sign-in resets it');
    assert.equal((await service.setPasscode(kids.id, { code: null, current: '2222' })).kind, 'remove');
    assert.ok(!repo.getProfile(kids.id).has_passcode);
    const log = repo.listActivity(10).map((a) => a.detail);
    assert.ok(log.includes('Locked "Kids" with a passcode'));
    assert.ok(log.includes('Changed the passcode of "Kids" (after signing in again)'));
    assert.ok(log.includes('Removed the passcode of "Kids"'));
  });

  it('switching to a locked profile needs its code, every time; switching away never does', async () => {
    const { service, repo, fake, kids, original } = await linkedWithKids();
    await service.setPasscode(kids.id, { code: '4821' });
    const calls = fake.calls.length;
    await assert.rejects(service.switchTo(kids.id), refusedWith('PASSCODE_NEEDED'));
    await assert.rejects(service.switchTo(kids.id, { passcode: '0000' }), refusedWith('WRONG_PASSCODE'));
    assert.equal(fake.calls.length, calls, 'no trip to Stremio without the right code');
    assert.equal(repo.getState().active_profile_id, original.id);

    await service.switchTo(kids.id, { passcode: '4821', via: 'stremio' });
    assert.equal(repo.getState().active_profile_id, kids.id);
    assert.ok(repo.listActivity(5).some((a) => a.detail === 'Unlocked "Kids" from Stremio'));
    assert.equal((await service.switchTo(kids.id)).alreadyActive, true, 'the profile in use needs no code');

    await service.setPasscode(original.id, { code: '9999' });
    await service.setPasscode(original.id, { code: null, current: '9999' });
    await service.switchTo(original.id);
    assert.equal(repo.getState().active_profile_id, original.id, 'away from a locked profile: no code');
    await assert.rejects(service.switchTo(kids.id), refusedWith('PASSCODE_NEEDED'), 'an unlock was good for one switch');
  });

  it(`${MAX_WRONG_CODES} wrong codes in a row refuse codes for a while; a right one starts the count again`, async () => {
    const ctx = await linkedWithKids();
    const { service, kids, original } = ctx;
    await service.setPasscode(kids.id, { code: '4821' });
    await service.setPasscode(original.id, { code: '1234' });
    for (let i = 0; i < MAX_WRONG_CODES - 1; i++) {
      await assert.rejects(service.switchTo(kids.id, { passcode: '0000' }), refusedWith('WRONG_PASSCODE'));
    }
    // A right code, on any profile, starts the count again.
    await service.setPasscode(original.id, { code: '5555', current: '1234' });
    for (let i = 0; i < MAX_WRONG_CODES - 1; i++) {
      await assert.rejects(service.switchTo(kids.id, { passcode: '0000' }), refusedWith('WRONG_PASSCODE'));
    }
    // Counted per account, whichever profile or page the code was for.
    await assert.rejects(service.setPasscode(original.id, { code: '6666', current: '0000' }), refusedWith('PASSCODE_WAIT'));
    await assert.rejects(service.switchTo(kids.id, { passcode: '4821' }), refusedWith('PASSCODE_WAIT'), 'even the right code waits');
    ctx.advance(WRONG_CODE_WAIT_MS);
    await service.switchTo(kids.id, { passcode: '4821' });
    assert.equal(ctx.repo.getState().active_profile_id, kids.id);
    assert.ok(ctx.repo.listActivity(10).some((a) => /wrong passcodes in a row/.test(a.detail)));
  });

  it('"Download everything" carries the hash, and bringing it back keeps the lock', async () => {
    const { service, repo, kids } = await linkedWithKids();
    await service.setPasscode(kids.id, { code: '4821' });
    const file = service.exportEverything(null);
    const exported = file.profiles.find((p) => p.name === 'Kids');
    assert.equal(exported.passcode_hash, repo.getPasscodeHash(kids.id));
    assert.ok(!JSON.stringify(file).includes('4821'));
    file.profiles.find((p) => p.name === 'Original').passcode_hash = 'nonsense';

    const other = makeService({ fake: seededFake() });
    await other.signIn();
    await other.service.importEverything(file, {});
    const back = other.repo.listProfiles().find((p) => p.name.startsWith('Kids'));
    assert.ok(back.has_passcode);
    await assert.rejects(other.service.switchTo(back.id, { passcode: '0000' }), refusedWith('WRONG_PASSCODE'));
    const original = other.repo.listProfiles().find((p) => p.name.startsWith('Original ('));
    assert.ok(!original.has_passcode, 'a hash this build can\'t check is dropped');
  });
});

describe('passcodes over HTTP', () => {
  let server;
  let base;
  let ctx;
  let token;
  const lines = [];
  const log = createLogger('debug', { log: (l) => lines.push(l), error: (l) => lines.push(l) });

  before(async () => {
    ctx = makeService({ fake: seededFake(), withAddon: true });
    await ctx.signIn();
    ctx.kids = await ctx.service.createProfile({ name: 'Kids', from: 'empty' });
    ctx.original = ctx.repo.listProfiles().find((p) => p.name === 'Original');
    const config = { publicUrl: PUBLIC_URL, trustProxy: false };
    server = createApp({ config, db: ctx.db, accounts: ctx.accounts, settings: ctx.settings, log }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  beforeEach(async () => {
    // Every test starts in Original, with Kids locked (4821) and no wrong codes counted.
    ctx.service.wrongCodes = { count: 0, until: 0 };
    for (const p of ctx.repo.listProfiles()) ctx.repo.setPasscodeHash(p.id, null);
    if (ctx.repo.getState().active_profile_id !== ctx.original.id) await ctx.service.switchTo(ctx.original.id);
    ctx.repo.setPasscodeHash(ctx.kids.id, await hashPasscode('4821'));
    token = ctx.repo.getState().addon_token;
  });

  const get = (path, ua = undefined) => fetch(base + path, { redirect: 'manual', headers: ua ? { 'user-agent': ua } : {} });
  const post = (path, form, ua = undefined) => fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(ua ? { 'user-agent': ua } : {}) },
    body: new URLSearchParams(form).toString(),
  });
  const nonceOf = (page) => page.match(/name="nonce" value="([^"]+)"/)[1];
  const unlockPath = () => `/${token}/unlock/${ctx.kids.id}`;
  const active = () => ctx.repo.getState().active_profile_id;

  it("opening a locked profile in Stremio doesn't switch: it offers Unlock and Refresh", async () => {
    const path = `/${token}/stream/${CATALOG_TYPE}/${encodeURIComponent(`openprofiles:${ctx.kids.id}`)}.json`;
    const calls = ctx.fake.calls.length;
    const { streams } = await (await get(path)).json();
    assert.equal(active(), ctx.original.id);
    assert.equal(ctx.fake.calls.length, calls, 'no trip to Stremio');
    assert.equal(streams.length, 2);
    for (const s of streams) assert.equal(s.title, undefined, 'description only (stremio-core reads title as a duplicate)');
    const [unlock, refresh] = streams;
    assert.match(unlock.description, /^Kids is locked\n/);
    assert.equal(unlock.externalUrl, `${PUBLIC_URL}${unlockPath()}`);
    assert.match(refresh.description, /refresh Stremio/);
    assert.equal(refresh.externalUrl, 'stremio:///library', 'the Android app: deep link');
    const desktop = await (await get(path, WINDOWS)).json();
    assert.equal(desktop.streams[1].externalUrl, `${PUBLIC_URL}/refresh/go?to=auto`);

    const meta = await (await get(`/${token}/meta/other/openprofiles:${ctx.kids.id}.json`)).json();
    assert.match(meta.meta.description, /Locked/);
    const { metas } = await (await get(`/${token}/catalog/${CATALOG_TYPE}/openprofiles.json`)).json();
    const kidsPoster = metas.find((m) => m.name === 'Kids').poster;
    ctx.repo.setPasscodeHash(ctx.kids.id, null);
    const unlocked = await (await get(`/${token}/catalog/${CATALOG_TYPE}/openprofiles.json`)).json();
    assert.notEqual(unlocked.metas.find((m) => m.name === 'Kids').poster, kidsPoster, 'the poster changes with the lock');
    assert.notEqual(posterSvg({ name: 'Kids', colour: '#0a7fe0', locked: true }), posterSvg({ name: 'Kids', colour: '#0a7fe0' }));
  });

  it('the unlock page switches with the right code and sends Android back to Library', async () => {
    const page = await get(unlockPath(), ANDROID);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Kids is locked/);
    assert.match(html, /inputmode="numeric"/);
    assert.match(html, new RegExp(`src="/${token}/avatars/profile/${ctx.kids.id}\\.svg`));
    assert.equal((await get(`/${token}/avatars/profile/${ctx.kids.id}.svg`)).status, 200);

    const res = await post(unlockPath(), { nonce: nonceOf(html), passcode: '4821' }, ANDROID);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `${unlockPath()}/done`);
    assert.equal(active(), ctx.kids.id);
    const done = await (await get(`${unlockPath()}/done`, ANDROID)).text();
    assert.match(done, /<meta http-equiv="refresh" content="0;url=stremio:\/\/\/library">/);
    assert.match(done, /href="stremio:\/\/\/library"[^>]*>Back to Stremio</);
    assert.ok(ctx.repo.listActivity(5).some((a) => a.detail === 'Unlocked "Kids" from Stremio'));

    // Stremio asking for the stream again, now Kids is in use: no code.
    const { streams } = await (await get(`/${token}/stream/${CATALOG_TYPE}/openprofiles:${ctx.kids.id}.json`)).json();
    assert.match(streams[0].description, /^Kids is in use/);
    assert.match(await (await get(unlockPath())).text(), /Kids is in use/);
  });

  it('a desktop browser goes back to Home', async () => {
    const html = await (await get(unlockPath(), WINDOWS)).text();
    await post(unlockPath(), { nonce: nonceOf(html), passcode: '4821' }, WINDOWS);
    assert.equal(active(), ctx.kids.id);
    const done = await (await get(`${unlockPath()}/done`, WINDOWS)).text();
    assert.match(done, /content="0;url=stremio:\/\/\/"/);
  });

  it("a wrong code, a missing or used nonce, or a bad token don't switch", async () => {
    const html = await (await get(unlockPath())).text();
    const wrong = await post(unlockPath(), { nonce: nonceOf(html), passcode: '0000' });
    assert.equal(wrong.status, 403);
    const again = await wrong.text();
    assert.match(again, /passcode isn&#39;t right/);
    assert.equal(active(), ctx.original.id);

    assert.equal((await post(unlockPath(), { passcode: '4821' })).status, 403, 'no nonce');
    assert.equal((await post(unlockPath(), { nonce: nonceOf(html), passcode: '4821' })).status, 403, 'nonce already used');
    assert.equal((await post(`/${token}/unlock/${ctx.original.id}`, { nonce: nonceOf(again), passcode: '4821' })).status, 403, "another profile's nonce");
    assert.equal(active(), ctx.original.id);

    const bad = 'x'.repeat(32);
    assert.equal((await get(`/${bad}/unlock/${ctx.kids.id}`)).status, 404);
    assert.equal((await post(`/${bad}/unlock/${ctx.kids.id}`, { nonce: nonceOf(again), passcode: '4821' })).status, 404);
    assert.equal((await get(`/${token}/unlock/999`)).status, 404);
    assert.equal((await get(`/${bad}/avatars/profile/${ctx.kids.id}.svg`)).status, 404);
    assert.equal(active(), ctx.original.id);
  });

  it(`wrong codes count across the unlock page and the web page: ${MAX_WRONG_CODES} in a row and it waits`, async () => {
    const b = new Browser(base);
    await b.signIn();
    for (let i = 0; i < 3; i++) {
      assert.equal((await b.post(`/profiles/${ctx.kids.id}/switch`, { passcode: '0000' })).status, 403);
    }
    let html = await (await get(unlockPath())).text();
    html = await (await post(unlockPath(), { nonce: nonceOf(html), passcode: '0000' })).text();
    const limited = await post(unlockPath(), { nonce: nonceOf(html), passcode: '0000' });
    assert.equal(limited.status, 429);
    const text = await limited.text();
    assert.match(text, /wait 15 minutes/);
    const right = await post(unlockPath(), { nonce: nonceOf(text), passcode: '4821' });
    assert.equal(right.status, 429, 'refused while waiting');
    assert.equal(active(), ctx.original.id);
  });

  it('switching on the web page asks for the code first, and works with it', async () => {
    const b = new Browser(base);
    await b.signIn();
    assert.match((await b.request('/configure')).text, /Kids <svg[^>]*inline-icon/, 'a padlock by the name');
    const first = await b.post(`/profiles/${ctx.kids.id}/switch`);
    assert.equal(first.status, 303);
    assert.equal(first.location, `/profiles/${ctx.kids.id}/unlock`);
    const page = await b.request(first.location);
    assert.match(page.text, /Kids is locked/);
    assert.match(page.text, new RegExp(`action="/profiles/${ctx.kids.id}/switch"`));
    assert.equal(active(), ctx.original.id);

    const ok = await b.post(`/profiles/${ctx.kids.id}/switch`, { passcode: '4821' });
    assert.equal(ok.status, 303);
    assert.equal(active(), ctx.kids.id);
    assert.match((await b.request('/configure')).text, /Switched to &quot;Kids&quot;/);

    // Kids in use: switching to it again asks nothing; away from it neither.
    assert.equal((await b.post(`/profiles/${ctx.kids.id}/switch`)).location, '/configure');
    await b.post(`/profiles/${ctx.original.id}/switch`);
    assert.equal(active(), ctx.original.id);
    assert.equal((await b.post(`/profiles/${ctx.kids.id}/switch`)).location, `/profiles/${ctx.kids.id}/unlock`, 'asks again');
  });

  it('the editor changes or removes a passcode only with the current one, unless just signed in', async () => {
    const b = new Browser(base);
    await b.signIn();
    ctx.db.prepare('UPDATE sessions SET created_at = ?').run(Date.now() - 11 * 60 * 1000);
    const editor = (await b.request(`/profiles/${ctx.kids.id}`)).text;
    assert.match(editor, /id="passcode"/);
    assert.match(editor, /name="current"/);
    assert.match(editor, /href="\/signin\?again=1&amp;passcode=\d+"/, 'how to reset a forgotten one');

    const refused = await b.post(`/profiles/${ctx.kids.id}/passcode`, { passcode: '1111' });
    assert.equal(refused.location, `/profiles/${ctx.kids.id}#passcode`);
    assert.match((await b.request(`/profiles/${ctx.kids.id}`)).text, /Enter Kids&#39;s passcode/);
    await b.post(`/profiles/${ctx.kids.id}/passcode`, { remove: '1', current: '0000' });
    assert.ok(ctx.repo.getProfile(ctx.kids.id).has_passcode);
    await b.post(`/profiles/${ctx.kids.id}/passcode`, { passcode: '1111', current: '4821' });
    assert.equal(await checkPasscode('1111', ctx.repo.getPasscodeHash(ctx.kids.id)), true);

    // Signing in again with the Stremio password: back to the editor, and no current code needed.
    const signin = (await b.request(`/signin?again=1&passcode=${ctx.kids.id}`)).text;
    assert.match(signin, /set a new passcode without the old one/);
    assert.match(signin, new RegExp(`name="passcodeFor" value="${ctx.kids.id}"`));
    const back = await b.request('/signin', { method: 'POST', form: { email: 'kyle@example.com', password: 'hunter22', passcodeFor: String(ctx.kids.id) } });
    assert.equal(back.location, `/profiles/${ctx.kids.id}#passcode`);
    const fresh = (await b.request(`/profiles/${ctx.kids.id}`)).text;
    assert.doesNotMatch(fresh, /name="current"/);
    assert.match(fresh, /signed in just now/);
    await b.post(`/profiles/${ctx.kids.id}/passcode`, { remove: '1' });
    assert.ok(!ctx.repo.getProfile(ctx.kids.id).has_passcode);

    // An unlocked profile: no "forgot it" line.
    assert.doesNotMatch((await b.request(`/profiles/${ctx.kids.id}`)).text, /Forgot it/);
    await b.post(`/profiles/${ctx.original.id}/passcode`, { passcode: '7777' });
    assert.ok(ctx.repo.getProfile(ctx.original.id).has_passcode, 'setting one needs no current code');
  });

  it('the hash and the codes never show in pages or the log', async () => {
    const b = new Browser(base);
    await b.signIn();
    await b.post(`/profiles/${ctx.kids.id}/switch`, { passcode: '0000' });
    await b.post(`/profiles/${ctx.kids.id}/switch`, { passcode: '4821' });
    await b.post(`/profiles/${ctx.kids.id}/passcode`, { passcode: '5937' });
    const hash = ctx.repo.getPasscodeHash(ctx.kids.id);
    const [, salt, key] = hash.split('$');
    const pages = await Promise.all(['/configure', `/profiles/${ctx.kids.id}`, `/profiles/${ctx.original.id}`, '/account', '/backups']
      .map(async (path) => (await b.request(path)).text));
    pages.push(await (await get(`/${token}/unlock/${ctx.original.id}`)).text());
    pages.push(JSON.stringify(await (await get(`/${token}/catalog/${CATALOG_TYPE}/openprofiles.json`)).json()));
    for (const text of [...pages, lines.join('\n')]) {
      for (const secret of [salt, key, '4821', '5937', 'passcode_hash']) assert.ok(!text.includes(secret), secret);
    }
    assert.ok(pages[3].includes('Changed the passcode of &quot;Kids&quot;'), 'the activity log says what happened');
  });
});
