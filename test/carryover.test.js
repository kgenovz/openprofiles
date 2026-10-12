import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { carriesOn } from '../src/core/carryover.js';
import { countContinueWatching } from '../src/core/library.js';
import { checkCarryovers } from '../src/core/scheduler.js';
import { libItem } from './helpers/fakeStremio.js';
import { linkedWithKids } from './helpers/setup.js';

const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** A title as Stremio saves it while it plays: `offset` in, last saved `at`. */
function playing(id, { offset, at, video = id, type = 'movie', watched = '' }) {
  const it = libItem(id, { lastWatched: iso(at), timeOffset: offset, mtime: iso(at) });
  it.type = type;
  it.state.video_id = video;
  it.state.watched = watched;
  it.state.duration = 120 * MIN;
  return it;
}

/** "Original" is playing a movie on the TV right now; "Kids" is empty. */
async function watching(opts) {
  const ctx = await linkedWithKids(opts);
  const now = ctx.service.now();
  ctx.fake.seed({ library: [playing('tt-movie', { offset: 40 * MIN, at: now - MIN })] });
  return ctx;
}

/** The TV saves its own copy of the title, further along (it hasn't synced since the switch). */
function tvSaves(ctx, base, { offset, video = base.state.video_id }) {
  const at = ctx.service.now();
  ctx.fake.library.set(base._id, {
    ...structuredClone(base),
    _mtime: iso(at),
    state: { ...base.state, lastWatched: iso(at), timeOffset: offset, video_id: video, overallTimeWatched: base.state.overallTimeWatched + 10 * MIN },
  });
}

/**
 * The TV synced, so it rebuilt the title from what Stremio had (stremio-core keeps the stored
 * flags and state), then saved with its position: removed + temp, no watched list.
 */
function tvSavesRebuilt(ctx, id, { offset, video }) {
  const at = ctx.service.now();
  const hidden = ctx.fake.library.get(id);
  ctx.fake.library.set(id, {
    ...structuredClone(hidden),
    removed: true,
    temp: true,
    _mtime: iso(at),
    state: { ...hidden.state, lastWatched: iso(at), timeOffset: offset, timeWatched: offset, overallTimeWatched: offset, video_id: video },
  });
}

const saved = (repo, profileId) => repo.cipher.decryptJson(repo.getProfileRow(profileId).library_enc, 'library');
const savedItem = (repo, profileId, id) => saved(repo, profileId).find((it) => it._id === id);

