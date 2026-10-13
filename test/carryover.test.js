import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { carriesOn, judge } from '../src/core/carryover.js';
import { countContinueWatching, tombstone } from '../src/core/library.js';
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
    const startedAt = service.now() - 30 * 1000;
    fake.seed({ library: [playing('tt-new', { offset: 0, at: startedAt })] });

    await service.switchTo(kids.id);
    assert.equal(repo.listCarryovers()[0]?.ownerProfileId, original.id);

    // Its first save, playing ever since it started.
    ctx.advance(3 * MIN);
    const offset = service.now() - startedAt;
    tvSavesRebuilt(ctx, 'tt-new', { offset, video: 'tt-new' });
    await service.switchTo(original.id);
    assert.equal(fake.library.get('tt-new').state.timeOffset, offset, 'Original gets the first saved position');
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

  it('keeps following while Stremio has signed the account out, and sorts it out once signed in again', async () => {
    const ctx = await watching();
    const { service, repo, fake, kids, original } = ctx;
    const base = structuredClone(fake.library.get('tt-movie'));
    const key = fake.authKey;
    await service.switchTo(kids.id);
    ctx.advance(3 * MIN);
    tvSaves(ctx, base, { offset: 43 * MIN });

    fake.authKey = 'x'.repeat(40);
    assert.deepEqual(await service.checkCarryovers(), { following: 1, settled: 0 });
    assert.equal(repo.listCarryovers().length, 1);

    fake.authKey = key;
    ctx.advance(3 * MIN);
    await service.checkCarryovers();
    ctx.advance(8 * MIN);
    assert.equal((await service.checkCarryovers()).settled, 1);
    assert.equal(countContinueWatching([fake.library.get('tt-movie')]), 0);
    assert.equal(savedItem(repo, original.id, 'tt-movie').state.timeOffset, 43 * MIN);
  });

  it('signed out until the records expire: they go then', async () => {
    const ctx = await watching();
    await ctx.service.switchTo(ctx.kids.id);
    ctx.fake.authKey = 'x'.repeat(40);
    ctx.advance(46 * MIN);
    assert.deepEqual(await ctx.service.checkCarryovers(), { following: 0, settled: 0 });
    assert.deepEqual(ctx.repo.listCarryovers(), []);
  });
});

/** Kids, on a synced device, plays the title from what Stremio has: its own position. */
const kidsPlay = tvSavesRebuilt;

/** A check after each of `plays` (3 minutes apart), then one once it has stopped. Returns how many were put back. */
async function checksWhile(ctx, plays) {
  let settled = 0;
  for (const play of plays) {
    ctx.advance(3 * MIN);
    play();
    settled += (await ctx.service.checkCarryovers()).settled;
  }
  ctx.advance(8 * MIN);
  settled += (await ctx.service.checkCarryovers()).settled;
  return settled;
}

