import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StremioClient } from '../src/stremio/client.js';
import { StremioError } from '../src/stremio/errors.js';
import { FakeStremio, notif } from './helpers/fakeStremio.js';

function client(fake, sleeps = []) {
  return new StremioClient({ fetchImpl: fake.fetch, sleep: async (ms) => sleeps.push(ms) });
}

describe('StremioClient', () => {
  it('retries 529 and succeeds', async () => {
    const fake = new FakeStremio();
    fake.failWhen((m) => m === 'getUser', { status: 529 }, { times: 2 });
    const sleeps = [];
    const user = await client(fake, sleeps).getUser(fake.authKey);
    assert.equal(user.id, 'user-1');
    assert.equal(fake.callCount('getUser'), 3);
    assert.equal(sleeps.length, 2);
  });

  it('honours Retry-After', async () => {
    const fake = new FakeStremio();
    fake.failWhen((m) => m === 'getUser', { status: 429, headers: { 'retry-after': '3' } }, { times: 1 });
    const sleeps = [];
    await client(fake, sleeps).getUser(fake.authKey);
    assert.deepEqual(sleeps, [3000]);
  });

  it('gives up after 4 attempts with a "busy" error that has no response body in it', async () => {
    const fake = new FakeStremio();
    fake.failWhen((m) => m === 'getUser', { status: 503 });
    await assert.rejects(client(fake).getUser(fake.authKey), (err) => {
      assert.ok(err instanceof StremioError);
      assert.equal(err.kind, 'busy');
      assert.ok(!err.message.includes('secrets'));
      return true;
    });
    assert.equal(fake.callCount('getUser'), 4);
  });

  it('maps network failures to "unreachable"', async () => {
    const fake = new FakeStremio();
    fake.failWhen(() => true, { network: true });
    await assert.rejects(client(fake).getUser(fake.authKey), (err) => err.kind === 'unreachable');
  });

  it('maps a dead session to "auth" without retrying', async () => {
    const fake = new FakeStremio();
    await assert.rejects(client(fake).getUser('wrong-key'.repeat(5)), (err) => err.kind === 'auth');
    assert.equal(fake.callCount('getUser'), 1);
  });

  it('maps a bad login to "auth" without echoing what Stremio sent back', async () => {
    const fake = new FakeStremio();
    await assert.rejects(client(fake).login(fake.user.email, 'nope'), (err) => {
      assert.equal(err.kind, 'auth');
      assert.ok(!err.message.includes(fake.user.email));
      return true;
    });
  });

  it('reads notifications through datastoreMeta + ids', async () => {
    const fake = new FakeStremio().seed({ notifs: [notif('a 1 1'), notif('b 1 1')] });
    const items = await client(fake).getNotifs(fake.authKey);
    assert.deepEqual(items.map((i) => i._id).sort(), ['a 1 1', 'b 1 1']);
    assert.equal(fake.callCount('datastoreMeta'), 1);
  });
});
