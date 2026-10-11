import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GuardError } from '../src/core/guard.js';
import { NATIVE_PROFILES_WARNING, UserError } from '../src/core/service.js';
import { addon, libItem, notif } from './helpers/fakeStremio.js';
import { linkedWithKids, makeService, seededFake } from './helpers/setup.js';

describe('linkAccount', () => {
  it('creates "Original" from the live account plus the permanent original backup', async () => {
    const { service, repo, fake } = makeService({ fake: seededFake() });
    const { created } = await service.linkAccount('kyle@example.com', 'hunter22');
    assert.equal(created, true);
    const [original] = repo.listProfiles();
    assert.equal(original.name, 'Original');
    assert.equal(original.library_count, 2);
    assert.equal(original.addon_count, 2);
    assert.equal(original.notif_count, 1);
    assert.equal(repo.getState().active_profile_id, original.id);
    assert.deepEqual(repo.listBackups().map((b) => b.kind), ['original']);
    assert.equal(fake.callCount('datastorePut'), 0, 'setup never writes to Stremio');
    assert.equal(fake.callCount('addonCollectionSet'), 0);
  });

  it('refuses a child-profile key and warns about native profiles', async () => {
    const child = makeService({ fake: seededFake() });
    child.fake.user.parent_id = 'master';
    await assert.rejects(child.service.linkAccount('kyle@example.com', 'hunter22'), (e) => e.code === 'CHILD_PROFILE');

    const supporter = makeService({ fake: seededFake() });
    supporter.fake.user.premiumPrefs = { userProfiles: { 'user-1': { name: 'Me' }, p2: { name: 'Kid' } } };
    const { warnings } = await supporter.service.linkAccount('kyle@example.com', 'hunter22');
    assert.deepEqual(warnings, [NATIVE_PROFILES_WARNING]);
  });

  it('renews the key for the same account and refuses a different account', async () => {
    const { service, repo, fake } = makeService({ fake: seededFake() });
    await service.linkAccount('kyle@example.com', 'hunter22');
    fake.authKey = 'n'.repeat(40);
    const { created } = await service.linkAccount('kyle@example.com', 'hunter22');
    assert.equal(created, false);
    assert.equal(repo.getAuthKey(), 'n'.repeat(40));
    assert.equal(repo.listProfiles().length, 1);

    fake.user._id = 'someone-else';
    await assert.rejects(service.linkAccount('kyle@example.com', 'hunter22'), (e) => e.code === 'OTHER_ACCOUNT');
  });
});