describe('when unsure, the title stays with the profile in use', () => {
  it("the owner had only just started it: someone in the new profile watching it later keeps their viewing", async () => {
    const ctx = await linkedWithKids();
    const { service, repo, fake, kids, original } = ctx;
    fake.seed({ library: [playing('tt-m', { offset: 0, at: service.now() - 30 * 1000 })] });
    await service.switchTo(kids.id);
    assert.equal(repo.listCarryovers().length, 1, 'followed, in case it plays on');

    // Kids presses play right after the switch and watches for a while.
    const start = service.now();
    const play = () => kidsPlay(ctx, 'tt-m', { offset: service.now() - start, video: 'tt-m' });
    assert.equal(await checksWhile(ctx, [play, play, play]), 0, 'nothing put back');
    const live = fake.library.get('tt-m');
    assert.equal(countContinueWatching([live]), 1, "still in Kids' Continue Watching");
    assert.ok(live.state.timeOffset >= 9 * MIN);
    assert.deepEqual(repo.listCarryovers(), []);
    assert.equal(savedItem(repo, original.id, 'tt-m').state.timeOffset, 0, "Original doesn't get Kids' viewing");

    await service.switchTo(original.id);
    assert.equal(savedItem(repo, kids.id, 'tt-m').state.timeOffset, live.state.timeOffset, 'Kids keeps it');
  });

  it('the owner had just finished it (position back at 0): someone in the new profile playing it keeps it', async () => {
    const ctx = await linkedWithKids();
    const { service, repo, fake, kids } = ctx;
    const done = playing('tt-m', { offset: 0, at: service.now() - MIN });
    done.state.flaggedWatched = 1;
    fake.seed({ library: [done] });
    await service.switchTo(kids.id);

    ctx.advance(5 * MIN);
    const start = service.now();
    const play = () => kidsPlay(ctx, 'tt-m', { offset: service.now() - start, video: 'tt-m' });
    assert.equal(await checksWhile(ctx, [play]), 0);
    assert.equal(countContinueWatching([fake.library.get('tt-m')]), 1);
    assert.deepEqual(repo.listCarryovers(), []);
  });

  it('the owner was a minute and a half in: someone in the new profile starting it keeps it', async () => {
    const ctx = await linkedWithKids();
    const { service, repo, fake, kids, original } = ctx;
    fake.seed({ library: [playing('tt-m', { offset: 1.5 * MIN, at: service.now() - MIN })] });
    await service.switchTo(kids.id);
    ctx.advance(3 * MIN);
    kidsPlay(ctx, 'tt-m', { offset: 0.5 * MIN, video: 'tt-m' });
    await service.switchTo(original.id);
    assert.equal(savedItem(repo, kids.id, 'tt-m').state.timeOffset, 0.5 * MIN, 'Kids keeps its viewing');
    assert.equal(fake.library.get('tt-m').state.timeOffset, 1.5 * MIN, "Original's own position, not Kids'");
  });

  it('the profile switched to has its own progress in the title: not followed, so resuming it is left alone', async () => {
    const ctx = await linkedWithKids();
    const { service, repo, fake, kids, original } = ctx;
    fake.seed({ library: [playing('tt-m', { offset: 40 * MIN, at: service.now() - MIN })] });
    repo.saveProfileLibrary(kids.id, [playing('tt-m', { offset: 90 * MIN, at: service.now() - 24 * 60 * MIN })]);
    await service.switchTo(kids.id);
    assert.equal(fake.library.get('tt-m').state.timeOffset, 90 * MIN);
    assert.deepEqual(repo.listCarryovers(), []);

    const play = (offset) => () => kidsPlay(ctx, 'tt-m', { offset, video: 'tt-m' });
    assert.equal(await checksWhile(ctx, [play(93 * MIN), play(96 * MIN)]), 0);
    assert.equal(fake.library.get('tt-m').state.timeOffset, 96 * MIN, 'Kids is not rolled back');
    assert.equal(savedItem(repo, original.id, 'tt-m').state.timeOffset, 40 * MIN, "Original doesn't get Kids' viewing");
  });

  it('same for a series the profile switched to was watching too, on another episode', async () => {
    const ctx = await linkedWithKids();
    const { service, repo, fake, kids } = ctx;
    fake.seed({ library: [playing('tt-s', { offset: 20 * MIN, at: service.now() - MIN, type: 'series', video: 'tt-s:1:2' })] });
    repo.saveProfileLibrary(kids.id, [playing('tt-s', { offset: 10 * MIN, at: service.now() - 24 * 60 * MIN, type: 'series', video: 'tt-s:1:3' })]);
    await service.switchTo(kids.id);
    assert.deepEqual(repo.listCarryovers(), []);
  });

  it('an episode further on than the next one is not the owner carrying on', async () => {
    const ctx = await linkedWithKids();
    const { service, repo, fake, kids, original } = ctx;
    fake.seed({ library: [playing('tt-s', { offset: 20 * MIN, at: service.now() - MIN, type: 'series', video: 'tt-s:1:2' })] });
    await service.switchTo(kids.id);
    const play = (offset) => () => kidsPlay(ctx, 'tt-s', { offset, video: 'tt-s:4:1' });
    assert.equal(await checksWhile(ctx, [play(2 * MIN), play(5 * MIN)]), 0);
    assert.equal(fake.library.get('tt-s').state.video_id, 'tt-s:4:1');
    assert.equal(savedItem(repo, original.id, 'tt-s').state.video_id, 'tt-s:1:2');
    await service.switchTo(original.id);
    assert.equal(savedItem(repo, kids.id, 'tt-s').state.video_id, 'tt-s:4:1', 'Kids keeps it');
  });
});

