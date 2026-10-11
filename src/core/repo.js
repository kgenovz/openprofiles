import crypto from 'node:crypto';
import { randomToken } from '../crypto.js';
import { countActive } from './library.js';

export const BACKUP_RETENTION = {
  original: Infinity,
  auto: 14,
  pre_switch: 5,
  pre_restore: 3,
  pre_change: 20,
  manual: 10,
  imported: 10,
};

const PROFILE_META = `id, name, avatar_preset, avatar_colour, library_count, addon_count, notif_count,
  snapshot_taken_at, stremio_user_id, created_at`;
const BACKUP_META = `id, kind, label, library_count, addon_count, notif_count, stremio_user_id, created_at, profile_id, edit_kind`;
const ACTIVITY_KEEP = 200;

/** Stable fingerprint of a snapshot's content, to tell whether anything changed since a backup. */
export function snapshotHash({ library, addons, notifs }) {
  return crypto.createHash('sha256').update(JSON.stringify([library, addons, notifs ?? null])).digest('hex');
}
const ACCOUNT_COLUMNS = `id, stremio_user_id, stremio_email, auth_key_enc, addon_token, active_profile_id,
  addon_installed, enc_version, created_at, last_login_at, created_at AS linked_at`;

/**
 * Encryption bound to one account: every blob's associated data carries the
 * account id, so a blob copied into another account's rows won't decrypt.
 */
export function accountCipher(cipher, accountId) {
  return {
    encryptJson: (value, purpose) => cipher.encryptJson(value, `${purpose}:${accountId}`),
    decryptJson: (blob, purpose) => cipher.decryptJson(blob, `${purpose}:${accountId}`),
  };
}

/**
 * All SQL for one account. Every query is scoped to `accountId`, so nothing
 * here can read or write another account's rows. Blobs are encrypted on the
 * way in; callers decode via guard.js using `this.cipher`.
 */
