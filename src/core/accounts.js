import { silentLogger } from '../log.js';
import { AccountRepo, Accounts } from './repo.js';
import { Mutex } from './lock.js';
import {
  DEFAULT_COLOUR, NATIVE_PROFILES_WARNING, ProfilesService, UserError, checkLiveSize, readLiveState,
} from './service.js';

/**
 * Who may sign in:
 *   owner  the first account to sign in owns the server; nobody else can join (self-hosting default)
 *   list   only `allowed` (Stremio emails or user ids)
 *   open   anyone, up to `maxAccounts` (a hosted instance)
 * Accounts that already exist can always sign back in, except under `list`
 * when they have been taken off the list.
 */
export function accessDecision({ mode, allowed = [], maxAccounts = Infinity }, { user, existing, accountCount }) {
  const listed = allowed.some((entry) => entry.toLowerCase() === user.email.toLowerCase() || entry === user.id);
  if (mode === 'list') {
    return listed ? null : "Your Stremio account isn't on this server's list. Ask whoever runs it to add you.";
  }
  if (existing) return null;
  if (mode === 'open') {
    return accountCount < maxAccounts ? null : 'This server is full. Try again later or run your own (it is free and open source).';
  }
  // owner
  return accountCount === 0 ? null : 'This OpenProfiles server already belongs to someone. You can run your own; it is free and open source.';
}

/**
 * The server's accounts. Signing in with Stremio creates the account the first
 * time (its current state becomes the "Original" profile, plus a permanent
 * backup) and renews the stored Stremio key after that. Each account gets its
 * own ProfilesService, so each has its own lock and only sees its own rows.
 */
export class AccountsService {
  constructor({ db, cipher, stremio, log = silentLogger, sleep, now = () => Date.now(), selfAddon = null, access = { mode: 'owner' } }) {
    this.db = db;
    this.cipher = cipher;
    this.stremio = stremio;
    this.log = log;
    this.sleep = sleep;
    this.now = now;
    this.selfAddon = selfAddon;
    this.access = access;
    this.accounts = new Accounts(db, cipher, now);
    this.services = new Map();
    // Serialises account creation, so two first sign-ins can't both claim an `owner` server.
    this.signInLock = new Mutex();
  }

  forAccount(accountId) {
    let service = this.services.get(accountId);
    if (!service) {
      const repo = new AccountRepo(this.db, this.cipher, accountId, this.now);
      service = new ProfilesService({ repo, stremio: this.stremio, log: this.log, sleep: this.sleep, now: this.now, selfAddon: this.selfAddon });
      this.services.set(accountId, service);
    }
    return service;
  }

  /** The account an add-on URL token belongs to, or null. */
  byAddonToken(token) {
    const account = this.accounts.byAddonToken(token);
    return account ? { account, service: this.forAccount(account.id) } : null;
  }

  getAccount(accountId) {
    return this.accounts.byId(accountId);
  }

  signIn(email, password) {
    return this.signInLock.run(async () => {
      const authKey = await this.stremio.login(email, password);
      const user = await this.stremio.getUser(authKey);
      if (user.parentId) {
        throw new UserError('CHILD_PROFILE', 'That sign-in belongs to a profile inside another Stremio account. Sign in with the main account.');
      }
      const existing = this.accounts.byStremioUserId(user.id);
      const refusal = accessDecision(this.access, { user, existing, accountCount: this.accounts.count() });
      if (refusal) {
        this.log.warn('Sign-in refused by the access rule', { mode: this.access.mode });
        throw new UserError('NOT_ALLOWED', refusal);
      }
      const warnings = [];
      if (user.userProfiles && Object.keys(user.userProfiles).length > 1) warnings.push(NATIVE_PROFILES_WARNING);

      if (existing) {
        this.forAccount(existing.id).repo.updateAuthKey({ email: user.email, authKey });
        this.forAccount(existing.id).repo.logActivity('signin', 'Signed in');
        this.log.info('Signed in', { accountId: existing.id });
        return { accountId: existing.id, created: false, warnings };
      }

      const live = await readLiveState(this.stremio, authKey, this.log);
      checkLiveSize(live);
      if (live.addons.length === 0) {
        throw new UserError('NO_ADDONS', 'This Stremio account has no add-ons installed. Install Cinemeta in Stremio, then sign in again.');
      }
      const snapshot = { library: live.library, addons: live.addons, notifs: live.notifs };
      const accountId = this.db.transaction(() => {
        const id = this.accounts.insert({ stremioUserId: user.id, email: user.email, authKey });
        const repo = new AccountRepo(this.db, this.cipher, id, this.now);
        const profileId = repo.insertProfile({ name: 'Original', avatarPreset: 'initial', avatarColour: DEFAULT_COLOUR, stremioUserId: user.id, snapshot });
        repo.setActiveProfile(profileId);
        repo.insertBackup({ kind: 'original', label: 'Account as it was at setup', stremioUserId: user.id, snapshot });
        return id;
      })();
      this.forAccount(accountId).noteAddons(live.addons);
      this.forAccount(accountId).repo.logActivity('signin', 'Account set up: your Stremio account was saved as "Original"');
      this.log.info('Account created', { accountId, libraryItems: snapshot.library.length, addons: snapshot.addons.length });
      return { accountId, created: true, warnings };
    });
  }

  /**
   * Remove an account and everything stored for it. Waits for its running
   * operation to finish first. The Stremio account itself is left as it is.
   */
  async deleteAccount(accountId) {
    const service = this.forAccount(accountId);
    await service.lock.run(async () => {
      this.accounts.delete(accountId);
    });
    this.services.delete(accountId);
    this.log.info('Account deleted', { accountId });
  }
}