describe('titles still playing on another device after a switch', () => {
  it('go back to the profile that was watching, not into the one switched to', async () => {
    const ctx = await watching();
    const { service, repo, fake, kids, original } = ctx;
    const base = structuredClone(fake.library.get('tt-movie'));

    await service.switchTo(kids.id);
    assert.equal(fake.library.get('tt-movie').removed, true, 'hidden from Kids');
    const followed = repo.listCarryovers();
    assert.equal(followed.length, 1);
    assert.equal(followed[0].ownerProfileId, original.id);

    ctx.advance(10 * MIN);
    tvSaves(ctx, base, { offset: 50 * MIN });
    await service.switchTo(original.id);

    const back = fake.library.get('tt-movie');
    assert.equal(back.removed, false);
    assert.equal(back.state.timeOffset, 50 * MIN, 'Original resumes where the TV stopped');
    assert.equal(countContinueWatching(saved(repo, kids.id)), 0, "Kids' saved copy doesn't have it");
    assert.deepEqual(repo.listCarryovers(), [], 'nothing left to follow once Original is in use');
    assert.ok(repo.listActivity().some((a) => a.kind === 'carryover' && a.detail.includes('"Original"')));
  });

  it('a copy the device rebuilt from the hidden title keeps the profile flags and watched marks', async () => {
    const ctx = await linkedWithKids();
    const { service, fake, kids, original } = ctx;
    const now = service.now();
    const show = playing('tt-show', { offset: 30 * MIN, at: now - MIN, type: 'series', video: 'tt-show:1:2', watched: 'tt-show:1:1:eJxjYGBgAAAABAAB' });
    fake.seed({ library: [show] });

    await service.switchTo(kids.id);
    ctx.advance(5 * MIN);
    tvSavesRebuilt(ctx, 'tt-show', { offset: 35 * MIN, video: 'tt-show:1:2' });
    await service.switchTo(original.id);

    const back = fake.library.get('tt-show');
    assert.equal(back.removed, false, 'still in the library');
    assert.equal(back.temp, false);
    assert.equal(back.state.timeOffset, 35 * MIN);
    assert.equal(back.state.watched, show.state.watched, 'watched episodes kept');
  });

  it('moving on to a third profile: the owner gets the progress, the profile left behind does not', async () => {
    const ctx = await watching();
    const { service, repo, fake, kids, original } = ctx;
    const guest = await service.createProfile({ name: 'Guest', from: 'empty' });
    const base = structuredClone(fake.library.get('tt-movie'));

    await service.switchTo(kids.id);
    ctx.advance(6 * MIN);
    tvSaves(ctx, base, { offset: 46 * MIN });
    await service.switchTo(guest.id);

    assert.equal(savedItem(repo, original.id, 'tt-movie').state.timeOffset, 46 * MIN);
    assert.equal(countContinueWatching(saved(repo, kids.id)), 0);
    assert.equal(fake.library.get('tt-movie').removed, true, 'hidden from Guest too');
    assert.equal(repo.listCarryovers()[0]?.ownerProfileId, original.id, 'still followed: it may still be playing');

    ctx.advance(6 * MIN);
    tvSaves(ctx, base, { offset: 52 * MIN });
    await service.switchTo(original.id);
    assert.equal(fake.library.get('tt-movie').state.timeOffset, 52 * MIN);
    assert.equal(countContinueWatching(saved(repo, guest.id)), 0);
  });

  it('someone in the new profile starting the same title from the beginning keeps it', async () => {
    const ctx = await watching();
    const { service, repo, fake, kids, original } = ctx;
    await service.switchTo(kids.id);
    ctx.advance(10 * MIN);
    tvSavesRebuilt(ctx, 'tt-movie', { offset: 5 * MIN, video: 'tt-movie' });
    await service.switchTo(original.id);

    assert.equal(savedItem(repo, kids.id, 'tt-movie').state.timeOffset, 5 * MIN, "Kids' own viewing stays in Kids");
    assert.equal(fake.library.get('tt-movie').state.timeOffset, 40 * MIN, "Original's position is untouched");
  });

  it('the next episode playing on counts as carrying on', async () => {
    const ctx = await linkedWithKids();
    const { service, fake, kids, original } = ctx;
    const show = playing('tt-show', { offset: 30 * MIN, at: service.now() - MIN, type: 'series', video: 'tt-show:1:2' });
    fake.seed({ library: [show] });
    await service.switchTo(kids.id);
    ctx.advance(20 * MIN);
    tvSaves(ctx, show, { offset: 2 * MIN, video: 'tt-show:1:3' });
    await service.switchTo(original.id);
    assert.equal(fake.library.get('tt-show').state.video_id, 'tt-show:1:3');
  });

  it('a title started just before the switch, with no position saved yet, is followed too', async () => {
    const ctx = await linkedWithKids();
    const { service, repo, fake, kids, original } = ctx;
    // Play pressed half a minute ago: the player marked it, position 0.
    const started = playing('tt-new', { offset: 0, at: service.now() - 30 * 1000 });
    fake.seed({ library: [started] });

    await service.switchTo(kids.id);
    assert.equal(repo.listCarryovers()[0]?.ownerProfileId, original.id);

    ctx.advance(3 * MIN);
    tvSavesRebuilt(ctx, 'tt-new', { offset: 3 * MIN, video: 'tt-new' });
    await service.switchTo(original.id);
    assert.equal(fake.library.get('tt-new').state.timeOffset, 3 * MIN, 'Original gets the first saved position');
    assert.equal(countContinueWatching(saved(repo, kids.id)), 0, "not in Kids' Continue Watching");
  });

  it('a title marked as started long ago with no position is not followed', async () => {
    const ctx = await linkedWithKids();
    ctx.fake.seed({ library: [playing('tt-old', { offset: 0, at: ctx.service.now() - 10 * MIN })] });
    await ctx.service.switchTo(ctx.kids.id);
    assert.deepEqual(ctx.repo.listCarryovers(), []);
  });

  it("titles not watched in the last half hour aren't followed, so nothing is checked", async () => {
    const { service, repo, fake, kids } = await linkedWithKids();
    await service.switchTo(kids.id);
    assert.deepEqual(repo.listCarryovers(), []);
    const reads = fake.callCount('datastoreGet');
    assert.deepEqual(await service.checkCarryovers(), { following: 0, settled: 0 });
    assert.equal(fake.callCount('datastoreGet'), reads);
  });

  it('Save now in the profile in use leaves the other profile\'s title out and gives it the progress', async () => {
    const ctx = await watching();
    const { service, repo, fake, kids, original } = ctx;
    const base = structuredClone(fake.library.get('tt-movie'));
    await service.switchTo(kids.id);
    ctx.advance(5 * MIN);
    tvSaves(ctx, base, { offset: 45 * MIN });
    await service.saveNow();
    assert.equal(countContinueWatching(saved(repo, kids.id)), 0);
    assert.equal(savedItem(repo, original.id, 'tt-movie').state.timeOffset, 45 * MIN);
    assert.equal(repo.listCarryovers().length, 1, 'still followed');
  });

  it('a restore stops following', async () => {
    const ctx = await watching();
    const { service, repo, kids } = ctx;
    await service.switchTo(kids.id);
    assert.equal(repo.listCarryovers().length, 1);
    const backup = repo.listBackups().find((b) => b.kind === 'pre_switch');
    await service.restoreBackup(backup.id);
    assert.deepEqual(repo.listCarryovers(), []);
  });

  it('are stored encrypted: no title ids in the database', async () => {
    const ctx = await watching();
    await ctx.service.switchTo(ctx.kids.id);
    const rows = ctx.db.prepare('SELECT * FROM carryovers').all();
    assert.equal(rows.length, 1);
    assert.ok(!Buffer.from(rows[0].item_enc).toString('latin1').includes('tt-movie'));
  });
});