describe('putting a title back', () => {
  it("a put-back that lands but whose answer is lost doesn't cost the owner its progress", async () => {
    const ctx = await watching();
    const { service, repo, fake, kids, original } = ctx;
    await service.switchTo(kids.id);
    ctx.advance(3 * MIN);
    tvSavesRebuilt(ctx, 'tt-movie', { offset: 70 * MIN, video: 'tt-movie' });
    await service.checkCarryovers();

    // Stremio stores the put-back, then the answer never arrives.
    const put = fake.api_datastorePut;
    fake.api_datastorePut = function (body) {
      put.call(this, body);
      throw new TypeError('fetch failed');
    };
    ctx.advance(8 * MIN);
    assert.equal((await service.checkCarryovers()).settled, 0);
    assert.equal(countContinueWatching([fake.library.get('tt-movie')]), 0, 'it did land');
    assert.equal(savedItem(repo, original.id, 'tt-movie').state.timeOffset, 70 * MIN, 'saved before the put');

    fake.api_datastorePut = put;
    const puts = fake.callCount('datastorePut');
    ctx.advance(3 * MIN);
    assert.deepEqual(await service.checkCarryovers(), { following: 1, settled: 0 }, 'the put-back is taken for untouched');
    assert.equal(fake.callCount('datastorePut'), puts);
    assert.equal(savedItem(repo, original.id, 'tt-movie').state.timeOffset, 70 * MIN);
  });

  it('a put-back that fails is tried again, with the progress saved once', async () => {
    const ctx = await watching();
    const { service, repo, fake, kids, original } = ctx;
    const base = structuredClone(fake.library.get('tt-movie'));
    await service.switchTo(kids.id);
    ctx.advance(3 * MIN);
    tvSaves(ctx, base, { offset: 43 * MIN });
    await service.checkCarryovers();
    fake.failWhen((method) => method === 'datastorePut', { network: true }, { times: 10 });
    ctx.advance(8 * MIN);
    assert.equal((await service.checkCarryovers()).settled, 0);
    assert.equal(countContinueWatching([fake.library.get('tt-movie')]), 1);
    fake.rules = [];
    ctx.advance(3 * MIN);
    assert.equal((await service.checkCarryovers()).settled, 1);
    assert.equal(countContinueWatching([fake.library.get('tt-movie')]), 0);
    assert.equal(savedItem(repo, original.id, 'tt-movie').state.timeOffset, 43 * MIN);
  });

  it("lands even when the device's clock runs ahead of the server's, and only once", async () => {
    const ctx = await watching();
    const { service, repo, fake, kids, original } = ctx;
    fake.newestWins = true;
    await service.switchTo(kids.id);
    ctx.advance(3 * MIN);
    // The TV's clock is 15 minutes fast, so is everything it stamps.
    const ahead = service.now() + 15 * MIN;
    const cur = fake.library.get('tt-movie');
    fake.library.set('tt-movie', {
      ...structuredClone(cur), _mtime: iso(ahead), state: { ...cur.state, lastWatched: iso(ahead), timeOffset: 43 * MIN, video_id: 'tt-movie' },
    });

    const puts = fake.callCount('datastorePut');
    let settled = 0;
    for (let i = 0; i < 10; i++) {
      ctx.advance(3 * MIN);
      settled += (await service.checkCarryovers()).settled;
    }
    assert.equal(settled, 1);
    assert.equal(fake.callCount('datastorePut'), puts + 1);
    assert.equal(countContinueWatching([fake.library.get('tt-movie')]), 0, "gone from Kids' Continue Watching");
    assert.equal(savedItem(repo, original.id, 'tt-movie').state.timeOffset, 43 * MIN);
  });

  it('an owner moved to the bin still gets the progress, and the title still leaves the profile in use', async () => {
    const ctx = await watching();
    const { service, repo, fake, kids, original } = ctx;
    const base = structuredClone(fake.library.get('tt-movie'));
    await service.switchTo(kids.id);
    ctx.advance(3 * MIN);
    tvSaves(ctx, base, { offset: 43 * MIN });
    await service.deleteProfile(original.id);

    await service.saveNow();
    assert.equal(countContinueWatching(saved(repo, kids.id)), 0, "Kids doesn't save it as its own");
    ctx.advance(8 * MIN);
    assert.equal((await service.checkCarryovers()).settled, 1);
    assert.equal(countContinueWatching([fake.library.get('tt-movie')]), 0);

    await service.restoreFromBin(original.id);
    assert.equal(savedItem(repo, original.id, 'tt-movie').state.timeOffset, 43 * MIN);
  });
});

