/**
 * Titles that keep playing on another device after a switch.
 *
 * Stremio's player saves the title it plays every 3 minutes and once more
 * when it closes (stremio-core PUSH_TO_LIBRARY_EVERY). A device still playing
 * profile A's title after a switch to B therefore writes it back into the
 * account, over whatever the switch put there, and B would save it as its own
 * at the next switch away. So a switch follows the titles that were being
 * watched right before it: each record names the profile that owns the title
 * (`base`, its copy at the switch) and what the switch wrote for it
 * (`written`). Every later read of the account sorts out what happened since.
 */
import { hasId } from './library.js';

/** Watched this recently when a switch happens: maybe still playing somewhere. */
export const IN_FLIGHT_MS = 30 * 60 * 1000;
/** Two missed 3-minute saves: the player stopped (or is paused). */
export const SETTLE_MS = 7 * 60 * 1000;
/** A followed title nobody touched after the switch is let go this long after it. */
export const UNTOUCHED_MS = 45 * 60 * 1000;
/** After the owner's playback was last seen moving, keep watching for a resume this long. */
export const RESUME_MS = 2 * 60 * 60 * 1000;
/** Never follow a title longer than this. */
export const MAX_MS = 12 * 60 * 60 * 1000;
// Seeking back a little after the switch still counts as carrying on.
const REWIND_SLACK_MS = 2 * 60 * 1000;

export const timeOf = (value) => {
  const t = Date.parse(value ?? '');
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Started this recently with no position saved yet. The player marks a title the moment it
 * starts (lastWatched, position 0) and saves its first position up to 3 minutes in, so a
 * switch right after someone pressed play sees no progress at all.
 */
export const JUST_STARTED_MS = 5 * 60 * 1000;

/**
 * Maybe still playing on a device: part-way through and watched in the last IN_FLIGHT_MS,
 * or started in the last JUST_STARTED_MS and not saved yet.
 */
export function isInFlight(item, now) {
  if (!hasId(item)) return false;
  const age = now - timeOf(item.state?.lastWatched);
  if (item.state?.timeOffset > 0) return age <= IN_FLIGHT_MS;
  return Boolean(item.state?.video_id) && age <= JUST_STARTED_MS;
}

/** `tt1:2:5` of item `tt1` → [2, 5]; `kitsu:7:3` of `kitsu:7` → [3]; anything else → null. */
function videoOrder(videoId, itemId) {
  const v = String(videoId ?? '');
  if (!v.startsWith(`${itemId}:`)) return null;
  const parts = v.slice(itemId.length + 1).split(':');
  return parts.every((p) => /^\d+$/.test(p)) ? parts.map(Number) : null;
}

function later(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/**
 * The owner's playback carried on: the same video further along (the player
 * only moves the position forward) or finished, or a later episode (autoplay,
 * or "next" on close). Someone in the new profile starting the title begins
 * from zero, since the switch hid it with no progress.
 */
export function carriesOn(base, live) {
  const b = base.state || {};
  const l = live.state || {};
  if (!b.video_id || !l.video_id) return false;
  if (l.video_id === b.video_id) {
    return (l.timeOffset ?? 0) + REWIND_SLACK_MS >= (b.timeOffset ?? 0) || (l.timeOffset === 0 && l.flaggedWatched > 0);
  }
  const bo = videoOrder(b.video_id, base._id);
  const lo = videoOrder(l.video_id, base._id);
  return Boolean(bo && lo && later(lo, bo));
}

/**
 * The owner's copy with the progress made after the switch. The device saved
 * either its own copy of the owner's title or one rebuilt from what the switch
 * wrote (stremio-core rebuilds the played title from the library whenever it
 * syncs), so the position comes from the live item and everything else from
 * the owner's copy. Counters never go down.
 */
export function mergeProgress(base, live, written) {
  const b = base.state || {};
  const l = live.state || {};
  const sameVideo = l.video_id === b.video_id;
  // The player only marks episodes in a copy that already has a list, so a list over a
  // switch-written copy without one is the owner's own, carried on.
  const watched = l.watched && !written?.state?.watched ? l.watched : b.watched;
  return {
    ...base,
    _mtime: live._mtime,
    state: {
      ...b,
      lastWatched: l.lastWatched,
      timeOffset: l.timeOffset ?? 0,
      duration: l.duration || b.duration,
      video_id: l.video_id,
      timeWatched: sameVideo ? Math.max(b.timeWatched ?? 0, l.timeWatched ?? 0) : (l.timeWatched ?? 0),
      flaggedWatched: sameVideo ? Math.max(b.flaggedWatched ?? 0, l.flaggedWatched ?? 0) : (l.flaggedWatched ?? 0),
      timesWatched: Math.max(b.timesWatched ?? 0, l.timesWatched ?? 0),
      overallTimeWatched: Math.max(b.overallTimeWatched ?? 0, l.overallTimeWatched ?? 0),
      watched,
    },
  };
}

/**
 * What a fresh read says about a followed title (`live`: its row now, or undefined):
 *   untouched  Stremio still has what the switch wrote
 *   owner      the owner's playback carried on; `item` is the owner's copy with that progress
 *   released   someone in the profile in use played it, so it's theirs now
 */
export function judge(record, live) {
  if (!live) return { kind: 'released' };
  if (timeOf(live._mtime) <= timeOf(record.written._mtime)) return { kind: 'untouched' };
  if (!carriesOn(record.base, live)) return { kind: 'released' };
  return { kind: 'owner', item: mergeProgress(record.base, live, record.written) };
}

/**
 * `items` (owner copies with new progress) put into `library`, never moving a
 * title backwards. Returns the new library, or null when nothing changed.
 */
export function withProgress(library, items) {
  const byId = new Map(items.map((it) => [it._id, it]));
  let changed = false;
  const next = library.map((it) => {
    const merged = byId.get(it._id);
    if (!merged) return it;
    byId.delete(it._id);
    if (timeOf(merged.state?.lastWatched) < timeOf(it.state?.lastWatched)) return it;
    changed = true;
    return merged;
  });
  for (const merged of byId.values()) {
    next.push(merged);
    changed = true;
  }
  return changed ? next : null;
}
