import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildLibraryChanges, buildNotifChanges, countActive, isCleanTombstone, tombstone,
} from '../src/core/library.js';
import { libItem, notif } from './helpers/fakeStremio.js';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');

describe('buildLibraryChanges', () => {
  it('tombstones live items missing from the target using the full original item', () => {
    const live = [libItem('tt-a', { temp: true, lastWatched: '2026-10-01T00:00:00.000Z', timeOffset: 500 })];
    const { changes, stats } = buildLibraryChanges(live, [], NOW);
    assert.equal(stats.tombstoned, 1);
    const [t] = changes;
    assert.equal(t._id, 'tt-a');
    assert.equal(t.name, 'tt-a', 'keeps the identity fields');
    assert.equal(t.poster, live[0].poster, 'keeps every other field (minimal tombstones are rejected)');
    assert.equal(t.removed, true);
    assert.equal(t.temp, false);
    assert.equal(t._mtime, new Date(NOW).toISOString());
    assert.deepEqual(
      { ...t.state, duration: undefined },
      {
        lastWatched: '', video_id: '', watched: '', timeOffset: 0, timeWatched: 0, timesWatched: 0, flaggedWatched: 0,
        overallTimeWatched: 0, noNotif: true, season: 0, episode: 0, duration: undefined,
      },
    );
    assert.equal(t.state.duration, 3_600_000, 'unrelated state fields survive');
  });

  it('pushes target items verbatim with unique, recency-ordered RFC 3339 _mtimes', () => {
    const target = [
      libItem('old', { lastWatched: '2026-01-01T00:00:00.000Z' }),
      libItem('newest', { lastWatched: '2026-10-09T00:00:00.000Z', temp: true, timeOffset: 99 }),
      libItem('never', { mtime: '2020-01-01T00:00:00.000Z' }),
      libItem('gone', { removed: true, mtime: '2019-01-01T00:00:00.000Z' }),
    ];
    const { changes, stats } = buildLibraryChanges([], target, NOW);
    assert.equal(stats.restored, 3);
    assert.equal(stats.tombstoned, 1, "the target's own tombstone counts as hiding a title");
    assert.deepEqual(changes.map((c) => c._id), ['newest', 'old', 'never', 'gone']);
    const mtimes = changes.map((c) => c._mtime);
    assert.ok(mtimes.every((m) => typeof m === 'string' && /Z$/.test(m)));
    assert.equal(new Set(mtimes).size, mtimes.length, 'no two items share an _mtime');
    assert.deepEqual(mtimes, [...mtimes].sort().reverse(), 'descending');
    const newest = changes[0];
    assert.equal(newest.temp, true);
    assert.equal(newest.state.timeOffset, 99, 'resume position kept');
    assert.equal(changes[3].removed, true, 'target tombstones stay tombstones');
  });

  it('does not re-write clean tombstones', () => {
    const clean = tombstone(libItem('x'), '2026-01-01T00:00:00.000Z');
    const { changes, stats } = buildLibraryChanges([clean], [clean], NOW);
    assert.equal(changes.length, 0);
    assert.equal(stats.unchanged, 1);
    const alsoMissing = buildLibraryChanges([clean], [], NOW);
    assert.equal(alsoMissing.changes.length, 0);
  });

  it('re-tombstones a polluted tombstone that is missing from the target', () => {
    const polluted = { ...libItem('x', { lastWatched: '2026-10-01T00:00:00.000Z' }), removed: true };
    assert.equal(isCleanTombstone(polluted), false);
    const { changes } = buildLibraryChanges([polluted], [], NOW);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].state.lastWatched, '');
  });

  it('restores an item that is a tombstone live but active in the target', () => {
    const live = [tombstone(libItem('x'), '2026-01-01T00:00:00.000Z')];
    const target = [libItem('x', { timeOffset: 42, temp: true })];
    const { changes } = buildLibraryChanges(live, target, NOW);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].removed, false);
    assert.equal(changes[0].state.timeOffset, 42);
  });
});

// Regression: the first live test lost Continue Watching for everything played
// without being added to the library, because removed items were "cleaned".
describe('removed is not the same as deleted', () => {
  const playedNotInLibrary = () => libItem('tt-got', {
    removed: true, temp: true, timeOffset: 1_234_000, lastWatched: '2026-10-09T19:54:37.947666Z',
  });
  const removedWithWatchedEpisodes = () => {
    const it = libItem('tt-old-show', { removed: true });
    it.state.watched = 'tt-old-show:8:1:eJxjYGBgAAAABAAB';
    return it;
  };

  it('a played-but-not-in-library item is live data, not a tombstone', () => {
    assert.equal(isCleanTombstone(playedNotInLibrary()), false);
    assert.equal(isCleanTombstone(removedWithWatchedEpisodes()), false);
  });

  it('is pushed back verbatim even when the live copy is a clean tombstone', () => {
    const target = [playedNotInLibrary(), removedWithWatchedEpisodes()];
    const live = target.map((it) => tombstone(it, '2026-10-11T00:00:00.000Z'));
    const { changes } = buildLibraryChanges(live, target, NOW);
    const got = changes.find((c) => c._id === 'tt-got');
    assert.equal(got.temp, true);
    assert.equal(got.state.timeOffset, 1_234_000);
    assert.equal(got.state.lastWatched, '2026-10-09T19:54:37.947666Z');
    assert.equal(changes.find((c) => c._id === 'tt-old-show').state.watched, 'tt-old-show:8:1:eJxjYGBgAAAABAAB');
  });

  it('countActive counts only items in the library', () => {
    assert.equal(countActive([libItem('a'), playedNotInLibrary(), removedWithWatchedEpisodes()]), 1);
  });
});

describe('buildNotifChanges', () => {
  it('dismisses live notifications missing from the target and restores the target ones', () => {
    const live = [notif('a 1 1'), notif('b 1 1')];
    const target = [notif('b 1 1'), notif('c 1 1')];
    const { changes, stats } = buildNotifChanges(live, target);
    assert.equal(stats.dismissed, 1);
    const dismissed = changes.find((c) => c._id === 'a 1 1');
    assert.deepEqual([dismissed.dismissed, dismissed.seen, dismissed.delivered], [true, true, true]);
    assert.equal(dismissed._mtime, live[0]._mtime, '_mtime left alone');
    assert.equal(dismissed.removed, undefined, 'notifItem has no removed field');
    assert.deepEqual(changes.filter((c) => c.dismissed !== true).map((c) => c._id).sort(), ['b 1 1', 'c 1 1']);
  });

  it('an empty target is a clean slate', () => {
    const { stats } = buildNotifChanges([notif('a 1 1')], []);
    assert.equal(stats.dismissed, 1);
  });
});
