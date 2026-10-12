import { randomToken } from '../crypto.js';
import { silentLogger } from '../log.js';
import {
  addonPool, addonRef, addonsHash, cinemetaOf, describeAddon, describeListChange, droppedProtected, listFromRefs,
  runsOnDevice,
} from './addons.js';
import {
  CINEMETA_ID, STOCK_SETTINGS, anotherAddonServesMeta, buildManifest, deriveSettings, describeChanges, findCinemeta,
  detailsSource, givesOwnDetailsOnly, givesTitleDetails, isFullMetadata, needsStock, sameSettings, settingsForHandoff,
} from './cinemeta.js';
import { sealExport, openExport } from './exporter.js';
import { FetchError, checkManifest, fetchManifest as guardedFetchManifest, normaliseAddonUrl } from './fetchGuard.js';
import {
  GuardError, MAX_ADDONS, MAX_LIBRARY_ITEMS, checkAddons, checkLibrary, checkNotifs, decodeSnapshot,
} from './guard.js';
import { parseStremShareBackup, sameAccount, suggestedProfileName } from './importer.js';
import {
  LIBRARY_CHUNK, NOTIF_CHUNK, buildLibraryChanges, buildNotifChanges, chunk, countActive, countContinueWatching, hasId,
} from './library.js';
import { Mutex } from './lock.js';
import { snapshotHash } from './repo.js';
import { isValidAvatar } from '../addon/avatars.js';
import { ADDON_ID, ensureSelfAddon, isSelfAddon, stremioInstallUrl } from '../addon/manifest.js';

// Each clears 3.5:1 under a white initial (see the poster artboard in the M2 design).
export const AVATAR_COLOURS = ['#e5484d', '#e05d0c', '#b7790b', '#3b8f4b', '#0f8f80', '#0a7fe0', '#8e4ec6', '#d6409f'];
export const DEFAULT_COLOUR = AVATAR_COLOURS[5];
const INTER_BATCH_DELAY_MS = 75;
const MAX_NAME_LENGTH = 40;
const IMPORT_STASH_MS = 15 * 60 * 1000;
export const MAX_PROFILES = 20;
export const BIN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const UNDO_MS = DAY_MS;
const ADDON_STASH_MS = 30 * 60 * 1000;
const HEALTH_CONCURRENCY = 4;
// Add-on fetches an account may make (by link, health checks) in a window: plenty for a person,
// too few to use a shared server as a fetching proxy.
const FETCH_BUDGET = 80;
const FETCH_WINDOW_MS = 10 * 60 * 1000;

export const NO_DETAILS_WARNING =
  "Details pages are off and no other add-on in this profile provides them, so titles will open without descriptions or episode lists.";

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

/** The account's live library, add-ons and notifications. A failed notification read is `null`, not `[]`. */
export async function readLiveState(stremio, authKey, log = silentLogger) {
  const [library, addons, notifs] = await Promise.all([
    stremio.getLibrary(authKey),
    stremio.getAddons(authKey),
    stremio.getNotifs(authKey).catch((err) => {
      log.warn('Notification read failed; continuing without notifications', { error: err.message });
      return null;
    }),
  ]);
  return {
    library: library.filter(hasId),
    addons,
    notifs: notifs === null ? null : notifs.filter(hasId),
  };
}

export function checkLiveSize(live) {
  if (live.library.length > MAX_LIBRARY_ITEMS) {
    throw new UserError('TOO_LARGE', `The Stremio library has ${live.library.length} items (including removed ones); OpenProfiles can store up to ${MAX_LIBRARY_ITEMS}. Nothing was changed.`);
  }
  if (live.addons.length > MAX_ADDONS) {
    throw new UserError('TOO_LARGE', `The account has ${live.addons.length} add-ons; OpenProfiles can store up to ${MAX_ADDONS}. Nothing was changed.`);
  }
}

/**
 * Everything that reads or writes the Stremio account goes through here, one
 * operation at a time. The web page and (later) the in-Stremio switcher are
 * thin callers.
 */
export class ProfilesService {
  /**
   * `selfAddon` (from addon/manifest.js) keeps OpenProfiles installed in every add-on list written.
   * `fetchManifest(url)` fetches an add-on's manifest (through the fetch guard unless a test swaps it).
   */
  constructor({ repo, stremio, log = silentLogger, sleep = realSleep, now = () => Date.now(), selfAddon = null, fetchManifest = null }) {
    this.repo = repo;
    this.stremio = stremio;
    this.log = log;
    this.sleep = sleep;
    this.now = now;
    this.selfAddon = selfAddon;
    this.fetchManifest = fetchManifest ?? ((url) => guardedFetchManifest(url));
    this.lock = new Mutex();
    this.importStash = new Map();
    // Add-ons fetched by link, held so the page can refer to them by ref until saved.
    this.addonStash = new Map();
    this.fetchTimes = [];
  }

  /** Count `n` add-on fetches against the account's budget, or refuse. */
  spendFetches(n) {
    const now = this.now();
    this.fetchTimes = this.fetchTimes.filter((t) => t > now - FETCH_WINDOW_MS);
    if (this.fetchTimes.length + n > FETCH_BUDGET) {
      throw new UserError('SLOW_DOWN', 'That is a lot of add-on checks in a short time. Wait a few minutes and try again.');
    }
    for (let i = 0; i < n; i++) this.fetchTimes.push(now);
  }

  prepareAddons(addons) {
    if (!this.selfAddon) return addons;
    return ensureSelfAddon(addons, this.selfAddon.descriptor(this.repo.getState().addon_token));
  }