describe('judge', () => {
  // Numbers from a live test: play pressed 16 s before the switch, first save 74 s after it, at 89 s.
  const switchAt = Date.parse('2026-10-10T12:00:00.000Z');
  const base = { _id: 'tt-m', _mtime: iso(switchAt - 16_000), state: { video_id: 'tt-m', timeOffset: 0, lastWatched: iso(switchAt - 16_000) } };
  const record = { base, written: tombstone(base, iso(switchAt + 2000)), createdAt: switchAt };
  const save = (offset, after) => ({ ...base, _mtime: iso(switchAt + after), state: { ...base.state, timeOffset: offset, lastWatched: iso(switchAt + after) } });

  it("a title started just before the switch: a position past the time since the switch is the owner's", () => {
    assert.equal(judge(record, save(89_000, 74_000)).kind, 'owner');
    assert.equal(judge(record, save(74_000, 74_000)).kind, 'released', 'started right at the switch');
    assert.equal(judge(record, save(80_000, 74_000)).kind, 'released', 'within the margin');
    assert.equal(judge(record, save(10 * MIN, 30 * MIN)).kind, 'released');
  });

  it('what the switch wrote, or a put-back whose answer was lost, is untouched', () => {
    assert.equal(judge(record, record.written).kind, 'untouched');
    const put = { ...record.written, _mtime: iso(switchAt + 20 * MIN) };
    assert.equal(judge(record, put).kind, 'released');
    assert.equal(judge({ ...record, putMtime: put._mtime }, put).kind, 'untouched');
  });

  it("over a copy with the new profile's own progress, never the owner's", () => {
    const own = { ...record.written, state: { ...record.written.state, timeOffset: 5 * MIN, video_id: 'tt-m' } };
    assert.equal(judge({ ...record, written: own }, save(89_000, 74_000)).kind, 'released');
  });
});

describe('carriesOn', () => {
  const since = Date.parse('2026-10-10T12:00:00.000Z');
  const at = (video, offset, extra = {}) => ({ _id: 'kitsu:7', state: { video_id: video, timeOffset: offset, flaggedWatched: 0, ...extra } });
  const later = (ms) => iso(since + ms);

  it('same video further along, a little rewind, or finished sooner than it could have been since the switch', () => {
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), at('kitsu:7:3', 25 * MIN), since), true);
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), at('kitsu:7:3', 19 * MIN), since), true);
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), at('kitsu:7:3', 5 * MIN), since), false);
    const finished = (after) => at('kitsu:7:3', 0, { flaggedWatched: 1, duration: 24 * MIN, lastWatched: later(after) });
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), finished(5 * MIN), since), true);
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), finished(30 * MIN), since), false);
  });

  it('only the very next episode', () => {
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), at('kitsu:7:4', MIN), since), true);
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), at('kitsu:7:5', MIN), since), false);
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), at('kitsu:7:2', 50 * MIN), since), false);
    assert.equal(carriesOn(at('kitsu:7:3', 20 * MIN), at('other:9', 50 * MIN), since), false);
    assert.equal(carriesOn(at('', 0), at('kitsu:7:3', MIN), since), false);

    const ep = (video, offset) => ({ _id: 'tt-s', state: { video_id: video, timeOffset: offset } });
    assert.equal(carriesOn(ep('tt-s:1:2', 20 * MIN), ep('tt-s:1:3', MIN), since), true);
    assert.equal(carriesOn(ep('tt-s:1:9', 20 * MIN), ep('tt-s:2:1', MIN), since), true);
    assert.equal(carriesOn(ep('tt-s:1:2', 20 * MIN), ep('tt-s:1:4', MIN), since), false);
    assert.equal(carriesOn(ep('tt-s:1:2', 20 * MIN), ep('tt-s:4:1', MIN), since), false);
    assert.equal(carriesOn(ep('tt-s:1:2', 20 * MIN), ep('tt-s:2:2', MIN), since), false);
    assert.equal(carriesOn(ep('tt-s:0:1', 20 * MIN), ep('tt-s:1:1', MIN), since), false, 'specials');
    assert.equal(carriesOn(ep('tt-s:1:2', 20 * MIN), ep('tt-s:0:3', MIN), since), false);
  });

  it('barely started at the switch: only a position past the time since', () => {
    const base = at('kitsu:7:3', 0, { lastWatched: iso(since - 30_000) });
    assert.equal(carriesOn(base, at('kitsu:7:3', 4 * MIN, { lastWatched: later(3 * MIN) }), since), true);
    assert.equal(carriesOn(base, at('kitsu:7:3', 3 * MIN, { lastWatched: later(3 * MIN) }), since), false);
    assert.equal(carriesOn(base, at('kitsu:7:3', 3 * MIN), since), false, 'no time saved');
  });
});
