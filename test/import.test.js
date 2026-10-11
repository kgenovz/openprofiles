import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStremShareBackup, sameAccount, suggestedProfileName } from '../src/core/importer.js';
import { addon, libItem, notif } from './helpers/fakeStremio.js';
import { linkedWithKids } from './helpers/setup.js';

function v1(overrides = {}) {
  return {
    format: 'stremshare-account-backup',
    version: 1,
    exported_at: '2026-10-10T12:00:00.000Z',
    kind: 'retired_profile',
    label: 'Profile: Movie night',
    stremio_user_id: 'user-1',
    stremio_email: 'kyle@example.com',
    created_at: '2026-10-01T18:22:05.000Z',
    counts: { library: 2, addons: 1, notifications: 1 },
    library: [libItem('tt1'), libItem('tt2'), { ...libItem('tt3'), removed: true }],
    addons: [addon('cinemeta')],
    notifications: [notif('tt1 1 1')],
    ...overrides,
  };
}

function preV1() {
  const { library, addons } = v1();
  return {
    schemaVersion: 1,
    kind: 'manual',
    label: 'Manual backup',
    stremioEmail: 'KYLE@example.com',
    createdAt: '2026-09-01T00:00:00.000Z',
    counts: { library: 2, addons: 1, notifs: 0 },
    library,
    addons,
    notifs: [],
  };
}

const refuses = (raw, code) => assert.throws(() => parseStremShareBackup(raw), (e) => e.code === code);

describe('parseStremShareBackup', () => {
  it('reads a v1 file', () => {
    const out = parseStremShareBackup(v1());
    assert.equal(out.snapshot.library.length, 3);
    assert.equal(out.snapshot.notifs.length, 1);
    assert.equal(out.sourceUserId, 'user-1');
    assert.equal(out.label, 'Profile: Movie night');
  });

  it('reads a pre-v1 file', () => {
    const out = parseStremShareBackup(preV1());
    assert.equal(out.snapshot.notifs.length, 0);
    assert.equal(out.sourceUserId, null);
    assert.equal(out.sourceEmail, 'KYLE@example.com');
  });

  it('refuses things that are not backups or are a different version', () => {
    refuses(null, 'NOT_A_BACKUP');
    refuses([], 'NOT_A_BACKUP');
    refuses({ hello: 'world' }, 'NOT_A_BACKUP');
    refuses(v1({ format: 'something-else' }), 'NOT_A_BACKUP');
    refuses(v1({ version: 2 }), 'UNSUPPORTED');
    refuses({ ...preV1(), schemaVersion: 2 }, 'UNSUPPORTED');
  });

  it('refuses files that would damage the account', () => {
    refuses(v1({ addons: [] }), 'NO_ADDONS');
    refuses(v1({ library: [{ name: 'no id' }] }), 'MALFORMED');
    refuses(v1({ notifications: undefined }), 'MALFORMED');
    refuses(v1({ library: [{ ...libItem('a'), removed: true }] }), 'CORRUPT');
    refuses({ ...preV1(), counts: undefined }, 'CORRUPT');
    refuses(v1({ library: Array.from({ length: 10001 }, (_, i) => libItem(`t${i}`)) }), 'TOO_LARGE');
  });

  it('suggests a profile name from the label', () => {
    assert.equal(suggestedProfileName('Profile: Kids'), 'Kids');
    assert.equal(suggestedProfileName('Manual backup'), 'Manual backup');
    assert.equal(suggestedProfileName(null), 'Imported');
  });

  it('works out whether the file came from the linked account', () => {
    const account = { stremio_user_id: 'user-1', stremio_email: 'kyle@example.com' };
    assert.equal(sameAccount(parseStremShareBackup(v1()), account), true);
    assert.equal(sameAccount(parseStremShareBackup(v1({ stremio_user_id: 'other' })), account), false);
    assert.equal(sameAccount(parseStremShareBackup(preV1()), account), true, 'email match, case-insensitive');
    assert.equal(sameAccount(parseStremShareBackup(v1({ stremio_user_id: null, stremio_email: null })), account), null);
  });
});

describe('importing', () => {
  it('saves a backup and a new profile without touching Stremio', async () => {
    const { service, repo, fake } = await linkedWithKids();
    const calls = fake.calls.length;
    const preview = service.previewImport(v1());
    assert.equal(preview.counts.library, 2);
    assert.equal(preview.sameAccount, true);
    assert.equal(preview.suggestedName, 'Movie night');
    const { profile, backup } = await service.confirmImport(preview.id, { name: preview.suggestedName });
    assert.equal(profile.name, 'Movie night');
    assert.equal(profile.library_count, 2);
    assert.equal(backup.kind, 'imported');
    assert.equal(fake.calls.length, calls, 'no Stremio calls');
    await assert.rejects(service.confirmImport(preview.id, {}), (e) => e.code === 'IMPORT_EXPIRED', 'one use only');
    assert.equal(repo.listProfiles().length, 3);
  });

  it('needs confirmation for a file from another (or an unknown) account', async () => {
    const { service } = await linkedWithKids();
    const other = service.previewImport(v1({ stremio_user_id: 'someone-else' }));
    assert.equal(other.sameAccount, false);
    await assert.rejects(service.confirmImport(other.id, { name: 'X' }), (e) => e.code === 'OTHER_ACCOUNT');
    const { profile } = await service.confirmImport(other.id, { name: 'X', acceptOtherAccount: true });
    assert.equal(profile.stremio_user_id, 'user-1', 'anchored to the linked account once accepted');
  });

  it('can keep it as a backup only, and the imported profile switches like any other', async () => {
    const { service, repo, fake } = await linkedWithKids();
    const onlyBackup = service.previewImport(v1());
    const { profile } = await service.confirmImport(onlyBackup.id, { asProfile: false });
    assert.equal(profile, null);
    assert.equal(repo.listProfiles().length, 2);

    const asProfile = service.previewImport(v1());
    const imported = await service.confirmImport(asProfile.id, { name: 'Movie night' });
    await service.switchTo(imported.profile.id);
    assert.deepEqual(fake.activeIds(), ['tt1', 'tt2']);
  });

  it('refuses a name that is already taken', async () => {
    const { service } = await linkedWithKids();
    const p = service.previewImport(v1());
    await assert.rejects(service.confirmImport(p.id, { name: 'kids' }), (e) => e.code === 'NAME_TAKEN');
  });
});
