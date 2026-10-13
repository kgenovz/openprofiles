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
 *
 * When unsure, the title stays with the profile in use: a later save counts
 * as the owner's only on strong evidence (see judge and carriesOn), and
 * anything else is left exactly as it would be without any of this. Getting
 * it wrong the other way puts back, and so erases, someone's own viewing;
 * this way the worst case is the owner missing some progress.
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
/**
 * A device that started playing seconds before a switch may not have told Stremio yet, so the
 * switch can't follow it. The player saves its position within its first 3 minutes, so this
 * long after a switch the whole library is looked over once for titles like that (startedBeforeSwitch).
 */
export const SWEEP_AFTER_MS = 4 * 60 * 1000;
// Seeking back a little after the switch still counts as carrying on.
const REWIND_SLACK_MS = 2 * 60 * 1000;
// A position this far past the time since the switch proves playback began before it: playing at
// normal speed can't run ahead of the clock, so someone starting the title after the switch never
// is. The margin covers a device clock a little behind the server's (clocks sync to within about a
// second). Live tests: a title started 16 s before a switch saved 89 s in, 74 s after it; one
// started 5 s before saved 180.0 s in, 175.1 s after (its position matched the time since its play
// mark to 0.2 s). A margin of 10 s missed the second; 3 s keeps both.
const BEFORE_SWITCH_MARGIN_MS = 3 * 1000;

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

/**
 * The episode straight after: the next one in the season, or the first of the
 * next season (autoplay, or "next" on close). Never a jump, never specials
 * (season 0). Ids with only an episode number (kitsu) just count up by one.
 */
function isNextVideo(from, to) {
  if (from.length !== to.length) return false;
  if (from.length === 1) return to[0] === from[0] + 1;
  if (from.length !== 2 || from[0] === 0 || to[0] === 0) return false;
  return (to[0] === from[0] && to[1] === from[1] + 1) || (to[0] === from[0] + 1 && to[1] === 1);
}

/**
 * The owner's playback carried on (`since`: when the title was first followed):
 *   - the next episode (isNextVideo);
 *   - the same video, the owner part-way (REWIND_SLACK_MS or more) at the
 *     switch: at least that far along, give or take a little rewind. Someone
 *     in the new profile starts from zero, since the switch hid it with no
 *     progress;
 *   - the same video, the owner barely started (or just finished, back at 0)
 *     at the switch: further along, or finished, sooner than could have been
 *     played since the switch, so it was already playing before it. A fresh
 *     start after the switch never is.
 */
export function carriesOn(base, live, since) {
  const b = base.state || {};
  const l = live.state || {};
  if (!b.video_id || !l.video_id) return false;
  if (l.video_id !== b.video_id) {
    const bo = videoOrder(b.video_id, base._id);
    const lo = videoOrder(l.video_id, base._id);
    return Boolean(bo && lo && isNextVideo(bo, lo));
  }
  const offset = l.timeOffset ?? 0;
  const finished = offset === 0 && l.flaggedWatched > 0;
  if (!finished && (b.timeOffset ?? 0) >= REWIND_SLACK_MS) return offset + REWIND_SLACK_MS >= b.timeOffset;
  const reached = finished ? (l.duration || b.duration || 0) : offset;
  const at = timeOf(l.lastWatched);
  return at >= since && reached > at - since + BEFORE_SWITCH_MARGIN_MS;
}

/**
 * The copy the switch wrote has a history of its own: the profile switched to
 * had watched the title, so a save may just as well be that profile resuming.
 * Such a title is never taken from it.
 */
export function hasOwnProgress(item) {
  const s = item?.state || {};
  return Boolean(s.video_id || s.watched)
    || ['timeOffset', 'timeWatched', 'flaggedWatched', 'timesWatched', 'overallTimeWatched'].some((k) => s[k] > 0);
}

/**
 * A title saved after a switch (at `since`) that wasn't followed, at a position
 * it couldn't have reached since: it was already playing, so it belongs to the
 * profile in use before. The same proof as carriesOn for a barely started
 * title. Never one the profile switched to has a history of (`targetCopy`, its
 * own copy, what the switch wrote): that may just be it resuming.
 */
export function startedBeforeSwitch(item, since, targetCopy) {
  if (!hasId(item) || !item.state?.video_id || hasOwnProgress(targetCopy)) return false;
  return carriesOn({ ...item, state: { ...item.state, timeOffset: 0 } }, item, since);
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
 *   untouched  Stremio still has what the switch wrote, or what a put-back
 *              wrote whose answer was lost (`putMtime`)
 *   owner      the owner's playback carried on (carriesOn) over a copy the
 *              switch wrote with no progress of its own; `item` is the
 *              owner's copy with that progress
 *   released   anything else: the profile in use keeps it, and it isn't followed any more
 */
export function judge(record, live) {
  if (!live || hasOwnProgress(record.written)) return { kind: 'released' };
  const at = timeOf(live._mtime);
  if (at <= timeOf(record.written._mtime) || (record.putMtime && at === timeOf(record.putMtime))) return { kind: 'untouched' };
  if (!carriesOn(record.base, live, record.createdAt)) return { kind: 'released' };
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
