import { countActive } from './library.js';

export const BACKUP_RETENTION = {
  original: Infinity,
  auto: 7,
  pre_switch: 5,
  pre_restore: 3,
  manual: 10,
  imported: 10,
};

const PROFILE_META = `id, name, avatar_preset, avatar_colour, library_count, addon_count, notif_count,
  snapshot_taken_at, stremio_user_id, created_at`;
const BACKUP_META = `id, kind, label, library_count, addon_count, notif_count, stremio_user_id, created_at`;

/** All SQL lives here. Blobs are encrypted on the way in; callers decode via guard.js. */
export class Repo {
  constructor(db, cipher, now = () => Date.now()) {
    this.db = db;
    this.cipher = cipher;
    this.now = now;
  }

  transaction(fn) {
    return this.db.transaction(fn)();
  }

  encodeSnapshot({ library, addons, notifs }) {
    return {
      library_enc: this.cipher.encryptJson(library, 'library'),
      addons_enc: this.cipher.encryptJson(addons, 'addons'),
      notifs_enc: notifs == null ? null : this.cipher.encryptJson(notifs, 'notifs'),
      library_count: countActive(library),
      addon_count: addons.length,
      notif_count: notifs == null ? null : notifs.length,
    };
  }

  // ── account ──────────────────────────────────────────────────────────────

  getAccount() {
    return this.db.prepare('SELECT * FROM account WHERE id = 1').get() || null;
  }

  insertAccount({ stremioUserId, email, authKey }) {
    this.db.prepare(`INSERT INTO account (id, stremio_user_id, stremio_email, auth_key_enc, linked_at)
      VALUES (1, ?, ?, ?, ?)`).run(stremioUserId, email, this.cipher.encryptJson(authKey, 'authkey'), this.now());
  }

  updateAuthKey({ email, authKey }) {
    this.db.prepare('UPDATE account SET stremio_email = ?, auth_key_enc = ?, linked_at = ? WHERE id = 1')
      .run(email, this.cipher.encryptJson(authKey, 'authkey'), this.now());
  }

  getAuthKey() {
    const row = this.getAccount();
    return row ? this.cipher.decryptJson(row.auth_key_enc, 'authkey') : null;
  }

  // ── state ────────────────────────────────────────────────────────────────

  getState() {
    return this.db.prepare('SELECT * FROM state WHERE id = 1').get() || null;
  }

  initState({ activeProfileId, addonToken }) {
    this.db.prepare('INSERT INTO state (id, active_profile_id, addon_token) VALUES (1, ?, ?)').run(activeProfileId, addonToken);
  }

  setActiveProfile(id) {
    this.db.prepare('UPDATE state SET active_profile_id = ? WHERE id = 1').run(id);
  }

  setAddonToken(token) {
    this.db.prepare('UPDATE state SET addon_token = ? WHERE id = 1').run(token);
  }

  // ── profiles ─────────────────────────────────────────────────────────────

  listProfiles() {
    return this.db.prepare(`SELECT ${PROFILE_META} FROM profiles ORDER BY created_at, id`).all();
  }

  getProfile(id) {
    return this.db.prepare(`SELECT ${PROFILE_META} FROM profiles WHERE id = ?`).get(id) || null;
  }