describe('the background check', () => {
  it('once the device stops, takes the title out of the profile in use and saves it to its owner', async () => {
    const ctx = await watching();
    const { service, repo, fake, kids, original, accounts } = ctx;
    const base = structuredClone(fake.library.get('tt-movie'));
    await service.switchTo(kids.id);

    ctx.advance(3 * MIN);
    tvSaves(ctx, base, { offset: 43 * MIN });
    const reads = fake.callCount('datastoreGet');
    assert.deepEqual(await service.checkCarryovers(), { following: 1, settled: 0 });
    assert.equal(fake.callCount('datastoreGet'), reads + 1, 'one read of just the followed titles');
    assert.equal(fake.library.get('tt-movie').removed, false, 'left alone while it plays');

    ctx.advance(3 * MIN);
    assert.equal((await service.checkCarryovers()).settled, 0, 'three quiet minutes is just the gap between saves');

    ctx.advance(5 * MIN);
    assert.equal(await checkCarryovers({ accounts }), 1);
    const hidden = fake.library.get('tt-movie');
    assert.equal(hidden.removed, true);
    assert.equal(hidden.temp, false);
    assert.equal(countContinueWatching([hidden]), 0, "gone from Kids' Continue Watching");
    assert.equal(savedItem(repo, original.id, 'tt-movie').state.timeOffset, 43 * MIN);
    assert.ok(repo.listActivity().some((a) => a.kind === 'carryover'));

    // Only paused: it plays on (the TV synced, so it rebuilt from the hidden copy) and stops again.
    ctx.advance(20 * MIN);
    tvSavesRebuilt(ctx, 'tt-movie', { offset: 70 * MIN, video: 'tt-movie' });
    await service.checkCarryovers();
    ctx.advance(8 * MIN);
    assert.equal((await service.checkCarryovers()).settled, 1);
    assert.equal(fake.library.get('tt-movie').removed, true);
    const kept = savedItem(repo, original.id, 'tt-movie');
    assert.equal(kept.state.timeOffset, 70 * MIN);
    assert.equal(kept.removed, false, "Original's copy keeps its flags");
  });

  it('lets go of a title nobody touched after 45 minutes', async () => {
    const ctx = await watching();
    await ctx.service.switchTo(ctx.kids.id);
    ctx.advance(30 * MIN);
    assert.equal((await ctx.service.checkCarryovers()).following, 1);
    ctx.advance(16 * MIN);
    assert.equal((await ctx.service.checkCarryovers()).following, 0);
    assert.deepEqual(ctx.repo.listCarryovers(), []);
  });

  it('stops when Stremio has signed the account out', async () => {
    const ctx = await watching();
    await ctx.service.switchTo(ctx.kids.id);
    ctx.fake.authKey = 'x'.repeat(40);
    assert.deepEqual(await ctx.service.checkCarryovers(), { following: 0, settled: 0 });
    assert.deepEqual(ctx.repo.listCarryovers(), []);
  });
});

describe('carriesOn', () => {
  const at = (video, offset, extra = {}) => ({ _id: 'kitsu:7', state: { video_id: video, timeOffset: offset, flaggedWatched: 0, ...extra } });

  it('same video further along, a little rewind, or finished', () => {
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), at('kitsu:7:3', 25 * MIN)), true);
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), at('kitsu:7:3', 19 * MIN)), true);
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), at('kitsu:7:3', 5 * MIN)), false);
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), at('kitsu:7:3', 0, { flaggedWatched: 1 })), true);
  });

  it('a later episode yes, an earlier one or an unknown id no', () => {
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), at('kitsu:7:4', MIN)), true);
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), at('kitsu:7:2', 50 * MIN)), false);
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), at('other:9', 50 * MIN)), false);
    assert.equal(carriesOn(at('', 0), at('kitsu:7:3', MIN)), false);
  });
});
