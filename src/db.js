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
  // Phase 2 / M4: many Stremio accounts per server. `account` + `state` become
  // `accounts`; everything else gains account_id. The existing account becomes
  // account 1 with its add-on token unchanged (installed add-ons keep working).
  // Blobs are re-encrypted to the per-account scheme by core/rekey.js
  // (enc_version 1 → 2). Old sessions are dropped: everyone signs in again.
  // Profile names are unique per account among profiles not in the bin.
  {
    foreignKeysOff: true,
    sql: `
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    stremio_user_id TEXT NOT NULL UNIQUE,
    stremio_email TEXT NOT NULL,
    auth_key_enc BLOB NOT NULL,
    addon_token TEXT NOT NULL UNIQUE,
    active_profile_id INTEGER REFERENCES profiles (id) ON DELETE SET NULL,
    addon_installed INTEGER,
    enc_version INTEGER NOT NULL DEFAULT 2,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL
  );
  INSERT INTO accounts (id, stremio_user_id, stremio_email, auth_key_enc, addon_token, active_profile_id,
    addon_installed, enc_version, created_at, last_login_at)
    SELECT 1, a.stremio_user_id, a.stremio_email, a.auth_key_enc, s.addon_token, s.active_profile_id,
      s.addon_installed, 1, a.linked_at, a.linked_at
    FROM account a JOIN state s ON s.id = 1 WHERE a.id = 1;

  CREATE TABLE profiles_new (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    avatar_preset TEXT NOT NULL,
    avatar_colour TEXT NOT NULL,
    library_enc BLOB NOT NULL,
    addons_enc BLOB NOT NULL,
    notifs_enc BLOB,
    library_count INTEGER NOT NULL,
    addon_count INTEGER NOT NULL,
    notif_count INTEGER,
    snapshot_taken_at INTEGER NOT NULL,
    stremio_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER                 -- set: in the bin (M5)
  );
  INSERT INTO profiles_new (id, account_id, name, avatar_preset, avatar_colour, library_enc, addons_enc, notifs_enc,
    library_count, addon_count, notif_count, snapshot_taken_at, stremio_user_id, created_at)
    SELECT id, 1, name, avatar_preset, avatar_colour, library_enc, addons_enc, notifs_enc,
      library_count, addon_count, notif_count, snapshot_taken_at, stremio_user_id, created_at FROM profiles;
  DROP TABLE profiles;
  ALTER TABLE profiles_new RENAME TO profiles;
  CREATE UNIQUE INDEX profiles_account_name ON profiles (account_id, name) WHERE deleted_at IS NULL;
  CREATE INDEX profiles_account ON profiles (account_id);

  CREATE TABLE backups_new (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('original', 'auto', 'pre_switch', 'pre_restore', 'pre_change', 'manual', 'imported')),
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
  INSERT INTO backups_new (id, account_id, kind, label, library_enc, addons_enc, notifs_enc, library_count,
    addon_count, notif_count, stremio_user_id, created_at)
    SELECT id, 1, kind, label, library_enc, addons_enc, notifs_enc, library_count, addon_count, notif_count,
      stremio_user_id, created_at FROM backups;
  DROP TABLE backups;
  ALTER TABLE backups_new RENAME TO backups;
  CREATE INDEX backups_account_kind_created ON backups (account_id, kind, created_at);

  CREATE TABLE switch_journal_new (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
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
  INSERT INTO switch_journal_new (id, account_id, kind, from_profile_id, to_profile_id, target_backup_id,
    rollback_backup_id, phase, status, started_at, finished_at, error, warnings)
    SELECT id, 1, kind, from_profile_id, to_profile_id, target_backup_id, rollback_backup_id, phase, status,
      started_at, finished_at, error, warnings FROM switch_journal;
  DROP TABLE switch_journal;
  ALTER TABLE switch_journal_new RENAME TO switch_journal;
  CREATE INDEX switch_journal_account_status ON switch_journal (account_id, status);

  DROP TABLE sessions;
  CREATE TABLE sessions (
    id_hash BLOB PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    flash TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_account ON sessions (account_id);

  DROP TABLE state;
  DROP TABLE account;
  `,
  },
  // M5: nothing gets lost.
  //   backups.content_hash  lets the daily backup skip a day when nothing changed
  //   backups.profile_id    which profile a pre_change backup was taken of (undo for edits)
  //   activity              per-account log shown on the Account tab
  //   meta                  server facts, e.g. the secret key's fingerprint (checked at boot)
  `
  ALTER TABLE backups ADD COLUMN content_hash TEXT;
  ALTER TABLE backups ADD COLUMN profile_id INTEGER REFERENCES profiles (id) ON DELETE SET NULL;

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX activity_account_at ON activity (account_id, at);

  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // M6: edits and their undo.
  //   backups.edit_kind  for pre_change backups: 'addons' | 'cinemeta' (offered as Undo for 24 h) | 'undo'
  //   backups.undone_at  set once that edit has been undone
  `
  ALTER TABLE backups ADD COLUMN edit_kind TEXT;
  ALTER TABLE backups ADD COLUMN undone_at INTEGER;
  `,
  // Review round, 2026-10-12.
  //   backups.after_hash        for edits: the add-on list the edit wrote, so undo can tell
  //                             whether anything changed since (and refuse rather than clobber it)
  //   accounts.notifs_foreign   1 when Stremio's notifications aren't the active profile's (a
  //                             switch couldn't swap them), so they aren't saved into it later
  `
  ALTER TABLE backups ADD COLUMN after_hash TEXT;
  ALTER TABLE accounts ADD COLUMN notifs_foreign INTEGER NOT NULL DEFAULT 0;
  `,
  // The Server tab (2026-10-12).
  //   settings               what the owner set on the Server tab; each row overrides its env var
  //   meta.owner_account_id  the account that runs the server: the first one to sign in
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO meta (key, value) SELECT 'owner_account_id', CAST(MIN(id) AS TEXT) FROM accounts HAVING COUNT(*) > 0;
  `,
  // Uploaded profile photos (2026-10-12), one per profile.
  //   profiles.photo_enc   the photo as a 512 px JPEG, encrypted like the rest of the profile
  //   profiles.photo_hash  its fingerprint; avatar_preset 'photo:<hash>' shows it
  `
  ALTER TABLE profiles ADD COLUMN photo_enc BLOB;
  ALTER TABLE profiles ADD COLUMN photo_hash TEXT;
  `,
  // Unused accounts (v1, 2026-10-12).
  //   accounts.last_addon_at  when Stremio last asked this account's add-on for anything (written
  //                           at most hourly), so an account used only from Stremio counts as used.
  //                           Accounts already here start from now: nobody is removed for the time
  //                           before this was recorded.
  `
  ALTER TABLE accounts ADD COLUMN last_addon_at INTEGER;
  UPDATE accounts SET last_addon_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
  `,
  // Titles still playing on another device when a switch happened (2026-10-12, core/carryover.js).
  //   item_enc    encrypted { base, written, seenMtime }: the owner's copy at the switch, what the
  //               switch wrote for the title, and the last save seen from the device
  //   changed_at  when the owner's playback was last seen moving
  `
  CREATE TABLE carryovers (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    owner_profile_id INTEGER NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    item_enc BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    changed_at INTEGER,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX carryovers_account ON carryovers (account_id);
  `,
  // Review round 2 (2026-10-12).
  //   meta.owner_stremio_user_id  the owner by Stremio user id: account ids can be used again after
  //                               a deletion, so the owner must not be one. Taken from
  //                               owner_account_id, which goes; '' when that account is gone
  //                               already, so nobody signing up later inherits the server.
  //   accounts.last_seen_at       when the pages were last visited (written at most hourly). Session
  //                               rows go when they expire or on sign-out, so they can't say it.
  //                               Accounts already here start from their latest session or sign-in.
  `
  INSERT INTO meta (key, value)
    SELECT 'owner_stremio_user_id', COALESCE((SELECT a.stremio_user_id FROM accounts a WHERE a.id = CAST(m.value AS INTEGER)), '')
    FROM meta m WHERE m.key = 'owner_account_id';
  DELETE FROM meta WHERE key = 'owner_account_id';
  ALTER TABLE accounts ADD COLUMN last_seen_at INTEGER;
  UPDATE accounts SET last_seen_at = COALESCE((SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.account_id = accounts.id), last_login_at);
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

/** `upTo` stops at an older schema version (tests use it to build pre-upgrade databases). */
export function migrate(db, { upTo = MIGRATIONS.length } = {}) {
  const current = db.pragma('user_version', { simple: true });
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema v${current} is newer than this build (v${MIGRATIONS.length}). Upgrade OpenProfiles.`);
  }
  for (let v = current; v < upTo; v++) {
    const step = typeof MIGRATIONS[v] === 'string' ? { sql: MIGRATIONS[v] } : MIGRATIONS[v];
    // Table rebuilds need foreign keys off, and the pragma can't change inside a transaction.
    if (step.foreignKeysOff) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(step.sql);
        if (step.foreignKeysOff) {
          const broken = db.pragma('foreign_key_check');
          if (broken.length) throw new Error(`Migration ${v + 1} left ${broken.length} broken foreign keys`);
        }
        db.pragma(`user_version = ${v + 1}`);
      })();
    } finally {
      if (step.foreignKeysOff) db.pragma('foreign_keys = ON');
    }
  }
}