export class AccountRepo {
  constructor(db, cipher, accountId, now = () => Date.now()) {
    this.db = db;
    this.accountId = accountId;
    this.cipher = accountCipher(cipher, accountId);
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
    return this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).get(this.accountId) || null;
  }

  updateAuthKey({ email, authKey }) {
    this.db.prepare('UPDATE accounts SET stremio_email = ?, auth_key_enc = ?, last_login_at = ? WHERE id = ?')
      .run(email, this.cipher.encryptJson(authKey, 'authkey'), this.now(), this.accountId);
  }

  getAuthKey() {
    const row = this.getAccount();
    return row ? this.cipher.decryptJson(row.auth_key_enc, 'authkey') : null;
  }

  // ── state (lives on the account row) ─────────────────────────────────────

  getState() {
    return this.db.prepare('SELECT active_profile_id, addon_token, addon_installed FROM accounts WHERE id = ?')
      .get(this.accountId) || null;
  }

  setActiveProfile(id) {
    this.db.prepare('UPDATE accounts SET active_profile_id = ? WHERE id = ?').run(id, this.accountId);
  }

  setAddonToken(token) {
    this.db.prepare('UPDATE accounts SET addon_token = ? WHERE id = ?').run(token, this.accountId);
  }

  setAddonInstalled(installed) {
    this.db.prepare('UPDATE accounts SET addon_installed = ? WHERE id = ?').run(installed ? 1 : 0, this.accountId);
  }

  // ── profiles ─────────────────────────────────────────────────────────────

  listProfiles() {
    return this.db.prepare(`SELECT ${PROFILE_META} FROM profiles
      WHERE account_id = ? AND deleted_at IS NULL ORDER BY created_at, id`).all(this.accountId);
  }

  getProfile(id) {
    return this.db.prepare(`SELECT ${PROFILE_META} FROM profiles
      WHERE id = ? AND account_id = ? AND deleted_at IS NULL`).get(id, this.accountId) || null;
  }

  /** Includes the encrypted blobs. */
  getProfileRow(id) {
    return this.db.prepare('SELECT * FROM profiles WHERE id = ? AND account_id = ? AND deleted_at IS NULL')
      .get(id, this.accountId) || null;
  }

  insertProfile({ name, avatarPreset, avatarColour, stremioUserId, snapshot }) {
    const enc = this.encodeSnapshot(snapshot);
    const now = this.now();
    const info = this.db.prepare(`INSERT INTO profiles
      (account_id, name, avatar_preset, avatar_colour, library_enc, addons_enc, notifs_enc, library_count, addon_count,
       notif_count, snapshot_taken_at, stremio_user_id, created_at)
      VALUES (@accountId, @name, @avatarPreset, @avatarColour, @library_enc, @addons_enc, @notifs_enc, @library_count,
       @addon_count, @notif_count, @now, @stremioUserId, @now)`)
      .run({ accountId: this.accountId, name, avatarPreset, avatarColour, stremioUserId, now, ...enc });
    return Number(info.lastInsertRowid);
  }

  /** `snapshot.notifs === null` keeps the previously saved notifications. */
  saveProfileSnapshot(id, snapshot) {
    const enc = this.encodeSnapshot(snapshot);
    const keepNotifs = snapshot.notifs == null;
    this.db.prepare(`UPDATE profiles SET library_enc = @library_enc, addons_enc = @addons_enc,
        library_count = @library_count, addon_count = @addon_count, snapshot_taken_at = @now
        ${keepNotifs ? '' : ', notifs_enc = @notifs_enc, notif_count = @notif_count'}
      WHERE id = @id AND account_id = @accountId`).run({ id, accountId: this.accountId, now: this.now(), ...enc });
  }

  /** Replace only the saved add-on list; the library, notifications and "saved at" time stay. */
  saveProfileAddons(id, addons) {
    this.db.prepare('UPDATE profiles SET addons_enc = ?, addon_count = ? WHERE id = ? AND account_id = ?')
      .run(this.cipher.encryptJson(addons, 'addons'), addons.length, id, this.accountId);
  }

  renameProfile(id, name) {
    this.db.prepare('UPDATE profiles SET name = ? WHERE id = ? AND account_id = ?').run(name, id, this.accountId);
  }

  setProfileAvatar(id, preset, colour) {
    this.db.prepare('UPDATE profiles SET avatar_preset = ?, avatar_colour = ? WHERE id = ? AND account_id = ?')
      .run(preset, colour, id, this.accountId);
  }

  countProfiles() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ? AND deleted_at IS NULL').get(this.accountId).n;
  }

  // ── the bin (deleted profiles, kept BIN_DAYS) ────────────────────────────

  moveProfileToBin(id) {
    this.db.prepare('UPDATE profiles SET deleted_at = ? WHERE id = ? AND account_id = ? AND deleted_at IS NULL')
      .run(this.now(), id, this.accountId);
  }

  listBin() {
    return this.db.prepare(`SELECT ${PROFILE_META}, deleted_at FROM profiles
      WHERE account_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`).all(this.accountId);
  }

  getBinProfile(id) {
    return this.db.prepare(`SELECT ${PROFILE_META}, deleted_at FROM profiles
      WHERE id = ? AND account_id = ? AND deleted_at IS NOT NULL`).get(id, this.accountId) || null;
  }

  restoreProfileFromBin(id, name) {
    this.db.prepare('UPDATE profiles SET deleted_at = NULL, name = ? WHERE id = ? AND account_id = ?').run(name, id, this.accountId);
  }

  /** Permanently remove bin entries deleted before `before` (ms). Returns how many. */
  purgeBin(before) {
    return this.db.prepare('DELETE FROM profiles WHERE account_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?')
      .run(this.accountId, before).changes;
  }

  // ── activity log ─────────────────────────────────────────────────────────

  logActivity(kind, detail) {
    this.db.prepare('INSERT INTO activity (account_id, at, kind, detail) VALUES (?, ?, ?, ?)')
      .run(this.accountId, this.now(), kind, String(detail).slice(0, 300));
    this.db.prepare(`DELETE FROM activity WHERE account_id = ? AND id NOT IN
      (SELECT id FROM activity WHERE account_id = ? ORDER BY id DESC LIMIT ${ACTIVITY_KEEP})`).run(this.accountId, this.accountId);
  }

  listActivity(limit = 30) {
    return this.db.prepare('SELECT at, kind, detail FROM activity WHERE account_id = ? ORDER BY id DESC LIMIT ?')
      .all(this.accountId, limit);
  }

  // ── backups ──────────────────────────────────────────────────────────────

  /**
   * `profileId`: for pre_change backups, the profile whose saved state this is (undo puts it back there).
   * `editKind`: for pre_change backups, what the edit was ('addons' | 'cinemeta' | 'undo').
   */
  insertBackup({ kind, label, stremioUserId, snapshot, profileId = null, editKind = null }) {
    const enc = this.encodeSnapshot(snapshot);
    const info = this.db.prepare(`INSERT INTO backups
      (account_id, kind, label, library_enc, addons_enc, notifs_enc, library_count, addon_count, notif_count,
       stremio_user_id, created_at, content_hash, profile_id, edit_kind)
      VALUES (@accountId, @kind, @label, @library_enc, @addons_enc, @notifs_enc, @library_count, @addon_count,
       @notif_count, @stremioUserId, @now, @contentHash, @profileId, @editKind)`)
      .run({ accountId: this.accountId, kind, label, stremioUserId, now: this.now(), contentHash: snapshotHash(snapshot), profileId, editKind, ...enc });
    return Number(info.lastInsertRowid);
  }

  /** The newest add-on or Cinemeta edit since `since` that hasn't been undone, if its profile still exists. */
  latestUndoableEdit(since) {
    return this.db.prepare(`SELECT b.id, b.label, b.created_at, b.edit_kind, b.profile_id, p.name AS profile_name
      FROM backups b JOIN profiles p ON p.id = b.profile_id AND p.deleted_at IS NULL
      WHERE b.account_id = ? AND b.kind = 'pre_change' AND b.edit_kind IN ('addons', 'cinemeta')
        AND b.undone_at IS NULL AND b.created_at >= ?
      ORDER BY b.created_at DESC, b.id DESC LIMIT 1`).get(this.accountId, since) || null;
  }

  markUndone(id) {
    this.db.prepare('UPDATE backups SET undone_at = ? WHERE id = ? AND account_id = ?').run(this.now(), id, this.accountId);
  }

  /** Newest backup of a kind (metadata and hash only), or null. */
  latestBackup(kind) {
    return this.db.prepare(`SELECT ${BACKUP_META}, content_hash FROM backups WHERE account_id = ? AND kind = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(this.accountId, kind) || null;
  }

  listBackups() {
    return this.db.prepare(`SELECT ${BACKUP_META} FROM backups WHERE account_id = ?
      ORDER BY created_at DESC, id DESC`).all(this.accountId);
  }

  getBackup(id) {
    return this.db.prepare(`SELECT ${BACKUP_META} FROM backups WHERE id = ? AND account_id = ?`)
      .get(id, this.accountId) || null;
  }

  getBackupRow(id) {
    return this.db.prepare('SELECT * FROM backups WHERE id = ? AND account_id = ?').get(id, this.accountId) || null;
  }

  deleteBackup(id) {
    this.db.prepare('DELETE FROM backups WHERE id = ? AND account_id = ?').run(id, this.accountId);
  }

  /** Backups an open journal row may still need for recovery. */
  pinnedBackupIds() {
    const rows = this.db.prepare(`SELECT target_backup_id, rollback_backup_id FROM switch_journal
      WHERE account_id = ? AND status = 'open'`).all(this.accountId);
    return new Set(rows.flatMap((r) => [r.target_backup_id, r.rollback_backup_id]).filter((id) => id != null));
  }

  /** Apply BACKUP_RETENTION, newest kept. Returns how many were deleted. */
  pruneBackups() {
    const pinned = this.pinnedBackupIds();
    let deleted = 0;
    for (const [kind, keep] of Object.entries(BACKUP_RETENTION)) {
      if (keep === Infinity) continue;
      const rows = this.db.prepare(`SELECT id FROM backups WHERE account_id = ? AND kind = ?
        ORDER BY created_at DESC, id DESC`).all(this.accountId, kind);
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
      (account_id, kind, from_profile_id, to_profile_id, target_backup_id, rollback_backup_id, phase, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'saved', 'open', ?)`)
      .run(this.accountId, kind, fromProfileId, toProfileId, targetBackupId, rollbackBackupId, this.now());
    return Number(info.lastInsertRowid);
  }

  setJournalPhase(id, phase) {
    this.db.prepare('UPDATE switch_journal SET phase = ? WHERE id = ? AND account_id = ?').run(phase, id, this.accountId);
  }

  failJournal(id, error) {
    this.db.prepare('UPDATE switch_journal SET error = ? WHERE id = ? AND account_id = ?')
      .run(String(error).slice(0, 500), id, this.accountId);
  }

  closeJournal(id, status, warnings = []) {
    this.db.prepare(`UPDATE switch_journal SET status = ?, phase = 'done', finished_at = ?, error = NULL, warnings = ?
      WHERE id = ? AND account_id = ?`).run(status, this.now(), JSON.stringify(warnings), id, this.accountId);
  }

  getOpenJournal() {
    const row = this.db.prepare(`SELECT * FROM switch_journal WHERE account_id = ? AND status = 'open'
      ORDER BY id DESC LIMIT 1`).get(this.accountId);
    return row ? { ...row, warnings: JSON.parse(row.warnings) } : null;
  }

  recentJournal(limit = 10) {
    return this.db.prepare('SELECT * FROM switch_journal WHERE account_id = ? ORDER BY id DESC LIMIT ?')
      .all(this.accountId, limit)
      .map((row) => ({ ...row, warnings: JSON.parse(row.warnings) }));
  }
}

