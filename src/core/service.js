import { randomToken } from '../crypto.js';
import { silentLogger } from '../log.js';
import { GuardError, MAX_ADDONS, MAX_LIBRARY_ITEMS, decodeSnapshot } from './guard.js';
import {
  LIBRARY_CHUNK, NOTIF_CHUNK, buildLibraryChanges, buildNotifChanges, chunk, hasId, scrubTombstones,
} from './library.js';
import { Mutex } from './lock.js';

export const AVATAR_COLOURS = ['#e5484d', '#f76b15', '#e2a336', '#46a758', '#12a594', '#0090ff', '#8e4ec6', '#d6409f'];
export const AVATAR_PRESETS = ['initial'];
const DEFAULT_COLOUR = AVATAR_COLOURS[5];
const INTER_BATCH_DELAY_MS = 75;
const MAX_NAME_LENGTH = 40;

export const NATIVE_PROFILES_WARNING =
  'Your Stremio account has its own profiles (a Supporter feature). OpenProfiles would swap the library ' +
  'inside whichever Stremio profile is open, so native profiles are the better choice for this account.';

/** A refusal or failure with a message meant for the person using the web page. */
export class UserError extends Error {
  constructor(code, userMessage, { cause } = {}) {
    super(userMessage, cause ? { cause } : undefined);
    this.code = code;
    this.userMessage = userMessage;
  }
}

