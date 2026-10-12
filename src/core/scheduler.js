import fs from 'node:fs';
import path from 'node:path';
import { silentLogger } from '../log.js';
import { BIN_DAYS } from './service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_RE = /^openprofiles-(\d{4}-\d{2}-\d{2})\.db$/;
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
 * The once-a-day jobs: database snapshot, each account's automatic backup
 * (skipped when nothing changed) and emptying bins of profiles deleted more
 * than BIN_DAYS ago. One account's failure doesn't stop the others.
 */
export async function runDaily({ db, dataDir, accounts, log = silentLogger, now = () => Date.now(), pause = () => new Promise((r) => setTimeout(r, 2000)) }) {
  const summary = { snapshot: null, backedUp: 0, skipped: 0, failed: 0, purged: 0 };
  try {
    summary.snapshot = snapshotDatabase(db, dataDir, now());
  } catch (err) {
    log.error('Database snapshot failed', { error: err.message });
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
  db.prepare("INSERT INTO meta (key, value) VALUES ('last_daily', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(dayOf(now()));
  log.info('Daily jobs done', { ...summary, snapshot: summary.snapshot ? path.basename(summary.snapshot) : null });
  return summary;
}

/** Runs the daily jobs once per UTC day: shortly after boot if due, then checks hourly. */
export function startScheduler({ db, dataDir, accounts, log = silentLogger }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    const last = db.prepare("SELECT value FROM meta WHERE key = 'last_daily'").get()?.value;
    if (last === dayOf(Date.now())) return;
    running = true;
    try {
      await runDaily({ db, dataDir, accounts, log });
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
  return { stop: () => { clearTimeout(first); clearInterval(every); }, tick };
}