describe('switchTo', () => {
  it('swaps library, add-ons and notifications, saves the outgoing profile and flips the pointer', async () => {
    const { service, repo, fake, kids, original } = await linkedWithKids();
    // Changes made in Stremio since setup must land in "Original" on the way out.
    fake.seed({ library: [libItem('tt-new', { lastWatched: '2026-10-09T00:00:00.000Z' })] });
    fake.addons.push(addon('extra'));

    const result = await service.switchTo(kids.id);
    assert.equal(result.alreadyActive, false);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(fake.activeIds(), [], 'Kids starts empty');
    assert.equal(fake.addons.length, 2, "Kids gets its own add-ons; the one added in Original stays there");
    assert.ok([...fake.notifs.values()].every((n) => n.dismissed && n.seen && n.delivered));
    for (const item of fake.library.values()) {
      assert.equal(item.temp, false);
      assert.equal(item.state.lastWatched, '');
    }
    assert.equal(repo.getState().active_profile_id, kids.id);

    const savedOriginal = repo.getProfile(original.id);
    assert.equal(savedOriginal.library_count, 3, 'outgoing profile includes the newly added show');
    assert.equal(savedOriginal.addon_count, 3);

    const journal = repo.recentJournal(1)[0];
    assert.equal(journal.status, 'finished');
    assert.ok(repo.listBackups().some((b) => b.kind === 'pre_switch' && b.library_count === 3));
  });

  it('round-trips back with resume positions and Continue Watching intact', async () => {
    const { service, fake, kids, original } = await linkedWithKids();
    const before = structuredClone(fake.library.get('tt-a'));
    await service.switchTo(kids.id);
    await service.switchTo(original.id);
    const after = fake.library.get('tt-a');
    assert.equal(after.removed, false);
    assert.equal(after.temp, true);
    assert.deepEqual(after.state, before.state);
    assert.deepEqual(fake.activeIds(), ['tt-a', 'tt-b']);
    const restoredNotif = fake.notifs.get('tt-a 1 3');
    assert.equal(restoredNotif.dismissed, false);
  });

  it('things added in Kids stay in Kids', async () => {
    const { service, repo, fake, kids, original } = await linkedWithKids();
    await service.switchTo(kids.id);
    fake.seed({ library: [libItem('tt-kids-show')] });
    await service.switchTo(original.id);
    assert.deepEqual(fake.activeIds(), ['tt-a', 'tt-b']);
    assert.equal(repo.getProfile(kids.id).library_count, 1);
    await service.switchTo(kids.id);
    assert.deepEqual(fake.activeIds(), ['tt-kids-show']);
  });

  it('is idempotent: switching to the active profile makes no API calls', async () => {
    const { service, fake, original } = await linkedWithKids();
    const calls = fake.calls.length;
    const result = await service.switchTo(original.id);
    assert.equal(result.alreadyActive, true);
    assert.equal(fake.calls.length, calls);
  });

  it('two overlapping requests for the same profile switch once', async () => {
    const { service, fake, kids } = await linkedWithKids();
    const [a, b] = await Promise.all([service.switchTo(kids.id), service.switchTo(kids.id)]);
    assert.equal(a.alreadyActive, false);
    assert.equal(b.alreadyActive, true);
    assert.equal(fake.callCount('addonCollectionSet') + fake.callCount('datastorePut', 'libraryItem') > 0, true);
  });

  it('refuses a profile anchored to a different Stremio account before writing anything', async () => {
    const { service, db, fake, kids } = await linkedWithKids();
    db.prepare('UPDATE profiles SET stremio_user_id = ? WHERE id = ?').run('other-account', kids.id);
    const before = fake.calls.length;
    await assert.rejects(service.switchTo(kids.id), (e) => e instanceof GuardError && e.code === 'WRONG_ACCOUNT');
    assert.equal(fake.calls.slice(before).filter((c) => /Put|Set/.test(c.method)).length, 0);
  });

  it('refuses a target whose snapshot is unreadable, with no writes and no journal', async () => {
    const { service, db, repo, fake, kids } = await linkedWithKids();
    db.prepare('UPDATE profiles SET library_enc = ? WHERE id = ?').run(Buffer.from('broken'), kids.id);
    await assert.rejects(service.switchTo(kids.id), (e) => e.code === 'UNREADABLE');
    assert.equal(fake.callCount('datastorePut'), 0);
    assert.equal(repo.recentJournal().length, 0);
  });

  it('aborts with nothing changed when the live library read fails', async () => {
    const { service, repo, fake, kids, original } = await linkedWithKids();
    fake.failWhen((m, b) => m === 'datastoreGet' && b.collection === 'libraryItem', { error: { code: 99, message: 'nope' } });
    await assert.rejects(service.switchTo(kids.id));
    assert.equal(repo.getState().active_profile_id, original.id);
    assert.equal(repo.recentJournal().length, 0);
    assert.equal(fake.callCount('datastorePut'), 0);
  });

  it('a failed notification read keeps the saved notifications and skips the notification swap', async () => {
    const { service, repo, fake, kids, original } = await linkedWithKids();
    fake.failWhen((m) => m === 'datastoreMeta', { error: { code: 99, message: 'nope' } });
    const result = await service.switchTo(kids.id);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /Notifications weren't swapped/);
    assert.equal(repo.getProfile(original.id).notif_count, 1, 'old notification snapshot kept, not replaced with []');
    assert.equal(fake.callCount('datastorePut', 'notifItem'), 0);
  });

  it('an add-on write failure is recorded and the switch still completes', async () => {
    const { service, repo, fake, kids } = await linkedWithKids();
    fake.addons.push(addon('extra')); // make the lists differ so a write is needed
    fake.failWhen((m) => m === 'addonCollectionSet', { error: { code: 99, message: 'nope' } });
    const result = await service.switchTo(kids.id);
    assert.match(result.warnings[0], /Add-ons weren't swapped/);
    assert.equal(repo.getState().active_profile_id, kids.id);
    assert.deepEqual(repo.recentJournal(1)[0].warnings, result.warnings);
  });

  it('refuses when the live library is over the cap', async () => {
    const { service, fake, kids } = await linkedWithKids();
    fake.seed({ library: Array.from({ length: 10001 }, (_, i) => libItem(`tt${i}`)) });
    await assert.rejects(service.switchTo(kids.id), (e) => e instanceof UserError && e.code === 'TOO_LARGE');
    assert.equal(fake.callCount('datastorePut'), 0);
  });

  it('writes the library in chunks of 150', async () => {
    const { service, fake, kids } = await linkedWithKids();
    fake.seed({ library: Array.from({ length: 400 }, (_, i) => libItem(`tt${i}`)) });
    await service.switchTo(kids.id);
    const puts = fake.calls.filter((c) => c.method === 'datastorePut' && c.body.collection === 'libraryItem');
    assert.deepEqual(puts.map((c) => c.body.changes.length), [150, 150, 102]);
  });

  it('maps an expired sign-in to a clear message', async () => {
    const { service, fake, kids } = await linkedWithKids();
    fake.authKey = 'rotated'.repeat(6);
    await assert.rejects(service.switchTo(kids.id), (e) => e.kind === 'auth' && /Sign in again/.test(e.userMessage));
  });
});

describe('profile management', () => {
  it('creates from current, renames, recolours and deletes', async () => {
    const { service, repo, kids } = await linkedWithKids();
    const copy = await service.createProfile({ name: 'Copy', from: 'current' });
    assert.equal(copy.library_count, 2);
    service.renameProfile(copy.id, '  Movie   night ');
    assert.equal(repo.getProfile(copy.id).name, 'Movie night');
    service.setAvatar(copy.id, '#e5484d');
    assert.equal(repo.getProfile(copy.id).avatar_colour, '#e5484d');
    assert.throws(() => service.renameProfile(copy.id, 'kids'), (e) => e.code === 'NAME_TAKEN');
    await assert.rejects(service.createProfile({ name: 'KIDS' }), (e) => e.code === 'NAME_TAKEN');
    await service.deleteProfile(kids.id);
    assert.equal(repo.getProfile(kids.id), null);
  });

  it('will not delete the active profile', async () => {
    const { service, original } = await linkedWithKids();
    await assert.rejects(service.deleteProfile(original.id), (e) => e.code === 'ACTIVE');
  });

  it('save now captures the live state into the active profile', async () => {
    const { service, repo, fake, original } = await linkedWithKids();
    fake.seed({ library: [libItem('tt-later')], notifs: [notif('x 1 1')] });
    const { profile } = await service.saveNow();
    assert.equal(profile.id, original.id);
    assert.equal(repo.getProfile(original.id).library_count, 3);
    assert.equal(repo.getProfile(original.id).notif_count, 2);
  });
});
