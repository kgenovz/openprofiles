import fs from 'node:fs';
import path from 'node:path';
import { silentLogger } from '../log.js';
import { BIN_DAYS } from './service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SNAPSHOT_RE = /^openprofiles-(\d{4}-\d{2}-\d{2})\.db$/;
const KEEP_DAILY = 7;
const KEEP_WEEKLY_DAYS = 28;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * A consistent copy of the whole database (VACUUM INTO), one per day, in
 * <dataDir>/snapshots. Keeps the last 7 days plus Sundays of the last 4 weeks.
 * The copies are as encrypted as the database; secret.key is still needed.
 */
export function snapshotDatabase(db, dataDir, now = Date.now()) {
  const dir = path.join(dataDir, 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `openprofiles-${dayOf(now)}.db`);
  if (!fs.existsSync(file)) {
    const partial = `${file}.partial`;
    fs.rmSync(partial, { force: true });
    db.prepare('VACUUM INTO ?').run(partial);
    fs.renameSync(partial, file);
  }
  for (const name of fs.readdirSync(dir)) {
    const m = SNAPSHOT_RE.exec(name);
    if (!m) continue;
    const at = Date.parse(`${m[1]}T00:00:00Z`);
    const age = (Date.parse(`${dayOf(now)}T00:00:00Z`) - at) / DAY_MS;
    const sunday = new Date(at).getUTCDay() === 0;
    if (age < KEEP_DAILY || (sunday && age < KEEP_WEEKLY_DAYS)) continue;
    fs.rmSync(path.join(dir, name), { force: true });
  }
  return file;
}

/**
 * The once-a-day jobs: database snapshot, removing accounts nobody has used
 * for removeUnusedDays (shared servers with ACCESS=open only), each account's
 * automatic backup (skipped when nothing changed) and emptying bins of
 * profiles deleted more than BIN_DAYS ago. One account's failure doesn't stop
 * the others.
 */
export async function runDaily({ db, dataDir, accounts, settings = null, log = silentLogger, now = () => Date.now(), pause = () => new Promise((r) => setTimeout(r, 2000)) }) {
  const summary = { snapshot: null, removed: 0, backedUp: 0, skipped: 0, failed: 0, purged: 0 };
  try {
    summary.snapshot = snapshotDatabase(db, dataDir, now());
  } catch (err) {
    log.error('Database snapshot failed', { error: err.message });
  }
  const days = settings && settings.get('access') === 'open' ? settings.get('removeUnusedDays') : 0;
  if (days > 0) {
    try {
      summary.removed = await accounts.removeUnused(now() - days * DAY_MS);
    } catch (err) {
      log.error('Removing unused accounts failed', { error: err.message });
    }
  }
  const ids = db.prepare('SELECT id FROM accounts ORDER BY id').all().map((r) => r.id);
  for (const [i, id] of ids.entries()) {
    const service = accounts.forAccount(id);
    try {
      const result = await service.autoBackup();
      if (result.done) summary.backedUp++;
      else summary.skipped++;
    } catch (err) {
      summary.failed++;
      log.warn('Daily backup failed for an account', { accountId: id, error: err.userMessage || err.message });
    }
    try {
      summary.purged += service.repo.purgeBin(now() - BIN_DAYS * DAY_MS);
    } catch (err) {
      log.warn('Emptying the bin failed for an account', { accountId: id, error: err.message });
    }
    if (i < ids.length - 1) await pause();
  }
  const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  setMeta.run('last_daily', dayOf(now()));
  // Counts only, for the Server tab.
  setMeta.run('last_daily_summary', JSON.stringify({ at: now(), ...summary, snapshot: Boolean(summary.snapshot) }));
  log.info('Daily jobs done', { ...summary, snapshot: summary.snapshot ? path.basename(summary.snapshot) : null });
  return summary;
}

/** How often titles still playing elsewhere after a switch are checked (core/carryover.js). */
export const CARRYOVER_CHECK_MS = 3 * 60 * 1000;

/** One round of the check, for every account following such titles. Returns how many were put back. */
export async function checkCarryovers({ accounts, log = silentLogger }) {
  let settled = 0;
  for (const id of accounts.accounts.withCarryovers()) {
    try {
      settled += (await accounts.forAccount(id).checkCarryovers()).settled;
    } catch (err) {
      log.warn('Checking titles played elsewhere failed for an account', { accountId: id, error: err.userMessage || err.message });
    }
  }
  return settled;
}

/**
 * Runs the daily jobs once per UTC day (shortly after boot if due, then
 * checks hourly), and the carry-over check every CARRYOVER_CHECK_MS.
 */
export function startScheduler({ db, dataDir, accounts, settings = null, log = silentLogger }) {
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      await checkCarryovers({ accounts, log });
    } finally {
      checking = false;
    }
  };
  const carry = setInterval(check, CARRYOVER_CHECK_MS);
  carry.unref();

  let running = false;
  const tick = async () => {
    if (running) return;
    const last = db.prepare("SELECT value FROM meta WHERE key = 'last_daily'").get()?.value;
    if (last === dayOf(Date.now())) return;
    running = true;
    try {
      await runDaily({ db, dataDir, accounts, settings, log });
    } catch (err) {
      log.error('Daily jobs failed', { error: err.message });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 2 * 60 * 1000);
  const every = setInterval(tick, 60 * 60 * 1000);
  first.unref();
  every.unref();
  return { stop: () => { clearTimeout(first); clearInterval(every); clearInterval(carry); }, tick, check };
}