/** Server-wide account rows: sign-in lookup, add-on token lookup, creation and deletion. */
export class Accounts {
  constructor(db, cipher, now = () => Date.now()) {
    this.db = db;
    this.cipher = cipher;
    this.now = now;
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  }

  byStremioUserId(stremioUserId) {
    return this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE stremio_user_id = ?`).get(stremioUserId) || null;
  }

  byId(id) {
    return this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).get(id) || null;
  }

  byAddonToken(token) {
    if (typeof token !== 'string' || token.length < 16) return null;
    return this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE addon_token = ?`).get(token) || null;
  }

  /** Inserts the row only; call inside the transaction that also creates the first profile. */
  insert({ stremioUserId, email, authKey }) {
    const now = this.now();
    const info = this.db.prepare(`INSERT INTO accounts
      (stremio_user_id, stremio_email, auth_key_enc, addon_token, enc_version, created_at, last_login_at)
      VALUES (?, ?, X'00', ?, 2, ?, ?)`).run(stremioUserId, email, randomToken(), now, now);
    const id = Number(info.lastInsertRowid);
    // The auth key is bound to the new id, so it can only be encrypted once the id exists.
    this.db.prepare('UPDATE accounts SET auth_key_enc = ? WHERE id = ?')
      .run(accountCipher(this.cipher, id).encryptJson(authKey, 'authkey'), id);
    return id;
  }

  /** Everything for the account goes with it (foreign keys cascade). */
  delete(id) {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  }
}
