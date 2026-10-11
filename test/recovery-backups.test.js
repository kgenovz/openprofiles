import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { libItem } from './helpers/fakeStremio.js';
import { linkedWithKids } from './helpers/setup.js';

/** Fail the Nth libraryItem write with a non-retriable error. */
function failLibraryPut(fake, nth, { times = 1 } = {}) {
  let seen = 0;
  fake.failWhen((m, b) => m === 'datastorePut' && b.collection === 'libraryItem' && ++seen === nth, { error: { code: 99, message: 'boom' } }, { times });
}

async function interruptedSwitch() {
  const ctx = await linkedWithKids();
  // 400 items so the library write takes three chunks; the second one fails.
  ctx.fake.seed({ library: Array.from({ length: 400 }, (_, i) => libItem(`tt${i}`)) });
  failLibraryPut(ctx.fake, 2);
  await assert.rejects(ctx.service.switchTo(ctx.kids.id), (e) => e.code === 'INTERRUPTED');
  return ctx;
}

describe('journal recovery', () => {
  it('an interrupted switch leaves an open journal, the pointer unflipped and the outgoing profile saved', async () => {
    const { repo, service, original, kids } = await interruptedSwitch();
    assert.equal(repo.getState().active_profile_id, original.id);
    const open = service.status().openJournal;
    assert.equal(open.kind, 'switch');
    assert.equal(open.fromName, 'Original');
    assert.equal(open.toName, 'Kids');
    assert.equal(open.phase, 'library');
    assert.match(open.error, /rejected/);
    assert.equal(repo.getProfile(original.id).library_count, 402);
    // Everything that would read or write live state is blocked until resolved.
    await assert.rejects(service.switchTo(kids.id), (e) => e.code === 'RECOVERY_NEEDED');
    await assert.rejects(service.saveNow(), (e) => e.code === 'RECOVERY_NEEDED');
    await assert.rejects(service.createBackup('x'), (e) => e.code === 'RECOVERY_NEEDED');
    await assert.rejects(service.deleteProfile(kids.id), (e) => e.code === 'RECOVERY_NEEDED');
  });

  it('"finish" completes the switch from the half-written state', async () => {
    const { repo, service, fake, kids } = await interruptedSwitch();
    await service.finishInterrupted();
    assert.deepEqual(fake.activeIds(), []);
    assert.equal(repo.getState().active_profile_id, kids.id);
    assert.equal(repo.getOpenJournal(), null);
    assert.equal(repo.recentJournal(1)[0].status, 'finished');
  });

  it('"go back" restores the pre-switch state and keeps the old profile active', async () => {
    const { repo, service, fake, original } = await interruptedSwitch();
    await service.rollbackInterrupted();
    assert.equal(fake.activeIds().length, 402);
    assert.equal(repo.getState().active_profile_id, original.id);
    assert.equal(repo.recentJournal(1)[0].status, 'rolled_back');
  });

  it('a failed recovery attempt leaves the journal open to try again', async () => {
    const { repo, service, fake, kids } = await interruptedSwitch();
    failLibraryPut(fake, 1);
    await assert.rejects(service.finishInterrupted(), (e) => e.code === 'INTERRUPTED');
    assert.ok(repo.getOpenJournal());
    await service.finishInterrupted();
    assert.equal(repo.getState().active_profile_id, kids.id);
  });

  it('pruning never removes the backup an open journal needs', async () => {
    const { repo } = await interruptedSwitch();
    const open = repo.getOpenJournal();
    for (let i = 0; i < 8; i++) {
      repo.insertBackup({ kind: 'pre_switch', label: `filler ${i}`, stremioUserId: 'user-1', snapshot: { library: [], addons: [], notifs: [] } });
    }
    repo.pruneBackups();
    assert.ok(repo.getBackup(open.rollback_backup_id));
  });
});

describe('backups', () => {
  it('restore writes the backup, takes a pre_restore backup and updates the active profile', async () => {
    const { service, repo, fake, original } = await linkedWithKids();
    const setup = repo.listBackups().find((b) => b.kind === 'original');
    fake.seed({ library: [libItem('tt-junk')] });
    await service.restoreBackup(setup.id);
    assert.deepEqual(fake.activeIds(), ['tt-a', 'tt-b']);
    assert.equal(repo.getProfile(original.id).library_count, 2);
    const pre = repo.listBackups().find((b) => b.kind === 'pre_restore');
    assert.equal(pre.library_count, 3);
    assert.equal(repo.recentJournal(1)[0].kind, 'restore');
  });

  it('refuses to restore a backup from another account', async () => {
    const { service, db, repo } = await linkedWithKids();
    const setup = repo.listBackups()[0];
    db.prepare('UPDATE backups SET stremio_user_id = ? WHERE id = ?').run('other', setup.id);
    await assert.rejects(service.restoreBackup(setup.id), (e) => e.code === 'WRONG_ACCOUNT');
  });

  it('keeps the original backup and enforces retention', async () => {
    const { service, repo, kids, original } = await linkedWithKids();
    for (let i = 0; i < 4; i++) {
      await service.switchTo(kids.id);
      await service.switchTo(original.id);
    }
    const kinds = repo.listBackups().map((b) => b.kind);
    assert.equal(kinds.filter((k) => k === 'pre_switch').length, 5);
    assert.equal(kinds.filter((k) => k === 'original').length, 1);
    const setup = repo.listBackups().find((b) => b.kind === 'original');
    await assert.rejects(service.deleteBackup(setup.id), (e) => e.code === 'PROTECTED');
  });

  it('manual backups can be made, exported and deleted', async () => {
    const { service, repo } = await linkedWithKids();
    const b = await service.createBackup('Before the holidays');
    const exported = service.exportBackup(b.id);
    assert.equal(exported.format, 'openprofiles-backup');
    assert.equal(exported.library.length, 2);
    assert.equal(exported.addons.length, 2);
    await service.deleteBackup(b.id);
    assert.equal(repo.getBackup(b.id), null);
  });
});