  /** Includes the encrypted blobs. */
  getProfileRow(id) {
    return this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) || null;
  }

  insertProfile({ name, avatarPreset, avatarColour, stremioUserId, snapshot }) {
    const enc = this.encodeSnapshot(snapshot);
    const now = this.now();
    const info = this.db.prepare(`INSERT INTO profiles
      (name, avatar_preset, avatar_colour, library_enc, addons_enc, notifs_enc, library_count, addon_count,
       notif_count, snapshot_taken_at, stremio_user_id, created_at)
      VALUES (@name, @avatarPreset, @avatarColour, @library_enc, @addons_enc, @notifs_enc, @library_count,
       @addon_count, @notif_count, @now, @stremioUserId, @now)`)
      .run({ name, avatarPreset, avatarColour, stremioUserId, now, ...enc });
    return Number(info.lastInsertRowid);
  }

  /** `snapshot.notifs === null` keeps the previously saved notifications. */
  saveProfileSnapshot(id, snapshot) {
    const enc = this.encodeSnapshot(snapshot);
    const keepNotifs = snapshot.notifs == null;
    this.db.prepare(`UPDATE profiles SET library_enc = @library_enc, addons_enc = @addons_enc,
        library_count = @library_count, addon_count = @addon_count, snapshot_taken_at = @now
        ${keepNotifs ? '' : ', notifs_enc = @notifs_enc, notif_count = @notif_count'}
      WHERE id = @id`).run({ id, now: this.now(), ...enc });
  }

  renameProfile(id, name) {
    this.db.prepare('UPDATE profiles SET name = ? WHERE id = ?').run(name, id);
  }

  setProfileAvatar(id, preset, colour) {
    this.db.prepare('UPDATE profiles SET avatar_preset = ?, avatar_colour = ? WHERE id = ?').run(preset, colour, id);
  }

  deleteProfile(id) {
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  }

  // ── backups ──────────────────────────────────────────────────────────────

  insertBackup({ kind, label, stremioUserId, snapshot }) {
    const enc = this.encodeSnapshot(snapshot);
    const info = this.db.prepare(`INSERT INTO backups
      (kind, label, library_enc, addons_enc, notifs_enc, library_count, addon_count, notif_count, stremio_user_id, created_at)
      VALUES (@kind, @label, @library_enc, @addons_enc, @notifs_enc, @library_count, @addon_count, @notif_count,
       @stremioUserId, @now)`)
      .run({ kind, label, stremioUserId, now: this.now(), ...enc });
    return Number(info.lastInsertRowid);
  }

  listBackups() {
    return this.db.prepare(`SELECT ${BACKUP_META} FROM backups ORDER BY created_at DESC, id DESC`).all();
  }

  getBackup(id) {
    return this.db.prepare(`SELECT ${BACKUP_META} FROM backups WHERE id = ?`).get(id) || null;
  }

  getBackupRow(id) {
    return this.db.prepare('SELECT * FROM backups WHERE id = ?').get(id) || null;
  }

  deleteBackup(id) {
    this.db.prepare('DELETE FROM backups WHERE id = ?').run(id);
  }

  /** Backups an open journal row may still need for recovery. */
  pinnedBackupIds() {
    const rows = this.db.prepare(`SELECT target_backup_id, rollback_backup_id FROM switch_journal WHERE status = 'open'`).all();
    return new Set(rows.flatMap((r) => [r.target_backup_id, r.rollback_backup_id]).filter((id) => id != null));
  }

  /** Apply BACKUP_RETENTION, newest kept. Returns how many were deleted. */
  pruneBackups() {
    const pinned = this.pinnedBackupIds();
    let deleted = 0;
    for (const [kind, keep] of Object.entries(BACKUP_RETENTION)) {
      if (keep === Infinity) continue;
      const rows = this.db.prepare('SELECT id FROM backups WHERE kind = ? ORDER BY created_at DESC, id DESC').all(kind);
      for (const { id } of rows.slice(keep)) {
        if (pinned.has(id)) continue;
        this.deleteBackup(id);
        deleted++;
      }
    }
    return deleted;
  }

  // ── journal ──────────────────────────────────────────────────────────────

  startJournal({ kind, fromProfileId, toProfileId, targetBackupId = null, rollbackBackupId }) {
    const info = this.db.prepare(`INSERT INTO switch_journal
      (kind, from_profile_id, to_profile_id, target_backup_id, rollback_backup_id, phase, status, started_at)
      VALUES (?, ?, ?, ?, ?, 'saved', 'open', ?)`)
      .run(kind, fromProfileId, toProfileId, targetBackupId, rollbackBackupId, this.now());
    return Number(info.lastInsertRowid);
  }

  setJournalPhase(id, phase) {
    this.db.prepare('UPDATE switch_journal SET phase = ? WHERE id = ?').run(phase, id);
  }

  failJournal(id, error) {
    this.db.prepare('UPDATE switch_journal SET error = ? WHERE id = ?').run(String(error).slice(0, 500), id);
  }

  closeJournal(id, status, warnings = []) {
    this.db.prepare(`UPDATE switch_journal SET status = ?, phase = 'done', finished_at = ?, error = NULL, warnings = ? WHERE id = ?`)
      .run(status, this.now(), JSON.stringify(warnings), id);
  }

  getOpenJournal() {
    const row = this.db.prepare(`SELECT * FROM switch_journal WHERE status = 'open' ORDER BY id DESC LIMIT 1`).get();
    return row ? { ...row, warnings: JSON.parse(row.warnings) } : null;
  }

  recentJournal(limit = 10) {
    return this.db.prepare('SELECT * FROM switch_journal ORDER BY id DESC LIMIT ?').all(limit)
      .map((row) => ({ ...row, warnings: JSON.parse(row.warnings) }));
  }
}
