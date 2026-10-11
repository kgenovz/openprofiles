/**
 * Pure rules for turning "what Stremio has now" + "what the target profile
 * saved" into datastorePut changes. These encode what live testing against
 * Stremio established; see PLAN.md "Switch algorithm" for the history.
 */

export const LIBRARY_CHUNK = 150;
export const NOTIF_CHUNK = 100;

const ZEROED_STATE = {
  lastWatched: '',
  video_id: '',
  watched: '',
  timeOffset: 0,
  timeWatched: 0,
  timesWatched: 0,
  flaggedWatched: 0,
  overallTimeWatched: 0,
  // stremio-core only pulls notifications for items that are neither removed
  // nor noNotif; this is the second gate.
  noNotif: true,
  season: 0,
  episode: 0,
};

export function hasId(item) {
  return item && typeof item === 'object' && typeof item._id === 'string' && item._id !== '';
}

export function isActive(item) {
  return hasId(item) && item.removed !== true;
}

export function countActive(items) {
  return items.reduce((n, it) => n + (isActive(it) ? 1 : 0), 0);
}

/**
 * A tombstone with nothing left that could put it back on the home screen.
 * Continue Watching filters on `temp` and reads `lastWatched`/`video_id`
 * even for removed items, so `removed: true` alone is not enough.
 */
export function isCleanTombstone(item) {
  if (!hasId(item) || item.removed !== true || item.temp === true) return false;
  const s = item.state || {};
  return Object.entries(ZEROED_STATE).every(([k, v]) => (s[k] ?? v) === v);
}

/**
 * Tombstone built from the FULL original item: Stremio validates the whole
 * struct, and a minimal `{_id, removed}` fails with "JSON unmarshal err".
 */
export function tombstone(item, mtimeIso) {
  return {
    ...item,
    removed: true,
    temp: false,
    state: { ...(item.state || {}), ...ZEROED_STATE },
    _mtime: mtimeIso,
  };
}

/**
 * Capture-side scrub. Stremio's notification worker keeps updating
 * `lastWatched`/`video_id` on tombstoned items; saving that into a snapshot
 * makes removed shows creep back into Continue Watching after a few switches.
 * Active items are left exactly as Stremio returned them.
 */
export function scrubTombstones(items) {
  return items.map((it) => {
    if (!hasId(it) || it.removed !== true || isCleanTombstone(it)) return it;
    return { ...it, temp: false, state: { ...(it.state || {}), ...ZEROED_STATE } };
  });
}

function recency(item) {
  for (const value of [item.state?.lastWatched, item._mtime]) {
    if (value) {
      const t = Date.parse(value);
      if (!Number.isNaN(t)) return t;
    }
  }
  return 0;
}

/**
 * Library full replace as a list of upserts.
 *   - Live items missing from the target are tombstoned (unless already a
 *     clean tombstone, which is the same thing re-written).
 *   - Target items are pushed verbatim (state, temp, removed kept) with
 *     unique `_mtime`s descending by recency: the home Continue Watching row
 *     sorts by `_mtime`, and identical values scramble it.
 *   - Target tombstones over an already-clean live tombstone are skipped.
 * `_mtime` must be an RFC 3339 string; an integer is rejected with a 400.
 */
export function buildLibraryChanges(live, target, now = Date.now()) {
  const liveById = new Map(live.filter(hasId).map((it) => [it._id, it]));
  const targets = target.filter(hasId);
  const targetIds = new Set(targets.map((it) => it._id));
  const nowIso = new Date(now).toISOString();

  const changes = [];
  const stats = { tombstoned: 0, restored: 0, unchanged: 0 };

  for (const [id, item] of liveById) {
    if (targetIds.has(id)) continue;
    if (isCleanTombstone(item)) {
      stats.unchanged++;
      continue;
    }
    changes.push(tombstone(item, nowIso));
    stats.tombstoned++;
  }

  const ordered = targets
    .filter((it) => !(it.removed === true && isCleanTombstone(liveById.get(it._id))))
    .sort((a, b) => recency(b) - recency(a));
  stats.unchanged += targets.length - ordered.length;
  ordered.forEach((item, i) => {
    changes.push({ ...item, _mtime: new Date(now - i).toISOString() });
    stats.restored++;
  });

  return { changes, stats };
}

/**
 * Notification full replace. notifItem has no `removed` field: hide with
 * dismissed/seen/delivered. `_mtime` is left alone (the client never reads it).
 * An empty target still tombstones everything ("clean slate"), otherwise the
 * new profile gets new-episode pings for shows it doesn't follow.
 */
export function buildNotifChanges(live, target) {
  const targetIds = new Set(target.filter(hasId).map((it) => it._id));
  const changes = [];
  const stats = { dismissed: 0, restored: 0 };
  for (const item of live.filter(hasId)) {
    if (targetIds.has(item._id)) continue;
    if (item.dismissed === true && item.seen === true && item.delivered === true) continue;
    changes.push({ ...item, dismissed: true, seen: true, delivered: true });
    stats.dismissed++;
  }
  for (const item of target.filter(hasId)) {
    changes.push({ ...item });
    stats.restored++;
  }
  return { changes, stats };
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
