import path from 'node:path';
import Database from 'better-sqlite3';

// Each entry upgrades the schema by one version (tracked in PRAGMA user_version).
const MIGRATIONS = [
  `
  CREATE TABLE account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    stremio_user_id TEXT NOT NULL,
    stremio_email TEXT NOT NULL,
    auth_key_enc BLOB NOT NULL,
    linked_at INTEGER NOT NULL
  );

  CREATE TABLE profiles (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    avatar_preset TEXT NOT NULL,
    avatar_colour TEXT NOT NULL,
    library_enc BLOB NOT NULL,
    addons_enc BLOB NOT NULL,
    notifs_enc BLOB,                    -- NULL: never read successfully
    library_count INTEGER NOT NULL,     -- excludes tombstones
    addon_count INTEGER NOT NULL,
    notif_count INTEGER,
    snapshot_taken_at INTEGER NOT NULL,
    stremio_user_id TEXT NOT NULL,      -- account anchor
    created_at INTEGER NOT NULL
  );

  CREATE TABLE backups (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('original', 'auto', 'pre_switch', 'pre_restore', 'manual', 'imported')),
    label TEXT NOT NULL,
    library_enc BLOB NOT NULL,
    addons_enc BLOB NOT NULL,
    notifs_enc BLOB,
    library_count INTEGER NOT NULL,
    addon_count INTEGER NOT NULL,
    notif_count INTEGER,
    stremio_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX backups_kind_created ON backups (kind, created_at);

  CREATE TABLE state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active_profile_id INTEGER REFERENCES profiles (id),
    addon_token TEXT NOT NULL
  );

  -- One row per switch or restore. A row with status 'open' means the write
  -- to Stremio started and never finished; the web page offers recovery.
  CREATE TABLE switch_journal (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('switch', 'restore')),
    from_profile_id INTEGER REFERENCES profiles (id) ON DELETE SET NULL,
    to_profile_id INTEGER REFERENCES profiles (id) ON DELETE SET NULL,
    target_backup_id INTEGER REFERENCES backups (id) ON DELETE SET NULL,
    rollback_backup_id INTEGER REFERENCES backups (id) ON DELETE SET NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'finished', 'rolled_back')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    error TEXT,
    warnings TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX switch_journal_status ON switch_journal (status);

  CREATE TABLE sessions (
    id_hash BLOB PRIMARY KEY,
    csrf TEXT NOT NULL,
    flash TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  // M2: remember whether the add-on is installed (as of the last read of the
  // account's add-ons), and move to the darker avatar colours that keep white
  // poster text readable.
  `
  ALTER TABLE state ADD COLUMN addon_installed INTEGER;
  UPDATE profiles SET avatar_colour = CASE avatar_colour
    WHEN '#f76b15' THEN '#e05d0c'
    WHEN '#e2a336' THEN '#b7790b'
    WHEN '#46a758' THEN '#3b8f4b'
    WHEN '#12a594' THEN '#0f8f80'
    WHEN '#0090ff' THEN '#0a7fe0'
    ELSE avatar_colour END;
  `,
];

export function openDatabase(dataDir, { filename = 'openprofiles.db' } = {}) {
  const db = new Database(filename === ':memory:' ? ':memory:' : path.join(dataDir, filename));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema v${current} is newer than this build (v${MIGRATIONS.length}). Upgrade OpenProfiles.`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