  noteAddons(addons) {
    if (this.selfAddon && this.repo.getState()) this.repo.setAddonInstalled(addons.some(isSelfAddon));
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

  // ── the in-Stremio add-on ────────────────────────────────────────────────

  /** Install links and whether the add-on was in the account's list at the last read. */
  addonInfo() {
    const state = this.repo.getState();
    if (!state || !this.selfAddon) return null;
    const manifestUrl = this.selfAddon.manifestUrl(state.addon_token);
    return {
      manifestUrl,
      installUrl: stremioInstallUrl(manifestUrl),
      installed: state.addon_installed == null ? null : Boolean(state.addon_installed),
    };
  }

  /**
   * New secret add-on link. If the add-on is installed, the account's copy is
   * repointed first, so the old link dies without breaking the installed one.
   */
  rotateAddonToken() {
    return this.lock.run(async () => {
      this.requireAccount();
      this.assertNoOpenJournal();
      const { authKey } = await this.session();
      const token = randomToken();
      const addons = await this.stremio.getAddons(authKey);
      if (addons.some(isSelfAddon)) {
        await this.stremio.setAddons(authKey, ensureSelfAddon(addons, this.selfAddon.descriptor(token)));
      }
      this.repo.setAddonToken(token);
      this.noteAddons(addons);
      this.repo.logActivity('addon-link', 'Made a new add-on link');
      this.log.info('Add-on link rotated');
      return this.addonInfo();
    });
  }

  // ── profiles ─────────────────────────────────────────────────────────────

  /**
   * A new profile. Nothing in Stremio changes unless `switchNow`.
   *   from      'empty' (no library, the account's add-ons), 'current' (a copy of the account as it is
   *             now) or 'profile' (a copy of `sourceProfileId`'s saved state)
   *   addonRefs the add-ons it should have, in order (see addons.js); omitted keeps the starting list
   *   addonUrl  one more add-on to fetch by link and add at the end
   *   renames   catalog renames, `{ [ref]: { 'type:id': name } }`
   *   cinemeta  Cinemeta settings (cinemeta.js) to apply to the list
   * Returns the profile, plus `warnings` and (with `switchNow`) `switched`.
   */
  createProfile({
    name, from = 'empty', colour = DEFAULT_COLOUR, picture = 'initial', sourceProfileId = null,
    addonRefs = null, addonUrl = null, renames = {}, cinemeta = null, switchNow = false,
  }) {
    return this.lock.run(async () => {
      const account = this.requireAccount();
      const clean = this.validateName(name);
      this.validateColour(colour);
      if (!isValidAvatar(picture)) throw new UserError('BAD_INPUT', 'Pick one of the listed pictures.');
      this.assertNameFree(clean);
      this.assertRoomForProfile();
      this.assertNoOpenJournal();
      const { authKey } = await this.session();
      const activeId = this.repo.getState()?.active_profile_id;
      // The profile in use is newest in Stremio, so copying it means copying the account.
      const start = from === 'profile' && sourceProfileId === activeId ? 'current' : from;

      let snapshot;
      let live = null;
      if (start === 'current') {
        live = await this.readLive(authKey);
        this.checkLiveSize(live);
        snapshot = this.capture(live);
      } else if (start === 'empty') {
        const addons = await this.stremio.getAddons(authKey);
        this.noteAddons(addons);
        this.checkLiveSize({ library: [], addons });
        live = { addons };
        snapshot = { library: [], addons, notifs: [] };
      } else if (start === 'profile') {
        const source = this.repo.getProfileRow(Number(sourceProfileId));
        if (!source) throw new UserError('NOT_FOUND', 'The profile to copy no longer exists.');
        this.assertAnchor(source, account, source.name);
        snapshot = { ...decodeSnapshot(this.repo.cipher, source, source.name) };
      } else {
        throw new UserError('BAD_INPUT', 'Unknown profile type.');
      }

      const warnings = [];
      if (addonRefs || addonUrl) {
        const liveAddons = live?.addons ?? await this.stremio.getAddons(authKey);
        const pool = addonPool([{ addons: snapshot.addons }, { addons: liveAddons }, ...this.savedAddonLists()]);
        const lookup = (ref) => pool.get(ref)?.addon ?? this.stashedAddon(ref);
        const { addons, missing } = listFromRefs(addonRefs ?? snapshot.addons.map(addonRef), lookup, renames);
        if (missing.length) throw new UserError('ADDON_GONE', "An add-on you picked isn't available any more. Go back to the add-ons step and pick again.");
        if (addonUrl) {
          const extra = await this.fetchAddon(addonUrl);
          if (!addons.some((a) => addonRef(a) === addonRef(extra))) addons.push(extra);
        }
        this.assertKeepsProtected(snapshot.addons, addons);
        snapshot.addons = addons;
      }
      if (cinemeta) snapshot.addons = await this.applyCinemeta(snapshot.addons, cinemeta, warnings);
      if (snapshot.addons.length === 0) {
        throw new UserError('NO_ADDONS', 'A profile needs at least one add-on. Keep Cinemeta, or install it first.');
      }
      checkAddons(snapshot.addons, clean);

      const id = this.repo.insertProfile({ name: clean, avatarPreset: picture, avatarColour: colour, stremioUserId: account.stremio_user_id, snapshot });
      this.repo.logActivity('profile', `Created "${clean}"`);
      let switched = null;
      if (switchNow) {
        try {
          switched = await this.doSwitch(id);
          warnings.push(...switched.warnings);
        } catch (err) {
          warnings.push(`"${clean}" was created, but switching to it didn't work: ${userMessageOf(err)}`);
        }
      }
      return Object.assign(this.repo.getProfile(id), { warnings, switched });
    });
  }

  /**
   * Everything the new-profile wizard offers: every add-on any profile has
   * (the profile in use as Stremio has it now), and for each way to start,
   * which of them are ticked and how Cinemeta is set.
   */
  async wizardOptions() {
    this.requireAccount();
    const { authKey } = await this.session();
    const live = await this.stremio.getAddons(authKey);
    this.noteAddons(live);
    const activeId = this.repo.getState()?.active_profile_id;
    const active = activeId != null ? this.repo.getProfile(activeId) : null;
    const saved = this.savedAddonLists({ skip: activeId });
    const pool = addonPool([{ label: active?.name ?? 'Stremio now', addons: live }, ...saved]);
    const startOf = (addons) => ({ refs: addons.map(addonRef), cinemeta: cinemetaOf(addons) });
    return {
      activeName: active?.name ?? null,
      room: this.repo.countProfiles() < MAX_PROFILES,
      pool: [...pool.values()].map(({ addon, from }) => ({ ...describeAddon(addon), from })),
      starts: {
        live: startOf(live),
        profiles: saved.map(({ id, label, addons }) => ({ id, name: label, ...startOf(addons) })),
      },
    };
  }

  /** Every readable profile's saved add-on list, `{ id, label, addons }`. */
  savedAddonLists({ skip = null } = {}) {
    const out = [];
    for (const p of this.repo.listProfiles()) {
      if (p.id === skip) continue;
      try {
        out.push({ id: p.id, label: p.name, addons: this.savedSnapshot(p.id).addons });
      } catch (err) {
        if (!(err instanceof GuardError)) throw err;
      }
    }
    return out;
  }

  /** A profile's saved library, add-ons and notifications, checked. */
  savedSnapshot(profileId) {
    const row = this.repo.getProfileRow(profileId);
    if (!row) throw new UserError('NOT_FOUND', 'That profile no longer exists.');
    return decodeSnapshot(this.repo.cipher, row, row.name);
  }

  /** What the profile page shows about one profile. Unreadable saved state shows as null. */
  profileDetails(profileId) {
    const profile = this.requireProfile(profileId);
    let saved = null;
    try {
      saved = this.savedSnapshot(profileId);
    } catch (err) {
      if (!(err instanceof GuardError)) throw err;
    }
    return {
      profile,
      active: this.repo.getState()?.active_profile_id === profileId,
      addons: saved ? saved.addons.map(describeAddon) : null,
      cinemeta: saved ? cinemetaOf(saved.addons) : null,
      continueWatching: saved ? countContinueWatching(saved.library) : null,
    };
  }

  // ── add-on manager and Cinemeta control ──────────────────────────────────

  /**
   * The add-on list an edit starts from: Stremio's own for the profile in
   * use (it's the newest), the saved copy for any other. `base` fingerprints
   * it, so a save can tell if it changed meanwhile.
   */
  async editableAddons(profileId) {
    const profile = this.requireProfile(profileId);
    const active = this.repo.getState()?.active_profile_id === profileId;
    let addons;
    if (active) {
      const { authKey } = await this.session();
      addons = await this.stremio.getAddons(authKey);
      this.noteAddons(addons);
    } else {
      addons = this.savedSnapshot(profileId).addons;
    }
    return { profile, active, addons, base: addonsHash(addons) };
  }

  /** Everything the add-on manager page shows. */
  async addonManager(profileId) {
    const { profile, active, addons, base } = await this.editableAddons(profileId);
    const own = new Set(addons.map(addonRef));
    const others = addonPool(this.savedAddonLists({ skip: profileId }));
    const { index, wrapped, wrappedIndex } = findCinemeta(addons);
    const nameOf = (a) => String(a.manifest?.name || a.manifest?.id || 'Another add-on');
    const details = detailsSource(addons);
    return {
      profile,
      active,
      base,
      addons: addons.map(describeAddon),
      pool: [...others.values()].filter(({ addon }) => !own.has(addonRef(addon)) && !isSelfAddon(addon))
        .map(({ addon, from }) => ({ ...describeAddon(addon), from })),
      cinemeta: {
        present: index !== -1,
        wrapped,
        wrappedName: wrapped ? nameOf(addons[wrappedIndex]) : null,
        wrappedRef: wrapped ? addonRef(addons[wrappedIndex]) : null,
        settings: index === -1 ? null : deriveSettings(addons[index].manifest),
        otherMeta: anotherAddonServesMeta(addons, index),
      },
      // Where details pages come from (the first add-on in the list that gives them),
      // and every add-on that could: Cinemeta, clones, TMDB, AIOMetadata…
      metadata: {
        current: details === -1 ? null : addonRef(addons[details]),
        currentName: details === -1 ? null : nameOf(addons[details]),
        options: addons.filter((a, i) => !isSelfAddon(a) && (i === index || givesTitleDetails(a)))
          .map((a) => ({ ref: addonRef(a), name: nameOf(a) })),
        // Metadata add-ons for their own titles only (e.g. TMDB with "tmdb:" ids): shown, not pickable.
        ownTitlesOnly: addons.filter((a) => !isSelfAddon(a) && givesOwnDetailsOnly(a)).map(nameOf),
      },
    };
  }

  /**
   * Save a profile's add-on list: `refs` in order (current add-ons, ones from
   * other profiles, or ones fetched by link), plus catalog renames. `addRef`
   * and `addUrl` append one more (the form's fallbacks without JavaScript).
   */
  saveAddons(profileId, { base, refs = [], renames = {}, addRef = null, addUrl = null }) {
    return this.editAddons(profileId, {
      base,
      editKind: 'addons',
      label: (p) => `Before editing ${p.name}'s add-ons`,
      change: async (current, profile) => {
        const others = addonPool(this.savedAddonLists({ skip: profileId }));
        const lookup = (ref) => current.find((a) => addonRef(a) === ref) ?? others.get(ref)?.addon ?? this.stashedAddon(ref);
        const { addons, missing } = listFromRefs(addRef ? [...refs, addRef] : refs, lookup, renames);
        if (missing.length) throw new UserError('ADDON_GONE', "An add-on in the list isn't available any more. Reload the page and try again.");
        if (addUrl) {
          const extra = await this.fetchAddon(addUrl);
          if (!addons.some((a) => addonRef(a) === addonRef(extra))) addons.push(extra);
        }
        this.assertKeepsProtected(current, addons);
        return { addons, activity: `Edited ${profile.name}'s add-ons: ${describeListChange(current, addons) || 'no change'}` };
      },
    });
  }

  /**
   * Change how Cinemeta behaves in one profile: `wanted` is settings (from
   * cinemeta.js), or `{ handoff: ref }` to hand Cinemeta's job to another
   * add-on of the list (see settingsForHandoff).
   */
  saveCinemeta(profileId, wanted, { base }) {
    return this.editAddons(profileId, {
      base,
      editKind: 'cinemeta',
      label: (p) => `Before changing ${p.name}'s Cinemeta`,
      change: async (current, profile) => {
        const { index, wrappedIndex } = findCinemeta(current);
        if (index === -1) throw new UserError('NO_CINEMETA', `${profile.name} doesn't have Cinemeta, so there's nothing to change.`);
        let settings = wanted;
        let taker = null;
        if (wanted?.handoff) {
          const i = current.findIndex((a) => addonRef(a) === wanted.handoff);
          if (i === -1 || i === index || !(isFullMetadata(current[i]) || i === wrappedIndex)) {
            throw new UserError('NO_HANDOFF', `That add-on can't take over Cinemeta's job in ${profile.name}. Reload the page and try again.`);
          }
          taker = current[i];
          settings = settingsForHandoff(taker);
        }
        const warnings = [];
        const addons = await this.applyCinemeta(current, settings, warnings);
        const what = describeChanges(deriveSettings(current[index].manifest), settings);
        const why = taker ? ` (handed to ${taker.manifest?.name || 'another add-on'})` : '';
        return { addons, warnings, activity: `Changed ${profile.name}'s Cinemeta${why}: ${what.join(', ') || 'no change'}` };
      },
    });
  }

  /**
   * Make one add-on the source of details pages: it moves to the top of the
   * list (Stremio takes details from the first add-on that gives them), and
   * Cinemeta's own details pages go off, or back on when Cinemeta is the one
   * picked. Catalogs and search are left as they are.
   */
  async setMetadataSource(profileId, ref, { base }) {
    let sourceName = null;
    const result = await this.editAddons(profileId, {
      base,
      editKind: 'addons',
      label: (p) => `Before changing where ${p.name}'s details pages come from`,
      change: async (current, profile) => {
        const { index } = findCinemeta(current);
        const pick = current.findIndex((a) => addonRef(a) === ref);
        if (pick === -1 || isSelfAddon(current[pick]) || !(pick === index || givesTitleDetails(current[pick]))) {
          throw new UserError('NO_METADATA', `That add-on can't give ${profile.name}'s details pages. Reload the page and try again.`);
        }
        const name = current[pick].manifest?.name || 'that add-on';
        sourceName = name;
        const warnings = [];
        let list = current;
        if (index !== -1) {
          const now = deriveSettings(current[index].manifest);
          list = await this.applyCinemeta(current, { ...now, removeMeta: pick !== index }, warnings);
        }
        const out = list.slice();
        const [chosen] = out.splice(pick, 1);
        out.unshift(chosen);
        return { addons: out, warnings, activity: `${profile.name}'s details pages now come from ${name}` };
      },
    });
    return { ...result, sourceName };
  }

  /** Put Cinemeta back exactly as Stremio ships it. Refuses if the stock copy can't be fetched. */
  resetCinemeta(profileId, { base }) {
    return this.editAddons(profileId, {
      base,
      editKind: 'cinemeta',
      label: (p) => `Before resetting ${p.name}'s Cinemeta`,
      change: async (current, profile) => {
        const { index } = findCinemeta(current);
        if (index === -1) throw new UserError('NO_CINEMETA', `${profile.name} doesn't have Cinemeta, so there's nothing to reset.`);
        const stock = await this.fetchStockCinemeta(current[index]);
        const addons = current.slice();
        addons[index] = { ...current[index], manifest: stock };
        return { addons, activity: `Reset ${profile.name}'s Cinemeta to Stremio's default` };
      },
    });
  }

  /** Apply Cinemeta settings to a list, fetching the stock copy only if rows must come back. */
  async applyCinemeta(addons, settings, warnings) {
    const { index } = findCinemeta(addons);
    if (index === -1) return addons;
    const current = addons[index].manifest;
    const next = { ...STOCK_SETTINGS, ...settings };
    if (sameSettings(deriveSettings(current), next)) return addons;
    const stock = needsStock(current, next) ? await this.fetchStockCinemeta(addons[index]) : null;
    const out = addons.slice();
    out[index] = { ...addons[index], manifest: buildManifest({ current, stock, settings: next }) };
    if (next.removeMeta && !anotherAddonServesMeta(out, index)) warnings.push(NO_DETAILS_WARNING);
    return out;
  }

  async fetchStockCinemeta(addon) {
    let stock;
    try {
      stock = checkManifest(await this.fetchManifest(addon.transportUrl));
    } catch (err) {
      this.log.warn('Stock Cinemeta fetch failed', { error: err.message });
      throw new UserError('CINEMETA_UNREACHABLE', "Couldn't reach Cinemeta to bring those rows back, so nothing was changed. Try again in a minute.");
    }
    if (stock.id !== CINEMETA_ID) throw new UserError('CINEMETA_UNREACHABLE', "Cinemeta's link didn't return Cinemeta, so nothing was changed.");
    return stock;
  }

  /**
   * The one way an edit reaches a profile's add-ons. For the profile in use
   * it writes Stremio (after a backup of the whole account); for any other it
   * changes only the saved copy (after a backup of it). `change(current,
   * profile)` returns `{ addons, activity, warnings? }`.
   */
  editAddons(profileId, opts) {
    return this.lock.run(() => this.doEditAddons(profileId, opts));
  }

  async doEditAddons(profileId, { base, editKind, label, change }) {
    const account = this.requireAccount();
    this.assertNoOpenJournal();
    const profile = this.requireProfile(profileId);
    const active = this.repo.getState()?.active_profile_id === profileId;
    let authKey = null;
    let live = null;
    let current;
    if (active) {
      ({ authKey } = await this.session());
      live = await this.readLive(authKey);
      this.checkLiveSize(live);
      current = live.addons;
    } else {
      current = this.savedSnapshot(profileId).addons;
    }
    if (base != null && addonsHash(current) !== base) {
      throw new UserError('CHANGED', `${profile.name}'s add-ons changed since this page was opened${active ? ' (in Stremio)' : ''}. Nothing was saved: reload the page and make the change again.`);
    }

    const { addons: wanted, activity, warnings = [] } = await change(current, profile);
    const next = this.prepareAddons(wanted);
    checkAddons(next, profile.name);
    if (JSON.stringify(next) === JSON.stringify(current)) return { changed: false, warnings: [], active, profile };

    const backupId = active
      ? this.repo.insertBackup({ kind: 'pre_change', label: label(profile), stremioUserId: account.stremio_user_id, snapshot: this.capture(live), profileId, editKind })
      : this.backupProfileBeforeChange(profileId, label(profile), editKind);
    if (active) {
      try {
        await this.stremio.setAddons(authKey, next);
      } catch (err) {
        this.repo.deleteBackup(backupId);
        throw new UserError('WRITE_FAILED', `Stremio didn't take the new add-on list, so nothing changed: ${userMessageOf(err)}`, { cause: err });
      }
      this.noteAddons(next);
    }
    this.repo.saveProfileAddons(profileId, next);
    this.repo.pruneBackups();
    this.repo.logActivity('edit', activity);
    this.log.info('Add-ons edited', { profileId, editKind, live: active });
    return { changed: true, backupId, warnings, active, profile };
  }

  /** The newest add-on or Cinemeta edit of the last 24 hours that can still be undone, or null. */
  latestUndo() {
    return this.repo.latestUndoableEdit(this.now() - UNDO_MS);
  }

  /**
   * Undo an add-on or Cinemeta edit: put back the add-on list from the
   * backup taken before it. Only add-ons change; the library and progress
   * since then stay.
   */
  undoEdit(backupId) {
    return this.lock.run(async () => {
      const account = this.requireAccount();
      const row = this.repo.getBackupRow(backupId);
      if (!row || row.kind !== 'pre_change' || !['addons', 'cinemeta'].includes(row.edit_kind) || row.undone_at != null) {
        throw new UserError('NOT_FOUND', "That edit can't be undone any more.");
      }
      if (row.profile_id == null || !this.repo.getProfile(row.profile_id)) {
        throw new UserError('NOT_FOUND', 'The profile that edit was made to no longer exists.');
      }
      this.assertAnchor(row, account, 'The backup taken before that edit');
      const { addons } = decodeSnapshot(this.repo.cipher, row, 'The backup taken before that edit');
      const result = await this.doEditAddons(row.profile_id, {
        base: null,
        editKind: 'undo',
        label: (p) => `Before undoing an edit of ${p.name}'s add-ons`,
        change: async (current, profile) => ({ addons, activity: `Undid an edit of ${profile.name}'s add-ons` }),
      });
      this.repo.markUndone(backupId);
      return result;
    });
  }

  /** Can each add-on of the list be reached? `{ [ref]: 'ok' | 'unreachable' | 'device' }`. */
  async checkAddonHealth(profileId) {
    const { addons } = await this.editableAddons(profileId);
    this.spendFetches(addons.filter((a) => !isSelfAddon(a) && !runsOnDevice(a)).length);
    const results = {};
    const queue = [...addons];
    const worker = async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        const ref = addonRef(a);
        if (isSelfAddon(a)) results[ref] = 'ok';
        else if (runsOnDevice(a)) results[ref] = 'device';
        else {
          try {
            await this.fetchManifest(a.transportUrl);
            results[ref] = 'ok';
          } catch {
            results[ref] = 'unreachable';
          }
        }
      }
    };
    await Promise.all(Array.from({ length: HEALTH_CONCURRENCY }, worker));
    return results;
  }

  /** Fetch an add-on by its link for a page to add (held for 30 minutes by ref). */
  async lookupAddon(raw) {
    return describeAddon(await this.fetchAddon(raw));
  }

  async fetchAddon(raw) {
    let url;
    let manifest;
    try {
      url = normaliseAddonUrl(raw);
      this.spendFetches(1);
      manifest = checkManifest(await this.fetchManifest(url));
    } catch (err) {
      if (err instanceof FetchError) throw new UserError('ADDON_FETCH', err.message);
      throw err;
    }
    if (manifest.id === ADDON_ID) throw new UserError('ADDON_FETCH', 'That is OpenProfiles itself. Every profile has it already.');
    const addon = { transportUrl: url, transportName: '', manifest, flags: {} };
    const now = this.now();
    for (const [key, entry] of this.addonStash) if (entry.expiresAt <= now) this.addonStash.delete(key);
    while (this.addonStash.size >= 30) this.addonStash.delete(this.addonStash.keys().next().value);
    this.addonStash.set(addonRef(addon), { addon, expiresAt: now + ADDON_STASH_MS });
    return addon;
  }

  stashedAddon(ref) {
    const entry = this.addonStash.get(ref);
    return entry && entry.expiresAt > this.now() ? entry.addon : undefined;
  }

  assertKeepsProtected(before, after) {
    const dropped = droppedProtected(before, after);
    if (dropped.length) {
      const names = dropped.map((a) => a.manifest?.name || a.manifest?.id).join(' and ');
      throw new UserError('PROTECTED', `${names} can't be removed (you can still move ${dropped.length === 1 ? 'it' : 'them'}).`);
    }
  }

  renameProfile(id, name) {
    const profile = this.requireProfile(id);
    const clean = this.validateName(name);
    if (clean.toLowerCase() !== profile.name.toLowerCase()) this.assertNameFree(clean);
    this.repo.renameProfile(id, clean);
    if (clean !== profile.name) this.repo.logActivity('profile', `Renamed "${profile.name}" to "${clean}"`);
  }

  /** `picture` is an avatar preset (see addon/avatars.js); omitted keeps the current one. */
  setAvatar(id, colour, picture) {
    const profile = this.requireProfile(id);
    this.validateColour(colour);
    const preset = picture ?? profile.avatar_preset;
    if (!isValidAvatar(preset)) throw new UserError('BAD_INPUT', 'Pick one of the listed pictures.');
    this.repo.setProfileAvatar(id, preset, colour);
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
      this.repo.moveProfileToBin(id);
      this.repo.logActivity('profile', `Deleted "${profile.name}" (in the bin for ${BIN_DAYS} days)`);
      this.log.info('Profile moved to the bin', { profileId: id });
    });
  }

  listBin() {
    return this.repo.listBin().map((p) => ({ ...p, purgeAt: p.deleted_at + BIN_DAYS * DAY_MS }));
  }

  /** Bring a profile back from the bin. If its name was reused meanwhile, it comes back as "Name (restored)". */
  restoreFromBin(id) {
    return this.lock.run(async () => {
      const profile = this.repo.getBinProfile(id);
      if (!profile) throw new UserError('NOT_FOUND', "That profile isn't in the bin any more.");
      this.assertRoomForProfile();
      let name = profile.name;
      if (this.nameTaken(name)) name = `${profile.name.slice(0, MAX_NAME_LENGTH - 11)} (restored)`;
      if (this.nameTaken(name)) throw new UserError('NAME_TAKEN', `Rename "${name}" first, then bring this profile back.`);
      this.repo.restoreProfileFromBin(id, name);
      this.repo.logActivity('profile', `Brought "${name}" back from the bin`);
      return this.repo.getProfile(id);
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
    this.repo.logActivity('switch', `Switched from ${outgoing ? `"${outgoing.name}"` : '(none)'} to "${target.name}"`);
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
        this.noteAddons(addons);
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
      this.repo.logActivity('recovery', 'Finished an interrupted switch');
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
      this.repo.logActivity('recovery', 'Went back to before an interrupted switch');
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
      this.repo.logActivity('backup', `Backed up: "${clean}"`);
      return this.repo.getBackup(id);
    });
  }

  /**
   * The daily automatic backup of the live account. Skipped when nothing
   * changed since the last automatic one, while a switch is unfinished, or
   * when Stremio has signed the account out. Returns what happened.
   */
  autoBackup() {
    return this.lock.run(async () => {
      const account = this.requireAccount();
      if (this.repo.getOpenJournal()) return { done: false, reason: 'unfinished switch' };
      let authKey;
      try {
        ({ authKey } = await this.session());
      } catch (err) {
        if (err.kind === 'auth' || err.code === 'ACCOUNT_CHANGED') return { done: false, reason: 'signed out of Stremio' };
        throw err;
      }
      const live = await this.readLive(authKey);
      this.checkLiveSize(live);
      const snapshot = this.capture(live);
      const last = this.repo.latestBackup('auto');
      if (last && last.content_hash === snapshotHash(snapshot)) return { done: false, reason: 'unchanged' };
      const id = this.repo.insertBackup({ kind: 'auto', label: 'Daily backup', stremioUserId: account.stremio_user_id, snapshot });
      this.repo.pruneBackups();
      return { done: true, backupId: id };
    });
  }

  /**
   * Keep a copy of a profile's saved state before an edit changes it
   * (add-ons, Cinemeta, imports). Restoring that backup is the edit's undo.
   * Call inside the operation's lock.
   */
  backupProfileBeforeChange(profileId, label, editKind = null) {
    const account = this.requireAccount();
    const row = this.repo.getProfileRow(profileId);
    if (!row) throw new UserError('NOT_FOUND', 'That profile no longer exists.');
    const snapshot = decodeSnapshot(this.repo.cipher, row, row.name);
    const id = this.repo.insertBackup({ kind: 'pre_change', label, stremioUserId: account.stremio_user_id, snapshot, profileId, editKind });
    this.repo.pruneBackups();
    return id;
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
      this.assertAnchor(row, account, 'This backup');
      const target = decodeSnapshot(this.repo.cipher, row, 'This backup');

      // An edit's backup of a profile that isn't in use: undo only puts the
      // profile's saved copy back. Nothing in Stremio changes.
      if (row.profile_id != null && row.profile_id !== activeId) {
        const profile = this.repo.getProfile(row.profile_id);
        if (!profile) throw new UserError('NOT_FOUND', 'The profile this backup belongs to no longer exists.');
        this.repo.transaction(() => {
          this.backupProfileBeforeChange(profile.id, `Before undoing an edit of "${profile.name}"`);
          this.repo.saveProfileSnapshot(profile.id, target);
        });
        this.repo.logActivity('restore', `Put "${profile.name}" back to "${row.label}"`);
        return { warnings: [], profileOnly: true };
      }

      const { authKey } = await this.session();
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
      this.repo.logActivity('restore', `Restored "${row.label}"`);
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

  /**
   * Every profile and backup of the account in one file, sealed with
   * `passphrase` when given. Something that can't be decrypted is listed as
   * unreadable instead of failing the whole download.
   */
  exportEverything(passphrase) {
    const account = this.requireAccount();
    const activeId = this.repo.getState()?.active_profile_id;
    const decode = (row, label) => {
      try {
        return decodeSnapshot(this.repo.cipher, row, label);
      } catch (err) {
        if (err instanceof GuardError) return null;
        throw err;
      }
    };
    const profiles = this.repo.listProfiles().map((p) => {
      const snap = decode(this.repo.getProfileRow(p.id), p.name);
      return {
        name: p.name, avatar_preset: p.avatar_preset, avatar_colour: p.avatar_colour, active: p.id === activeId,
        created_at: p.created_at, snapshot_taken_at: p.snapshot_taken_at,
        ...(snap ? { library: snap.library, addons: snap.addons, notifs: snap.notifs } : { unreadable: true }),
      };
    });
    const backups = this.repo.listBackups().map((b) => {
      const snap = decode(this.repo.getBackupRow(b.id), b.label);
      return {
        kind: b.kind, label: b.label, created_at: b.created_at,
        ...(snap ? { library: snap.library, addons: snap.addons, notifs: snap.notifs } : { unreadable: true }),
      };
    });
    this.repo.logActivity('export', `Downloaded everything${passphrase ? ' (passphrase-protected)' : ''}`);
    return sealExport({
      exported_at: new Date(this.now()).toISOString(),
      stremio_user_id: account.stremio_user_id,
      stremio_email: account.stremio_email,
      profiles,
      backups,
    }, passphrase);
  }

  /**
   * Bring back an "everything" export: each profile is added (renamed if the
   * name is in use) and each backup is kept. Nothing in Stremio changes;
   * switch to a profile or restore a backup to apply it.
   */
  importEverything(raw, { passphrase, acceptOtherAccount = false } = {}) {
    return this.lock.run(async () => {
      const account = this.requireAccount();
      const file = openExport(raw, passphrase);
      if (file.stremio_user_id !== account.stremio_user_id && !acceptOtherAccount) {
        throw new UserError('OTHER_ACCOUNT', `This export is from ${file.stremio_email || 'another Stremio account'}. Tick the box to confirm you want it on this account anyway.`);
      }
      const readable = (x) => x && !x.unreadable;
      const check = (x, label) => {
        checkLibrary(x.library, label);
        checkAddons(x.addons, label);
        checkNotifs(x.notifs ?? null, label);
        return { library: x.library, addons: x.addons, notifs: x.notifs ?? null };
      };
      const profiles = (Array.isArray(file.profiles) ? file.profiles : []).filter(readable);
      const backups = (Array.isArray(file.backups) ? file.backups : []).filter(readable);
      const room = MAX_PROFILES - this.repo.countProfiles();
      if (profiles.length > room) {
        throw new UserError('TOO_MANY', `This export has ${profiles.length} profiles, and there's room for ${room} more. Delete some first.`);
      }
      const prepared = profiles.map((p, i) => ({ p, snap: check(p, `Profile ${i + 1} in the file`) }));
      const preparedBackups = backups.map((b, i) => ({ b, snap: check(b, `Backup ${i + 1} in the file`) }));
      const keepKinds = new Set(['auto', 'pre_switch', 'pre_restore', 'pre_change', 'manual', 'imported']);
      let addedProfiles = 0;
      this.repo.transaction(() => {
        for (const { p, snap } of prepared) {
          let name = this.validateName(p.name);
          if (this.nameTaken(name)) name = `${name.slice(0, MAX_NAME_LENGTH - 11)} (imported)`;
          for (let n = 2; this.nameTaken(name); n++) name = `${p.name.slice(0, MAX_NAME_LENGTH - 14)} (imported ${n})`;
          const preset = isValidAvatar(p.avatar_preset) ? p.avatar_preset : 'initial';
          const colour = AVATAR_COLOURS.includes(p.avatar_colour) ? p.avatar_colour : DEFAULT_COLOUR;
          this.repo.insertProfile({ name, avatarPreset: preset, avatarColour: colour, stremioUserId: account.stremio_user_id, snapshot: snap });
          addedProfiles++;
        }
        for (const { b, snap } of preparedBackups) {
          const kind = keepKinds.has(b.kind) ? b.kind : 'imported';
          const label = `${String(b.label || 'Backup').slice(0, 60)} (from export)`;
          this.repo.insertBackup({ kind, label, stremioUserId: account.stremio_user_id, snapshot: snap });
        }
      });
      this.repo.logActivity('import', `Brought back ${addedProfiles} profiles and ${preparedBackups.length} backups from an export`);
      return { profiles: addedProfiles, backups: preparedBackups.length, skipped: (file.profiles?.length ?? 0) + (file.backups?.length ?? 0) - profiles.length - backups.length };
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

  // ── import from StremShare ───────────────────────────────────────────────

  /**
   * Validate an uploaded StremShare backup and hold it briefly for the
   * confirm step, so the (possibly large) file is only sent once.
   */
  previewImport(raw) {
    const account = this.requireAccount();
    const parsed = parseStremShareBackup(raw);
    const id = randomToken(12);
    const now = this.now();
    for (const [key, entry] of this.importStash) if (entry.expiresAt <= now) this.importStash.delete(key);
    while (this.importStash.size >= 3) this.importStash.delete(this.importStash.keys().next().value);
    this.importStash.set(id, { parsed, expiresAt: now + IMPORT_STASH_MS });
    const { library, addons, notifs } = parsed.snapshot;
    return {
      id,
      label: parsed.label,
      kind: parsed.kind,
      createdAt: parsed.createdAt,
      counts: { library: countActive(library), addons: addons.length, notifs: notifs.length },
      sameAccount: sameAccount(parsed, account),
      sourceEmail: parsed.sourceEmail,
      suggestedName: suggestedProfileName(parsed.label),
    };
  }

  /**
   * Save a previewed file as a backup, and (`asProfile`) also as a new
   * profile. Nothing is written to Stremio: switch to the profile, or restore
   * the backup, to apply it.
   */
  confirmImport(id, { asProfile = true, name, colour = DEFAULT_COLOUR, acceptOtherAccount = false } = {}) {
    return this.lock.run(async () => {
      const account = this.requireAccount();
      const entry = this.importStash.get(id);
      if (!entry || entry.expiresAt <= this.now()) {
        throw new UserError('IMPORT_EXPIRED', 'That upload has expired. Choose the file again.');
      }
      const { parsed } = entry;
      if (sameAccount(parsed, account) !== true && !acceptOtherAccount) {
        throw new UserError('OTHER_ACCOUNT', "This backup may be from a different Stremio account. Tick the box to confirm you want it anyway.");
      }
      const { snapshot } = parsed;
      let profile = null;
      let clean = null;
      if (asProfile) {
        clean = this.validateName(name ?? suggestedProfileName(parsed.label));
        this.assertNameFree(clean);
        this.validateColour(colour);
      }
      const backupId = this.repo.transaction(() => {
        const bid = this.repo.insertBackup({
          kind: 'imported',
          label: `From StremShare: ${parsed.label ?? 'backup'}`,
          stremioUserId: account.stremio_user_id,
          snapshot,
        });
        if (asProfile) {
          const pid = this.repo.insertProfile({ name: clean, avatarPreset: 'initial', avatarColour: colour, stremioUserId: account.stremio_user_id, snapshot });
          profile = this.repo.getProfile(pid);
        }
        return bid;
      });
      this.importStash.delete(id);
      this.repo.pruneBackups();
      this.repo.logActivity('import', profile ? `Imported "${profile.name}" from StremShare` : 'Imported a StremShare backup');
      this.log.info('StremShare backup imported', { backupId, profileId: profile?.id ?? null });
      return { profile, backup: this.repo.getBackup(backupId) };
    });
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
    const live = await readLiveState(this.stremio, authKey, this.log);
    this.noteAddons(live.addons);
    return live;
  }

  checkLiveSize(live) {
    checkLiveSize(live);
  }

  /** Snapshots are stored exactly as Stremio returned them. Never clean them up: see isCleanTombstone. */
  capture(live) {
    return { library: live.library, addons: live.addons, notifs: live.notifs };
  }

  validateName(name) {
    const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
    // eslint-disable-next-line no-control-regex
    if (!clean || clean.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(clean)) {
      throw new UserError('BAD_NAME', `Profile names must be 1 to ${MAX_NAME_LENGTH} characters.`);
    }
    return clean;
  }

  nameTaken(name) {
    return this.repo.listProfiles().some((p) => p.name.toLowerCase() === name.toLowerCase());
  }

  assertNameFree(name) {
    if (this.nameTaken(name)) throw new UserError('NAME_TAKEN', `There's already a profile called "${name}".`);
  }

  assertRoomForProfile() {
    if (this.repo.countProfiles() >= MAX_PROFILES) {
      throw new UserError('TOO_MANY', `An account can have up to ${MAX_PROFILES} profiles. Delete one first.`);
    }
  }

  validateColour(colour) {
    if (!AVATAR_COLOURS.includes(colour)) throw new UserError('BAD_INPUT', 'Pick one of the listed colours.');
  }
}