export function userMessageOf(err) {
  return err?.userMessage || 'Something went wrong. The server log has details.';
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Everything that reads or writes the Stremio account goes through here, one
 * operation at a time. The web page and (later) the in-Stremio switcher are
 * thin callers.
 */
export class ProfilesService {
  constructor({ repo, stremio, log = silentLogger, sleep = realSleep, now = () => Date.now(), prepareAddons = (a) => a }) {
    this.repo = repo;
    this.stremio = stremio;
    this.log = log;
    this.sleep = sleep;
    this.now = now;
    // Hook for M2: make sure the OpenProfiles add-on itself is in every list we write.
    this.prepareAddons = prepareAddons;
    this.lock = new Mutex();
  }

  // ── read-only views ──────────────────────────────────────────────────────

  status() {
    const account = this.repo.getAccount();
    const state = this.repo.getState();
    return {
      linked: Boolean(account),
      account: account && { email: account.stremio_email, userId: account.stremio_user_id, linkedAt: account.linked_at },
      activeProfileId: state?.active_profile_id ?? null,
      addonToken: state?.addon_token ?? null,
      profiles: this.repo.listProfiles(),
      openJournal: this.describeJournal(this.repo.getOpenJournal()),
      busy: this.lock.busy,
    };
  }

  describeJournal(j) {
    if (!j) return null;
    const name = (id) => this.repo.getProfile(id)?.name ?? '(deleted profile)';
    return {
      ...j,
      fromName: j.from_profile_id != null ? name(j.from_profile_id) : null,
      toName: j.to_profile_id != null ? name(j.to_profile_id) : null,
      targetBackup: j.target_backup_id != null ? this.repo.getBackup(j.target_backup_id) : null,
    };
  }

  listBackups() {
    return this.repo.listBackups();
  }

  recentActivity(limit = 10) {
    return this.repo.recentJournal(limit);
  }

  getBackup(id) {
    return this.repo.getBackup(id);
  }

  // ── account ──────────────────────────────────────────────────────────────

  /**
   * Sign in with Stremio. The first time, this creates the "Original" profile
   * from the account's current state plus the never-pruned `original` backup.
   * Later sign-ins (expired key) only replace the stored key.
   */
  linkAccount(email, password) {
    return this.lock.run(async () => {
      const authKey = await this.stremio.login(email, password);
      const user = await this.stremio.getUser(authKey);
      if (user.parentId) {
        throw new UserError('CHILD_PROFILE', 'That sign-in belongs to a profile inside another Stremio account. Sign in with the main account.');
      }
      const warnings = [];
      if (user.userProfiles && Object.keys(user.userProfiles).length > 1) warnings.push(NATIVE_PROFILES_WARNING);

      const existing = this.repo.getAccount();
      if (existing) {
        if (existing.stremio_user_id !== user.id) {
          throw new UserError('OTHER_ACCOUNT', `This server is set up for ${existing.stremio_email}. OpenProfiles serves one Stremio account per server.`);
        }
        this.repo.updateAuthKey({ email: user.email, authKey });
        this.log.info('Stremio sign-in renewed');
        return { created: false, warnings };
      }

      const live = await this.readLive(authKey);
      this.checkLiveSize(live);
      if (live.addons.length === 0) {
        throw new UserError('NO_ADDONS', 'This Stremio account has no add-ons installed. Install Cinemeta in Stremio, then sign in again.');
      }
      const snapshot = this.capture(live);
      this.repo.transaction(() => {
        this.repo.insertAccount({ stremioUserId: user.id, email: user.email, authKey });
        const id = this.repo.insertProfile({ name: 'Original', avatarPreset: 'initial', avatarColour: DEFAULT_COLOUR, stremioUserId: user.id, snapshot });
        this.repo.initState({ activeProfileId: id, addonToken: randomToken() });
        this.repo.insertBackup({ kind: 'original', label: 'Account as it was at setup', stremioUserId: user.id, snapshot });
      });
      this.log.info('Stremio account linked', { libraryItems: snapshot.library.length, addons: snapshot.addons.length });
      return { created: true, warnings };
    });
  }

  // ── profiles ─────────────────────────────────────────────────────────────

  /** `from: 'current'` copies the account as it is now; `'empty'` keeps the add-ons only. */
  createProfile({ name, from = 'empty', colour = DEFAULT_COLOUR }) {
    return this.lock.run(async () => {
      const account = this.requireAccount();
      const clean = this.validateName(name);
      this.validateColour(colour);
      this.assertNameFree(clean);
      this.assertNoOpenJournal();
      const { authKey } = await this.session();
      let snapshot;
      if (from === 'current') {
        const live = await this.readLive(authKey);
        this.checkLiveSize(live);
        snapshot = this.capture(live);
      } else if (from === 'empty') {
        const addons = await this.stremio.getAddons(authKey);
        this.checkLiveSize({ library: [], addons });
        snapshot = { library: [], addons, notifs: [] };
      } else {
        throw new UserError('BAD_INPUT', 'Unknown profile type.');
      }
      if (snapshot.addons.length === 0) {
        throw new UserError('NO_ADDONS', 'The account has no add-ons installed, so a new profile would have none. Install Cinemeta first.');
      }
      const id = this.repo.insertProfile({ name: clean, avatarPreset: 'initial', avatarColour: colour, stremioUserId: account.stremio_user_id, snapshot });
      return this.repo.getProfile(id);
    });
  }

  renameProfile(id, name) {
    const profile = this.requireProfile(id);
    const clean = this.validateName(name);
    if (clean.toLowerCase() !== profile.name.toLowerCase()) this.assertNameFree(clean);
    this.repo.renameProfile(id, clean);
  }

  setAvatar(id, colour) {
    this.requireProfile(id);
    this.validateColour(colour);
    this.repo.setProfileAvatar(id, 'initial', colour);
  }

  deleteProfile(id) {
    return this.lock.run(async () => {
      const profile = this.requireProfile(id);
      if (this.repo.getState()?.active_profile_id === id) {
        throw new UserError('ACTIVE', `"${profile.name}" is the profile in use. Switch to another profile before deleting it.`);
      }
      const open = this.repo.getOpenJournal();
      if (open && (open.from_profile_id === id || open.to_profile_id === id)) {
        throw new UserError('RECOVERY_NEEDED', 'An unfinished switch involves this profile. Resolve it first.');
      }
      this.repo.deleteProfile(id);
      this.log.info('Profile deleted', { profileId: id });
    });
  }

  /** Save the account's current state into the active profile. */
  saveNow() {
    return this.lock.run(async () => {
      const account = this.requireAccount();
      this.assertNoOpenJournal();
      const activeId = this.repo.getState()?.active_profile_id;
      const profile = activeId != null ? this.repo.getProfile(activeId) : null;
      if (!profile) throw new UserError('NO_ACTIVE', 'No profile is active.');
      this.assertAnchor(profile, account, profile.name);
      const { authKey } = await this.session();
      const live = await this.readLive(authKey);
      this.checkLiveSize(live);
      this.repo.saveProfileSnapshot(profile.id, this.capture(live));
      return { profile: this.repo.getProfile(profile.id), notifsSaved: live.notifs !== null };
    });
  }

  // ── switching ────────────────────────────────────────────────────────────

  switchTo(profileId) {
    return this.lock.run(() => this.doSwitch(profileId));
  }

  async doSwitch(profileId) {
    const account = this.requireAccount();
    const state = this.repo.getState();
    const target = this.repo.getProfileRow(profileId);
    if (!target) throw new UserError('NOT_FOUND', 'That profile no longer exists.');

    // 1. Idempotent: Stremio can request the stream more than once.
    if (state.active_profile_id === profileId) {
      return { alreadyActive: true, profile: this.repo.getProfile(profileId), warnings: [] };
    }
    this.assertNoOpenJournal();

    // 2-4. Valid sign-in, same account, target decodes cleanly. No writes yet.
    const { authKey } = await this.session();
    this.assertAnchor(target, account, target.name);
    const targetSnap = decodeSnapshot(this.repo.cipher, target, target.name);

    // 5. Live state. Library or add-on read failure aborts; notifications may be null.
    const live = await this.readLive(authKey);
    this.checkLiveSize(live);
    const captured = this.capture(live);
    const outgoing = state.active_profile_id != null ? this.repo.getProfile(state.active_profile_id) : null;

    // 6-7. Backup, save the outgoing profile and open the journal, all or nothing.
    const journalId = this.repo.transaction(() => {
      const backupId = this.repo.insertBackup({
        kind: 'pre_switch',
        label: `Before switching from ${outgoing ? `"${outgoing.name}"` : '(none)'} to "${target.name}"`,
        stremioUserId: account.stremio_user_id,
        snapshot: captured,
      });
      if (outgoing) this.repo.saveProfileSnapshot(outgoing.id, captured);
      return this.repo.startJournal({ kind: 'switch', fromProfileId: outgoing?.id ?? null, toProfileId: profileId, rollbackBackupId: backupId });
    });
    this.log.info('Switch started', { journalId, from: outgoing?.id ?? null, to: profileId });

    // 8-10. Write to Stremio.
    const result = await this.applyOrFail('switch', journalId, authKey, live, targetSnap);

    // 11. Flip the pointer.
    this.repo.transaction(() => {
      this.repo.setActiveProfile(profileId);
      this.repo.closeJournal(journalId, 'finished', result.warnings);
    });
    this.repo.pruneBackups();
    this.log.info('Switch finished', { journalId, ...result.library, warnings: result.warnings.length });
    return { alreadyActive: false, profile: this.repo.getProfile(profileId), ...result };
  }

  async applyOrFail(what, journalId, authKey, live, target) {
    try {
      return await this.applySnapshot(journalId, authKey, live, target);
    } catch (err) {
      this.repo.failJournal(journalId, userMessageOf(err));
      this.log.error(`${what} interrupted`, { journalId, error: err.message });
      const verb = { switch: 'The switch', restore: 'The restore', rollback: 'Going back' }[what];
      throw new UserError('INTERRUPTED', `${verb} stopped partway: ${userMessageOf(err)} Open the OpenProfiles page to finish it or go back.`, { cause: err });
    }
  }

  /**
   * Steps 8-10. The library write must succeed (it throws); add-ons and
   * notifications are best-effort, because throwing after the library has
   * been swapped would leave the pointer on the wrong profile.
   */
  async applySnapshot(journalId, authKey, live, target) {
    const warnings = [];

    this.repo.setJournalPhase(journalId, 'library');
    const lib = buildLibraryChanges(live.library, target.library, this.now());
    await this.putChunks(lib.changes, LIBRARY_CHUNK, (c) => this.stremio.putLibrary(authKey, c));

    this.repo.setJournalPhase(journalId, 'addons');
    const addons = this.prepareAddons(target.addons);
    if (JSON.stringify(addons) !== JSON.stringify(live.addons)) {
      try {
        await this.stremio.setAddons(authKey, addons);
      } catch (err) {
        warnings.push(`Add-ons weren't swapped: ${userMessageOf(err)}`);
        this.log.warn('Add-on write failed', { journalId, error: err.message });
      }
    }

    this.repo.setJournalPhase(journalId, 'notifs');
    if (live.notifs === null) {
      warnings.push("Notifications weren't swapped: Stremio didn't return the current ones.");
    } else if (target.notifs === null) {
      warnings.push("Notifications weren't swapped: none were saved for this profile yet.");
    } else {
      const notifs = buildNotifChanges(live.notifs, target.notifs);
      try {
        await this.putChunks(notifs.changes, NOTIF_CHUNK, (c) => this.stremio.putNotifs(authKey, c));
      } catch (err) {
        warnings.push(`Notifications weren't swapped: ${userMessageOf(err)}`);
        this.log.warn('Notification write failed', { journalId, error: err.message });
      }
    }
    return { library: lib.stats, warnings };
  }

  async putChunks(changes, size, write) {
    const chunks = chunk(changes, size);
    for (let i = 0; i < chunks.length; i++) {
      await write(chunks[i]);
      if (i < chunks.length - 1) await this.sleep(INTER_BATCH_DELAY_MS);
    }
  }

  // ── recovery ─────────────────────────────────────────────────────────────

  /** Re-run the writes toward the interrupted operation's target. */
  finishInterrupted() {
    return this.lock.run(async () => {
      const account = this.requireAccount();
      const j = this.repo.getOpenJournal();
      if (!j) throw new UserError('NOTHING_OPEN', 'There is no unfinished switch.');
      const row = j.kind === 'switch' ? this.repo.getProfileRow(j.to_profile_id) : this.repo.getBackupRow(j.target_backup_id);
      if (!row) throw new UserError('TARGET_GONE', "The interrupted switch's target no longer exists. Use \"Go back\" instead.");
      const label = j.kind === 'switch' ? row.name : 'The backup';
      const { authKey } = await this.session();
      this.assertAnchor(row, account, label);
      const target = decodeSnapshot(this.repo.cipher, row, label);
      const live = await this.readLive(authKey);
      const result = await this.applyOrFail(j.kind, j.id, authKey, live, target);
      this.repo.transaction(() => {
        if (j.kind === 'switch') this.repo.setActiveProfile(j.to_profile_id);
        else this.repo.saveProfileSnapshot(j.to_profile_id, target);
        this.repo.closeJournal(j.id, 'finished', result.warnings);
      });
      this.repo.pruneBackups();
      this.log.info('Interrupted operation finished', { journalId: j.id });
      return result;
    });
  }

  /** Put the account back the way it was before the interrupted operation. */
  rollbackInterrupted() {
    return this.lock.run(async () => {
      const account = this.requireAccount();
      const j = this.repo.getOpenJournal();
      if (!j) throw new UserError('NOTHING_OPEN', 'There is no unfinished switch.');
      const row = j.rollback_backup_id != null ? this.repo.getBackupRow(j.rollback_backup_id) : null;
      if (!row) throw new UserError('BACKUP_GONE', 'The backup taken before the switch is missing. Use "Finish" instead.');
      const { authKey } = await this.session();
      this.assertAnchor(row, account, 'The pre-switch backup');
      const snapshot = decodeSnapshot(this.repo.cipher, row, 'The pre-switch backup');
      const live = await this.readLive(authKey);
      const result = await this.applyOrFail('rollback', j.id, authKey, live, snapshot);
      // The pointer never moved and the outgoing profile was saved before any
      // write, so closing the journal is all that's left.
      this.repo.closeJournal(j.id, 'rolled_back', result.warnings);
      this.log.info('Interrupted operation rolled back', { journalId: j.id });
      return result;
    });
  }

  // ── backups ──────────────────────────────────────────────────────────────

  createBackup(label) {
    return this.lock.run(async () => {
      const account = this.requireAccount();
      this.assertNoOpenJournal();
      const clean = String(label || '').trim().slice(0, 80) || 'Manual backup';
      const { authKey } = await this.session();
      const live = await this.readLive(authKey);
      this.checkLiveSize(live);
      const id = this.repo.insertBackup({ kind: 'manual', label: clean, stremioUserId: account.stremio_user_id, snapshot: this.capture(live) });
      this.repo.pruneBackups();
      return this.repo.getBackup(id);
    });
  }

  /** Write a backup to the account and make it the active profile's saved state. */
  restoreBackup(backupId) {
    return this.lock.run(async () => {
      const account = this.requireAccount();
      this.assertNoOpenJournal();
      const row = this.repo.getBackupRow(backupId);
      if (!row) throw new UserError('NOT_FOUND', 'That backup no longer exists.');
      const activeId = this.repo.getState()?.active_profile_id;
      const active = activeId != null ? this.repo.getProfile(activeId) : null;
      if (!active) throw new UserError('NO_ACTIVE', 'No profile is active.');
      const { authKey } = await this.session();
      this.assertAnchor(row, account, 'This backup');
      const target = decodeSnapshot(this.repo.cipher, row, 'This backup');
      const live = await this.readLive(authKey);
      this.checkLiveSize(live);

      const journalId = this.repo.transaction(() => {
        const preId = this.repo.insertBackup({
          kind: 'pre_restore',
          label: `Before restoring "${row.label}"`,
          stremioUserId: account.stremio_user_id,
          snapshot: this.capture(live),
        });
        return this.repo.startJournal({ kind: 'restore', fromProfileId: active.id, toProfileId: active.id, targetBackupId: backupId, rollbackBackupId: preId });
      });
      const result = await this.applyOrFail('restore', journalId, authKey, live, target);
      this.repo.transaction(() => {
        this.repo.saveProfileSnapshot(active.id, target);
        this.repo.closeJournal(journalId, 'finished', result.warnings);
      });
      this.repo.pruneBackups();
      this.log.info('Backup restored', { backupId, journalId });
      return result;
    });
  }

  deleteBackup(id) {
    return this.lock.run(async () => {
      const backup = this.repo.getBackup(id);
      if (!backup) throw new UserError('NOT_FOUND', 'That backup no longer exists.');
      if (backup.kind === 'original') throw new UserError('PROTECTED', 'The setup backup is kept permanently.');
      if (this.repo.pinnedBackupIds().has(id)) throw new UserError('RECOVERY_NEEDED', 'An unfinished switch needs this backup. Resolve it first.');
      this.repo.deleteBackup(id);
    });
  }

  /** Decrypted contents for download. Contains add-on URLs, which can include debrid keys. */
  exportBackup(id) {
    const row = this.repo.getBackupRow(id);
    if (!row) throw new UserError('NOT_FOUND', 'That backup no longer exists.');
    const { library, addons, notifs } = decodeSnapshot(this.repo.cipher, row, 'This backup');
    return {
      format: 'openprofiles-backup',
      version: 1,
      kind: row.kind,
      label: row.label,
      created_at: new Date(row.created_at).toISOString(),
      stremio_user_id: row.stremio_user_id,
      counts: { library: row.library_count, addons: row.addon_count, notifs: row.notif_count },
      library,
      addons,
      notifs,
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  requireAccount() {
    const account = this.repo.getAccount();
    if (!account) throw new UserError('NOT_LINKED', 'Sign in with Stremio first.');
    return account;
  }

  requireProfile(id) {
    const profile = this.repo.getProfile(id);
    if (!profile) throw new UserError('NOT_FOUND', 'That profile no longer exists.');
    return profile;
  }

  assertNoOpenJournal() {
    if (this.repo.getOpenJournal()) {
      throw new UserError('RECOVERY_NEEDED', "A previous switch didn't finish. Open the OpenProfiles page to finish it or go back first.");
    }
  }

  /** Applying account A's snapshot to account B would overwrite B's library and debrid-keyed add-ons. */
  assertAnchor(row, account, label) {
    if (row.stremio_user_id !== account.stremio_user_id) {
      throw new GuardError('WRONG_ACCOUNT', `${label} was saved from a different Stremio account. Applying it here would overwrite this account, so it was refused.`);
    }
  }

  /** Validate the stored key against Stremio and make sure it's still the linked account. */
  async session() {
    const account = this.requireAccount();
    const authKey = this.repo.getAuthKey();
    const user = await this.stremio.getUser(authKey);
    if (user.id !== account.stremio_user_id) {
      throw new UserError('ACCOUNT_CHANGED', 'The stored Stremio sign-in now points at a different account. Sign in again.');
    }
    return { authKey, account };
  }

  async readLive(authKey) {
    const [library, addons, notifs] = await Promise.all([
      this.stremio.getLibrary(authKey),
      this.stremio.getAddons(authKey),
      this.stremio.getNotifs(authKey).catch((err) => {
        this.log.warn('Notification read failed; continuing without notifications', { error: err.message });
        return null;
      }),
    ]);
    return {
      library: library.filter(hasId),
      addons,
      notifs: notifs === null ? null : notifs.filter(hasId),
    };
  }

  checkLiveSize(live) {
    if (live.library.length > MAX_LIBRARY_ITEMS) {
      throw new UserError('TOO_LARGE', `The Stremio library has ${live.library.length} items (including removed ones); OpenProfiles can store up to ${MAX_LIBRARY_ITEMS}. Nothing was changed.`);
    }
    if (live.addons.length > MAX_ADDONS) {
      throw new UserError('TOO_LARGE', `The account has ${live.addons.length} add-ons; OpenProfiles can store up to ${MAX_ADDONS}. Nothing was changed.`);
    }
  }

  capture(live) {
    return { library: scrubTombstones(live.library), addons: live.addons, notifs: live.notifs };
  }

  validateName(name) {
    const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
    // eslint-disable-next-line no-control-regex
    if (!clean || clean.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(clean)) {
      throw new UserError('BAD_NAME', `Profile names must be 1 to ${MAX_NAME_LENGTH} characters.`);
    }
    return clean;
  }

  assertNameFree(name) {
    if (this.repo.listProfiles().some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new UserError('NAME_TAKEN', `There's already a profile called "${name}".`);
    }
  }

  validateColour(colour) {
    if (!AVATAR_COLOURS.includes(colour)) throw new UserError('BAD_INPUT', 'Pick one of the listed colours.');
  }
}
