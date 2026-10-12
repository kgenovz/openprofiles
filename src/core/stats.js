import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { SNAPSHOT_RE } from './scheduler.js';

const { version } = createRequire(import.meta.url)('../../package.json');

const DAY_MS = 24 * 60 * 60 * 1000;
const UNUSED_DAYS = 60;
const LATE_MS = 26 * 60 * 60 * 1000;

const fileSize = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

/**
 * What the Server tab shows: counts and server facts only. Nothing here may
 * name, or let anyone pick out, an account: no emails, ids, profile names or
 * per-account rows, and errors are grouped by their fixed log message.
 */
export function serverStats({ db, dataDir, settings, log, startedAt, now = Date.now() }) {
  const one = (sql, ...args) => db.prepare(sql).get(...args).n;
  const weekAgo = now - 7 * DAY_MS;

  // "Used": signed in, seen on the page, or did anything (a switch from Stremio counts) in the window.
  const usedSince = `(a.last_login_at > @since
    OR EXISTS (SELECT 1 FROM activity WHERE account_id = a.id AND at > @since)
    OR EXISTS (SELECT 1 FROM sessions WHERE account_id = a.id AND last_seen_at > @since))`;
  const access = settings.access();
  const accounts = {
    total: one('SELECT COUNT(*) AS n FROM accounts'),
    mode: access.mode,
    limit: access.mode === 'open' && Number.isFinite(access.maxAccounts) ? access.maxAccounts : null,
    newThisWeek: one('SELECT COUNT(*) AS n FROM accounts WHERE created_at > ?', weekAgo),
    usedThisWeek: db.prepare(`SELECT COUNT(*) AS n FROM accounts a WHERE ${usedSince}`).get({ since: weekAgo }).n,
    installed: one('SELECT COUNT(*) AS n FROM accounts WHERE addon_installed = 1'),
    unused: db.prepare(`SELECT COUNT(*) AS n FROM accounts a WHERE a.created_at <= @since AND NOT ${usedSince}`)
      .get({ since: now - UNUSED_DAYS * DAY_MS }).n,
    unusedDays: UNUSED_DAYS,
  };

  const perDay = [];
  for (let i = 6; i >= 0; i--) {
    perDay.push(one("SELECT COUNT(*) AS n FROM switch_journal WHERE kind = 'switch' AND started_at > ? AND started_at <= ?",
      now - (i + 1) * DAY_MS, now - i * DAY_MS));
  }
  const switches = {
    perDay,
    week: perDay.reduce((a, b) => a + b, 0),
    today: perDay[6],
    restoresThisWeek: one("SELECT COUNT(*) AS n FROM switch_journal WHERE kind = 'restore' AND started_at > ?", weekAgo),
    unfinished: one("SELECT COUNT(*) AS n FROM switch_journal WHERE status = 'open'"),
    rolledBackThisWeek: one("SELECT COUNT(*) AS n FROM switch_journal WHERE status = 'rolled_back' AND started_at > ?", weekAgo),
  };

  const meta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  let summary = null;
  try {
    summary = JSON.parse(meta('last_daily_summary'));
  } catch {
    // never ran, or written by an older version
  }
  let snapshots = { daily: 0, weekly: 0 };
  try {
    const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
    for (const name of fs.readdirSync(path.join(dataDir, 'snapshots'))) {
      const m = SNAPSHOT_RE.exec(name);
      if (!m) continue;
      if (today - Date.parse(`${m[1]}T00:00:00Z`) < 7 * DAY_MS) snapshots.daily++;
      else snapshots.weekly++;
    }
  } catch {
    snapshots = null;
  }
  const lastDay = meta('last_daily');
  const daily = {
    lastDay,
    summary,
    snapshots,
    // They run once a UTC day, checked hourly: a server up for a day with no run since is behind.
    late: now - startedAt > LATE_MS && (summary == null || now - summary.at > LATE_MS),
  };

  let diskFree = null;
  try {
    const fsStats = fs.statfsSync(dataDir);
    diskFree = fsStats.bavail * fsStats.bsize;
  } catch {
    // not supported here
  }
  const dbFile = db.name && db.name !== ':memory:' ? db.name : null;
  const server = {
    version,
    node: process.version,
    uptimeMs: now - startedAt,
    memory: process.memoryUsage().rss,
    database: dbFile ? fileSize(dbFile) + fileSize(`${dbFile}-wal`) : null,
    diskFree,
    profiles: one('SELECT COUNT(*) AS n FROM profiles WHERE deleted_at IS NULL'),
    backups: one('SELECT COUNT(*) AS n FROM backups'),
  };

  const problems = (log.problems?.() ?? []).map(({ level, message, count, last }) => ({ level, message, count, last }));
  return { accounts, switches, daily, server, problems, startedAt };
}
