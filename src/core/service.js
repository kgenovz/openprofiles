import { DecryptError, randomToken } from '../crypto.js';
import { silentLogger } from '../log.js';
import {
  addonPool, addonRef, addonsFingerprint, addonsHash, cinemetaOf, describeAddon, describeListChange, droppedProtected, listFromRefs,
  runsOnDevice,
} from './addons.js';
import {
  CINEMETA_ID, STOCK_URL as CINEMETA_STOCK_URL, STOCK_SETTINGS, anotherAddonServesMeta, buildManifest, deriveSettings, describeChanges, findCinemeta,
  detailsSource, givesOwnDetailsOnly, givesTitleDetails, isFullMetadata, needsStock, sameSettings, settingsForHandoff,
} from './cinemeta.js';
import {
  MAX_MS, RESUME_MS, SETTLE_MS, UNTOUCHED_MS, isInFlight, judge, withProgress,
} from './carryover.js';
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
import crypto from 'node:crypto';
import { normalisePhoto } from '../addon/art.js';
import { isPhoto, isValidAvatar } from '../addon/avatars.js';
import { ADDON_ID, ID_PREFIX, ensureSelfAddon, isSelfAddon, stremioInstallUrl } from '../addon/manifest.js';

// Each clears 3.5:1 under a white initial (see the poster artboard in the M2 design).
export const AVATAR_COLOURS = ['#e5484d', '#e05d0c', '#b7790b', '#3b8f4b', '#0f8f80', '#0a7fe0', '#8e4ec6', '#d6409f'];
export const DEFAULT_COLOUR = AVATAR_COLOURS[5];
const INTER_BATCH_DELAY_MS = 75;
const MAX_NAME_LENGTH = 40;
const IMPORT_STASH_MS = 15 * 60 * 1000;
export const MAX_PROFILES = 20;
export const BIN_DAYS = 30;
// Deleted profiles kept at most; beyond it the oldest goes for good.
export const BIN_MAX = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
export const UNDO_MS = DAY_MS;
const ADDON_STASH_MS = 30 * 60 * 1000;
const HEALTH_CONCURRENCY = 4;
// Add-on fetches an account may make (by link, health checks) in a window: plenty for a person,
// too few to use a shared server as a fetching proxy.
const FETCH_BUDGET = 80;
// An everything import keeps at most this many of the file's backups (the newest).
const IMPORT_MAX_BACKUPS = 15;
const FETCH_WINDOW_MS = 10 * 60 * 1000;
// Trips to Stremio an account may start in a window: page loads that read Stremio, switches (from
// Stremio too), saves, edits, backups. Plenty for a person; too few for a loop to get the server's
// address throttled by Stremio, which would break switching for everyone on it. Finishing or
// undoing an interrupted switch and the daily backup don't count.
export const STREMIO_BUDGET = 60;
const STREMIO_WINDOW_MS = 10 * 60 * 1000;

export const NO_DETAILS_WARNING =
  "Details pages are off and no other add-on in this profile gives them for IMDb-id titles, so those will open without descriptions or episode lists. That is fine if the profile only uses another add-on's ids (e.g. TMDB ids).";

export const NATIVE_PROFILES_WARNING =
  'Your Stremio account has its own profiles (a Supporter feature). OpenProfiles would swap the library ' +
  'inside whichever Stremio profile is open, so native profiles are the better choice for this account.';

/** A refusal or failure with a message meant for the person using the web page. */
/** The fingerprint a 'photo:<hash>' picture points at. */
export const photoHash = (jpeg) => crypto.createHash('sha256').update(jpeg).digest('hex').slice(0, 16);
const photoPreset = (hash) => (hash ? `photo:${hash}` : null);

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

/** A followed title whose owner's playback a read found carried on: `merged` is the owner's copy so far. */
function seenMoving(rec, merged, live, now) {
  const moved = live._mtime !== rec.seenMtime;
  return {
    ...rec,
    base: merged,
    seenMtime: live._mtime,
    changedAt: moved ? now : rec.changedAt,
    expiresAt: moved ? Math.min(now + RESUME_MS, rec.createdAt + MAX_MS) : rec.expiresAt,
  };
}

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
    this.stremioTimes = [];
  }

  /** Count one trip to Stremio against the account's budget, or refuse. */
  spendStremio() {
    const now = this.now();
    this.stremioTimes = this.stremioTimes.filter((t) => t > now - STREMIO_WINDOW_MS);
    if (this.stremioTimes.length >= STREMIO_BUDGET) {
      throw new UserError('SLOW_DOWN', "That's a lot of trips to Stremio in a short time. Wait a few minutes and try again.");
    }
    this.stremioTimes.push(now);
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

  /** `addons` with OpenProfiles in place, as profile `profileId`'s list (its catalog id names the profile). */
  prepareAddons(addons, profileId) {
    if (!this.selfAddon) return addons;
    return ensureSelfAddon(addons, this.selfAddon.descriptor(this.repo.getState().addon_token, profileId));
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
        await this.stremio.setAddons(authKey, ensureSelfAddon(addons, this.selfAddon.descriptor(token, this.repo.getState()?.active_profile_id)));
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
      // A new profile has no photo yet: that's uploaded on its Picture section afterwards.
      if (!isValidAvatar(picture) || isPhoto(picture)) throw new UserError('BAD_INPUT', 'Pick one of the listed pictures.');
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
        snapshot = this.profileCopy(this.capture(live));
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

      this.assertNameFree(clean);
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
    // With nothing covering IMDb ids (a TMDB-ids-only setup), the own-ids add-on is the source.
    let details = detailsSource(addons);
    if (details === -1) details = addons.findIndex((a) => !isSelfAddon(a) && givesOwnDetailsOnly(a));
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
        currentOwnIds: details !== -1 && givesOwnDetailsOnly(addons[details]),
        // `ownIds`: covers its own ids only (e.g. TMDB set to "tmdb:" ids), for setups without IMDb ids.
        options: addons.filter((a, i) => !isSelfAddon(a) && (i === index || givesTitleDetails(a) || givesOwnDetailsOnly(a)))
          .map((a) => ({ ref: addonRef(a), name: nameOf(a), ownIds: givesOwnDetailsOnly(a) })),
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
        const ownIds = pick !== -1 && givesOwnDetailsOnly(current[pick]);
        if (pick === -1 || isSelfAddon(current[pick]) || !(pick === index || givesTitleDetails(current[pick]) || ownIds)) {
          throw new UserError('NO_METADATA', `That add-on can't give ${profile.name}'s details pages. Reload the page and try again.`);
        }
        const name = current[pick].manifest?.name || 'that add-on';
        sourceName = name;
        let warnings = [];
        let list = current;
        if (index !== -1) {
          const now = deriveSettings(current[index].manifest);
          list = await this.applyCinemeta(current, { ...now, removeMeta: pick !== index }, warnings);
        }
        const out = list.slice();
        const [chosen] = out.splice(pick, 1);
        out.unshift(chosen);
        // An own-ids source (e.g. TMDB ids) is right for a setup without IMDb ids; say what it means otherwise.
        if (ownIds && detailsSource(out) === -1) {
          warnings = warnings.filter((w) => w !== NO_DETAILS_WARNING);
          warnings.push(`${name} gives details pages only for its own ids. That's right if ${profile.name} only uses those (e.g. TMDB ids); titles with IMDb ids, like ones from Cinemeta, will open without descriptions or episode lists.`);
        }
        return { addons: out, warnings, activity: `${profile.name}'s details pages now come from ${name}` };
      },
    });
    return { ...result, sourceName };
  }

  /**
   * Put Cinemeta into a profile that has none. Stremio's Calendar and
   * new-episode notifications only come from the `calendar-videos` and
   * `last-videos` catalogs of the add-on with Cinemeta's own id, so a profile
   * without it loses both, even with a wrapped copy (a ratings wrapper) in
   * it. It goes at the bottom; when another add-on already gives details
   * pages (a wrapper, TMDB…), it goes in as a shell: rows, search and details
   * off, so only those two catalogs are left and nothing shows twice.
   */
  async addCinemeta(profileId, { base }) {
    let shell = false;
    const result = await this.editAddons(profileId, {
      base,
      editKind: 'addons',
      label: (p) => `Before adding Cinemeta to ${p.name}`,
      change: async (current, profile) => {
        if (findCinemeta(current).index !== -1) return { addons: current, activity: '', noChange: true };
        const stock = await this.fetchStockCinemeta();
        shell = current.some((a) => !isSelfAddon(a) && (givesTitleDetails(a) || givesOwnDetailsOnly(a)));
        const manifest = shell
          ? buildManifest({ current: stock, settings: { hidePopular: true, hideNew: true, hideFeatured: true, removeSearch: true, removeMeta: true } })
          : stock;
        const addons = [...current, { transportUrl: CINEMETA_STOCK_URL, transportName: '', manifest, flags: { official: true, protected: true } }];
        return { addons, activity: `Added Cinemeta to ${profile.name}${shell ? ' (for the Calendar and new-episode notifications only)' : ''}` };
      },
    });
    return { ...result, shell };
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
        const stock = await this.fetchStockCinemeta();
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
    const stock = needsStock(current, next) ? await this.fetchStockCinemeta() : null;
    const out = addons.slice();
    out[index] = { ...addons[index], manifest: buildManifest({ current, stock, settings: next }) };
    if (next.removeMeta && !anotherAddonServesMeta(out, index)) warnings.push(NO_DETAILS_WARNING);
    return out;
  }

  async fetchStockCinemeta() {
    let stock;
    try {
      stock = checkManifest(await this.fetchManifest(CINEMETA_STOCK_URL));
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

    const { addons: wanted, activity, warnings = [], noChange = false } = await change(current, profile);
    if (noChange) return { changed: false, warnings: [], active, profile };
    const next = this.prepareAddons(wanted, profileId);
    checkAddons(next, profile.name);
    if (JSON.stringify(next) === JSON.stringify(current)) return { changed: false, warnings: [], active, profile };

    const backupId = active
      ? this.repo.insertBackup({ kind: 'pre_change', label: label(profile), stremioUserId: account.stremio_user_id, snapshot: this.capture(live), profileId, editKind })
      : this.backupProfileBeforeChange(profileId, label(profile), editKind);
    if (active) {
      try {
        await this.stremio.setAddons(authKey, next);
      } catch (err) {
        // Unreachable means no answer: Stremio may still have applied it, so the backup
        // of the old list stays. Any other error is a definite no.
        if (err.kind === 'unreachable') {
          throw new UserError('WRITE_UNKNOWN', `Stremio didn't answer, so the new add-on list may or may not have been saved there. The list from before was backed up; reload the page to see which one Stremio has.`, { cause: err });
        }
        this.repo.deleteBackup(backupId);
        throw new UserError('WRITE_FAILED', `Stremio didn't take the new add-on list, so nothing changed: ${userMessageOf(err)}`, { cause: err });
      }
      this.noteAddons(next);
    }
    this.repo.setAfterHash(backupId, addonsFingerprint(next));
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
      // Only the newest edit, within the undo window: an older one would also throw away the ones after it.
      if (this.latestUndo()?.id !== row.id) {
        throw new UserError('NOT_LATEST', "Only the latest edit can be undone here. To go back further, restore its backup on the Backups tab.");
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
        change: async (current, profile) => {
          if (row.after_hash && addonsFingerprint(current) !== row.after_hash) {
            throw new UserError('CHANGED_SINCE', `${profile.name}'s add-ons changed after that edit, so undoing it would also undo those changes. Nothing was changed. To go back anyway, restore it from the Backups tab.`);
          }
          return { addons, activity: `Undid an edit of ${profile.name}'s add-ons` };
        },
      });
      this.repo.markUndone(backupId);
      return result;
    });
  }

  /**
   * From the Backups tab: put back only the add-on list an edit's backup holds,
   * onto the profile it was taken of (no newest-edit or changed-since checks:
   * the restore preview says what this replaces). The library stays.
   */
  restoreAddonsFromBackup(backupId) {
    return this.lock.run(async () => {
      const account = this.requireAccount();
      const row = this.repo.getBackupRow(backupId);
      if (!row || row.kind !== 'pre_change' || row.profile_id == null) throw new UserError('NOT_FOUND', "That backup can't put back add-ons on its own.");
      if (!this.repo.getProfile(row.profile_id)) throw new UserError('NOT_FOUND', 'The profile that backup was taken of no longer exists. Restore the whole backup instead.');
      this.assertAnchor(row, account, 'This backup');
      const { addons } = decodeSnapshot(this.repo.cipher, row, 'This backup');
      const result = await this.doEditAddons(row.profile_id, {
        base: null,
        editKind: 'undo',
        label: (p) => `Before putting back ${p.name}'s add-ons from a backup`,
        change: async (current, profile) => ({ addons, activity: `Put ${profile.name}'s add-ons back to "${row.label}"` }),
      });
      if (row.edit_kind && row.undone_at == null) this.repo.markUndone(backupId);
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
    // Only this profile's own photo, as it is now.
    if (isPhoto(preset) && preset !== photoPreset(profile.photo_hash)) {
      throw new UserError('BAD_INPUT', "That photo isn't this profile's any more. Reload the page and pick again.");
    }
    this.repo.setProfileAvatar(id, preset, colour);
  }

  /**
   * The profile's own photo, already redrawn (art.js normalisePhoto), becomes
   * its picture. One per profile: a new upload replaces the old one.
   */
  setPhoto(id, jpeg) {
    const profile = this.requireProfile(id);
    const hash = photoHash(jpeg);
    this.repo.transaction(() => {
      this.repo.setProfilePhoto(id, jpeg, hash);
      this.repo.setProfileAvatar(id, photoPreset(hash), profile.avatar_colour);
    });
    this.repo.logActivity('profile', `New photo for "${profile.name}"`);
    return this.repo.getProfile(id);
  }

  /** Deletes the photo; a profile showing it goes back to its letter. */
  removePhoto(id) {
    const profile = this.requireProfile(id);
    if (!profile.photo_hash) return profile;
    this.repo.transaction(() => {
      this.repo.setProfilePhoto(id, null);
      if (isPhoto(profile.avatar_preset)) this.repo.setProfileAvatar(id, 'initial', profile.avatar_colour);
    });
    this.repo.logActivity('profile', `Removed the photo of "${profile.name}"`);
    return this.repo.getProfile(id);
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
      this.repo.trimBin(BIN_MAX);
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
      this.assertPlausibleLive(live, profile);
      // Another profile's title still playing on some device isn't this profile's to save.
      const plan = this.planCarryovers(live.library, profile.id);
      const copy = this.profileCopy({ ...this.capture(live), library: plan.library });
      const now = this.now();
      this.repo.transaction(() => {
        this.repo.saveProfileSnapshot(profile.id, copy);
        this.saveProgress(plan.progress);
        this.repo.replaceCarryovers(plan.verdicts.flatMap(({ rec, v, item }) => {
          if (v.kind === 'released') return [];
          if (v.kind === 'untouched') return rec.expiresAt > now ? [rec] : [];
          return [seenMoving(rec, v.item, item, now)];
        }));
      });
      return { profile: this.repo.getProfile(profile.id), notifsSaved: copy.notifs !== null };
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

    // 1. A half-finished switch comes first, so it isn't hidden behind "already in use".
    this.assertNoOpenJournal();
    // Idempotent: Stremio can request the stream more than once.
    if (state.active_profile_id === profileId) {
      return { alreadyActive: true, profile: this.repo.getProfile(profileId), warnings: [] };
    }

    // 2-4. Valid sign-in, same account, target decodes cleanly. No writes yet.
    const { authKey } = await this.session();
    this.assertAnchor(target, account, target.name);
    const targetSnap = decodeSnapshot(this.repo.cipher, target, target.name);

    // 5. Live state. Library or add-on read failure aborts; notifications may be null.
    const live = await this.readLive(authKey);
    this.checkLiveSize(live);
    const captured = this.capture(live);
    const outgoing = state.active_profile_id != null ? this.repo.getProfile(state.active_profile_id) : null;
    this.assertPlausibleLive(live, outgoing);

    // Titles another profile kept playing on some device go back to that profile instead of
    // into the outgoing one. Those still playing, and the outgoing profile's own, are followed.
    const plan = this.planCarryovers(live.library, outgoing?.id ?? null);
    const targetProgress = plan.progress.get(profileId);
    if (targetProgress) targetSnap.library = withProgress(targetSnap.library, targetProgress) ?? targetSnap.library;
    const follow = this.nextFollowed(plan, outgoing?.id ?? null, profileId);

    // 6-7. Backup, save the outgoing profile and open the journal, all or nothing.
    const journalId = this.repo.transaction(() => {
      const backupId = this.repo.insertBackup({
        kind: 'pre_switch',
        label: `Before switching from ${outgoing ? `"${outgoing.name}"` : '(none)'} to "${target.name}"`,
        stremioUserId: account.stremio_user_id,
        snapshot: captured,
      });
      if (outgoing) this.repo.saveProfileSnapshot(outgoing.id, this.profileCopy({ ...captured, library: plan.library }));
      this.saveProgress(plan.progress);
      return this.repo.startJournal({ kind: 'switch', fromProfileId: outgoing?.id ?? null, toProfileId: profileId, rollbackBackupId: backupId });
    });
    this.log.info('Switch started', { journalId, from: outgoing?.id ?? null, to: profileId });

    // 8-10. Write to Stremio.
    const { written, ...result } = await this.applyOrFail('switch', journalId, authKey, live, targetSnap, profileId,
      new Set(follow.map((r) => r.base._id)));

    // 11. Flip the pointer.
    this.repo.transaction(() => {
      this.repo.setActiveProfile(profileId);
      this.repo.closeJournal(journalId, 'finished', result.warnings);
      // A title the switch left as it was is still what Stremio has.
      this.repo.replaceCarryovers(follow
        .map((r) => ({ ...r, written: written.get(r.base._id) ?? plan.liveById.get(r.base._id) }))
        .filter((r) => r.written));
    });
    this.repo.pruneBackups();
    this.repo.logActivity('switch', `Switched from ${outgoing ? `"${outgoing.name}"` : '(none)'} to "${target.name}"`);
    this.logProgressMoved(plan.progress.keys());
    this.log.info('Switch finished', { journalId, ...result.library, warnings: result.warnings.length });
    return { alreadyActive: false, profile: this.repo.getProfile(profileId), ...result };
  }

  async applyOrFail(what, journalId, authKey, live, target, profileId, track = null) {
    try {
      return await this.applySnapshot(journalId, authKey, live, target, profileId, track);
    } catch (err) {
      this.repo.failJournal(journalId, userMessageOf(err));
      this.log.error(`${what} interrupted`, { journalId, error: err.message });
      const verb = { switch: 'The switch', restore: 'The restore', rollback: 'Going back' }[what];
      throw new UserError('INTERRUPTED', `${verb} stopped partway: ${userMessageOf(err)} Open the OpenProfiles page to finish it or go back.`, { cause: err });
    }
  }

  /**
   * Steps 8-10. The library and add-on writes must succeed: a throw leaves the
   * journal open, so the page offers Finish (retry) or Go back, and the pointer
   * never moves onto a profile whose add-ons aren't in Stremio. (Completing with
   * the old add-ons would save them into the target at the next switch away.)
   * Notifications are best-effort; when they can't be swapped, the account
   * remembers that Stremio's aren't the active profile's, so they aren't saved
   * into it later. `profileId` is the profile in use once it's done. With
   * `track` (title ids), `written` maps each of those titles that was written
   * to what was written for it.
   */
  async applySnapshot(journalId, authKey, live, target, profileId, track = null) {
    const warnings = [];

    this.repo.setJournalPhase(journalId, 'library');
    const library = target.library.filter((it) => !String(it._id).startsWith(ID_PREFIX));
    const lib = buildLibraryChanges(live.library, library, this.now());
    await this.putChunks(lib.changes, LIBRARY_CHUNK, (c) => this.stremio.putLibrary(authKey, c));

    this.repo.setJournalPhase(journalId, 'addons');
    const addons = this.prepareAddons(target.addons, profileId);
    if (JSON.stringify(addons) !== JSON.stringify(live.addons)) {
      await this.stremio.setAddons(authKey, addons);
      this.noteAddons(addons);
    }

    this.repo.setJournalPhase(journalId, 'notifs');
    let notifsSwapped = false;
    if (live.notifs === null) {
      warnings.push("Notifications weren't swapped: Stremio didn't return the current ones.");
    } else if (target.notifs === null) {
      warnings.push("Notifications weren't swapped: none were saved for this profile yet.");
    } else {
      const notifs = buildNotifChanges(live.notifs, target.notifs);
      try {
        await this.putChunks(notifs.changes, NOTIF_CHUNK, (c) => this.stremio.putNotifs(authKey, c));
        notifsSwapped = true;
      } catch (err) {
        warnings.push(`Notifications weren't swapped: ${userMessageOf(err)}`);
        this.log.warn('Notification write failed', { journalId, error: err.message });
      }
    }
    this.repo.setNotifsForeign(!notifsSwapped);
    const result = { library: lib.stats, warnings };
    if (track) result.written = new Map(lib.changes.filter((c) => track.has(c._id)).map((c) => [c._id, c]));
    return result;
  }

  async putChunks(changes, size, write) {
    const chunks = chunk(changes, size);
    for (let i = 0; i < chunks.length; i++) {
      await write(chunks[i]);
      if (i < chunks.length - 1) await this.sleep(INTER_BATCH_DELAY_MS);
    }
  }

  // ── titles still playing elsewhere after a switch (core/carryover.js) ────

  /** The followed titles. Unreadable records are let go rather than block a switch. */
  followed() {
    try {
      return this.repo.listCarryovers();
    } catch (err) {
      this.log.warn("Couldn't read the titles followed after a switch; letting them go", { error: err.message });
      return [];
    }
  }

  /**
   * The followed titles judged against a fresh read (`library`: the live
   * library, or just those titles). Returns the verdicts, each owner's copies
   * with new progress, and the library as the profile in use should save it:
   * titles another profile kept playing put back to what the switch wrote.
   * Records whose owner is `activeId` again, or gone, drop out.
   */
  planCarryovers(library, activeId, records = this.followed()) {
    const liveById = new Map(library.filter(hasId).map((it) => [it._id, it]));
    const verdicts = [];
    const putBack = new Map();
    const progress = new Map();
    for (const rec of records) {
      if (rec.ownerProfileId === activeId || !this.repo.getProfile(rec.ownerProfileId)) continue;
      const item = liveById.get(rec.base._id);
      const v = judge(rec, item);
      verdicts.push({ rec, v, item });
      if (v.kind !== 'owner') continue;
      putBack.set(rec.base._id, rec.written);
      progress.set(rec.ownerProfileId, [...(progress.get(rec.ownerProfileId) ?? []), v.item]);
    }
    return { verdicts, progress, liveById, library: putBack.size ? library.map((it) => putBack.get(it._id) ?? it) : library };
  }

  /**
   * What to follow after switching from `outgoingId` to `targetId` (without
   * `written` yet): other profiles' titles still playing or not touched yet,
   * and the outgoing profile's titles watched in the last half hour. The
   * target's own drop out: it's in use again, so its device writes land home.
   */
  nextFollowed(plan, outgoingId, targetId) {
    const now = this.now();
    const next = [];
    for (const { rec, v } of plan.verdicts) {
      if (rec.ownerProfileId === targetId) continue;
      if (v.kind === 'untouched' && rec.expiresAt > now) next.push(rec);
      if (v.kind === 'owner' && isInFlight(v.item, now)) {
        next.push({ ...rec, base: v.item, seenMtime: null, changedAt: now, expiresAt: Math.min(now + RESUME_MS, rec.createdAt + MAX_MS) });
      }
    }
    if (outgoingId != null) {
      const ids = new Set(next.map((r) => r.base._id));
      for (const item of plan.library) {
        if (ids.has(item._id) || String(item._id).startsWith(ID_PREFIX) || !isInFlight(item, now)) continue;
        next.push({ ownerProfileId: outgoingId, base: item, createdAt: now, changedAt: null, seenMtime: null, expiresAt: now + UNTOUCHED_MS });
      }
    }
    return next;
  }

  /** Put owners' new progress into their saved copies, never moving a title backwards. */
  saveProgress(progress) {
    for (const [ownerId, items] of progress) {
      const row = this.repo.getProfileRow(ownerId);
      if (!row) continue;
      try {
        const next = withProgress(decodeSnapshot(this.repo.cipher, row, row.name).library, items);
        if (next) this.repo.saveProfileLibrary(ownerId, next);
      } catch (err) {
        this.log.warn("Couldn't add progress made elsewhere to a profile's saved copy", { profileId: ownerId, error: err.message });
      }
    }
  }

  logProgressMoved(ownerIds) {
    for (const id of ownerIds) {
      const name = this.repo.getProfile(id)?.name;
      if (name) this.repo.logActivity('carryover', `Progress made on another device after a switch went back to "${name}"`);
    }
  }

  /**
   * The background check, every few minutes while titles are followed. Reads
   * just those titles. Once the owner's playback has been still for SETTLE_MS,
   * the progress goes into the owner's saved copy and the title is put back
   * the way the switch left it, so it leaves the profile in use. It stays
   * followed until it expires, in case it was only paused. Doesn't count
   * against the account's Stremio budget.
   */
  checkCarryovers() {
    return this.lock.run(async () => {
      const none = { following: 0, settled: 0 };
      if (!this.repo.getAccount() || this.repo.getOpenJournal()) return none;
      const now = this.now();
      const activeId = this.repo.getState()?.active_profile_id ?? null;
      const records = this.followed().filter((r) => now < r.createdAt + MAX_MS && r.ownerProfileId !== activeId);
      if (records.length === 0) {
        this.repo.replaceCarryovers([]);
        return none;
      }
      let items;
      try {
        items = await this.stremio.getLibraryItems(this.repo.getAuthKey(), [...new Set(records.map((r) => r.base._id))]);
      } catch (err) {
        if (err.kind === 'auth') {
          this.repo.replaceCarryovers([]);
          return none;
        }
        throw err;
      }
      const plan = this.planCarryovers(items, activeId, records);
      const next = [];
      const settle = [];
      for (const { rec, v, item } of plan.verdicts) {
        if (v.kind === 'released') continue;
        if (v.kind === 'untouched') {
          if (rec.expiresAt > now) next.push(rec);
        } else if (item._mtime !== rec.seenMtime) {
          next.push(seenMoving(rec, v.item, item, now));
        } else if (now - rec.changedAt >= SETTLE_MS || rec.expiresAt <= now) {
          settle.push({ rec, merged: v.item });
        } else {
          next.push({ ...rec, base: v.item });
        }
      }

      let putBack = [];
      if (settle.length) {
        try {
          const { authKey } = await this.session({ spend: false });
          const at = this.now();
          putBack = settle.map(({ rec }, i) => ({ ...rec.written, _mtime: new Date(at - i).toISOString() }));
          await this.stremio.putLibrary(authKey, putBack);
        } catch (err) {
          this.log.warn('Putting back titles that stopped playing elsewhere failed; trying again later', { error: err.message });
          putBack = [];
          next.push(...settle.map(({ rec, merged }) => ({ ...rec, base: merged })));
        }
      }
      const progress = new Map();
      if (putBack.length) {
        settle.forEach(({ rec, merged }, i) => {
          progress.set(rec.ownerProfileId, [...(progress.get(rec.ownerProfileId) ?? []), merged]);
          if (rec.expiresAt > now) next.push({ ...rec, base: merged, written: putBack[i], seenMtime: null });
        });
      }
      this.repo.transaction(() => {
        this.saveProgress(progress);
        this.repo.replaceCarryovers(next);
      });
      this.logProgressMoved(progress.keys());
      if (putBack.length) this.log.info('Titles played elsewhere after a switch went back to their profiles', { titles: putBack.length });
      return { following: next.length, settled: putBack.length };
    });
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
      const { authKey } = await this.session({ spend: false });
      this.assertAnchor(row, account, label);
      const target = decodeSnapshot(this.repo.cipher, row, label);
      const live = await this.readLive(authKey);
      const result = await this.applyOrFail(j.kind, j.id, authKey, live, target, j.to_profile_id);
      this.repo.transaction(() => {
        if (j.kind === 'switch') this.repo.setActiveProfile(j.to_profile_id);
        else this.repo.saveProfileSnapshot(j.to_profile_id, target);
        this.repo.closeJournal(j.id, 'finished', result.warnings);
        // A whole rewrite (this, going back, a restore) ends following titles played elsewhere:
        // what a device did since can't be told apart from what was just written.
        this.repo.replaceCarryovers([]);
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
      const { authKey } = await this.session({ spend: false });
      this.assertAnchor(row, account, 'The pre-switch backup');
      const snapshot = decodeSnapshot(this.repo.cipher, row, 'The pre-switch backup');
      const live = await this.readLive(authKey);
      const result = await this.applyOrFail('rollback', j.id, authKey, live, snapshot, j.from_profile_id);
      // The pointer never moved and the outgoing profile was saved before any
      // write, so closing the journal is all that's left.
      this.repo.transaction(() => {
        this.repo.closeJournal(j.id, 'rolled_back', result.warnings);
        this.repo.replaceCarryovers([]);
      });
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
        ({ authKey } = await this.session({ spend: false }));
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
      const backupOf = row.profile_id != null && row.profile_id !== activeId ? this.repo.getProfile(row.profile_id) : null;
      if (backupOf) {
        const profile = backupOf;
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
      const result = await this.applyOrFail('restore', journalId, authKey, live, target, active.id);
      this.repo.transaction(() => {
        this.repo.saveProfileSnapshot(active.id, target);
        this.repo.closeJournal(journalId, 'finished', result.warnings);
        this.repo.replaceCarryovers([]);
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
    // Everything that decrypts goes in as it is, even if it wouldn't pass the checks a
    // switch makes: the file is for keeping. Only a real decrypt failure is "unreadable".
    const decode = (row) => {
      try {
        return {
          library: this.repo.cipher.decryptJson(row.library_enc, 'library'),
          addons: this.repo.cipher.decryptJson(row.addons_enc, 'addons'),
          notifs: row.notifs_enc == null ? null : this.repo.cipher.decryptJson(row.notifs_enc, 'notifs'),
        };
      } catch (err) {
        if (err instanceof DecryptError) return null;
        throw err;
      }
    };
    const exportPhoto = (profileId) => {
      try {
        const photo = this.repo.getProfilePhoto(profileId);
        return photo ? { photo: photo.toString('base64') } : {};
      } catch (err) {
        if (err instanceof DecryptError) return {};
        throw err;
      }
    };
    const profiles = this.repo.listProfiles().map((p) => {
      const snap = decode(this.repo.getProfileRow(p.id));
      return {
        name: p.name, avatar_preset: p.avatar_preset, avatar_colour: p.avatar_colour, active: p.id === activeId,
        created_at: p.created_at, snapshot_taken_at: p.snapshot_taken_at, ...exportPhoto(p.id),
        ...(snap ? { library: snap.library, addons: snap.addons, notifs: snap.notifs } : { unreadable: true }),
      };
    });
    // Deleted profiles still in the bin, kept in the file (bringing back a file doesn't re-add them).
    const bin = this.repo.listBin().map((p) => {
      const snap = decode(this.repo.getBinProfileRow(p.id));
      return {
        name: p.name, avatar_preset: p.avatar_preset, avatar_colour: p.avatar_colour, deleted_at: p.deleted_at, ...exportPhoto(p.id),
        ...(snap ? { library: snap.library, addons: snap.addons, notifs: snap.notifs } : { unreadable: true }),
      };
    });
    const backups = this.repo.listBackups().map((b) => {
      const snap = decode(this.repo.getBackupRow(b.id));
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
      bin,
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
      const file = await openExport(raw, passphrase);
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
      // Photos are drawn again like an upload; one that can't be read is left out.
      for (const x of prepared) {
        x.photo = typeof x.p.photo === 'string' ? await normalisePhoto(Buffer.from(x.p.photo, 'base64')) : null;
      }
      const preparedBackups = backups.map((b, i) => ({ b, snap: check(b, `Backup ${i + 1} in the file`) }));
      const kindNames = { original: 'Setup', auto: 'Daily', pre_switch: 'Before a switch', pre_restore: 'Before a restore', pre_change: 'Before an edit', manual: 'Manual', imported: 'Imported' };
      const newest = preparedBackups
        .map((x) => ({ ...x, at: Date.parse(x.b.created_at) || Number(x.b.created_at) || 0 }))
        .sort((a, b) => b.at - a.at)
        .slice(0, IMPORT_MAX_BACKUPS);
      let addedProfiles = 0;
      this.repo.transaction(() => {
        for (const { p, snap, photo } of prepared) {
          const base = this.validateName(p.name);
          let name = base;
          if (this.nameTaken(name)) name = `${base.slice(0, MAX_NAME_LENGTH - 11)} (imported)`;
          for (let n = 2; this.nameTaken(name); n++) name = `${base.slice(0, MAX_NAME_LENGTH - 14)} (imported ${n})`;
          let preset = isValidAvatar(p.avatar_preset) ? p.avatar_preset : 'initial';
          const colour = AVATAR_COLOURS.includes(p.avatar_colour) ? p.avatar_colour : DEFAULT_COLOUR;
          if (isPhoto(preset) && !photo) preset = 'initial';
          if (photo && isPhoto(preset)) preset = photoPreset(photoHash(photo));
          const pid = this.repo.insertProfile({ name, avatarPreset: preset, avatarColour: colour, stremioUserId: account.stremio_user_id, snapshot: snap });
          if (photo) this.repo.setProfilePhoto(pid, photo, photoHash(photo));
          addedProfiles++;
        }
        for (const { b, snap, at } of newest) {
          const label = `${kindNames[b.kind] ?? 'Backup'}: ${String(b.label || 'Backup').slice(0, 60)} (from export)`;
          this.repo.insertBackup({ kind: 'imported', label, stremioUserId: account.stremio_user_id, snapshot: snap, createdAt: at });
        }
      });
      this.repo.pruneBackups();
      this.repo.logActivity('import', `Brought back ${addedProfiles} profiles and ${newest.length} backups from an export`);
      return {
        profiles: addedProfiles,
        backups: newest.length,
        olderLeftOut: preparedBackups.length - newest.length,
        skipped: (file.profiles?.length ?? 0) + (file.backups?.length ?? 0) - profiles.length - backups.length,
      };
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
    this.importStash.clear();
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
        this.assertRoomForProfile();
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

  /**
   * Validate the stored key against Stremio and make sure it's still the linked
   * account. Counts against the account's Stremio budget unless `spend` is false.
   */
  async session({ spend = true } = {}) {
    const account = this.requireAccount();
    if (spend) this.spendStremio();
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

  /**
   * A read that looks broken (no add-ons at all, or an empty library for a
   * profile that has titles) is refused before it can overwrite a saved copy.
   */
  assertPlausibleLive(live, profile) {
    if (live.addons.length === 0) {
      throw new UserError('EMPTY_READ', "Stremio returned no add-ons for the account, which looks like a bad read. Nothing was changed; try again in a minute.");
    }
    if (profile && live.library.length === 0 && profile.library_count > 0) {
      throw new UserError('EMPTY_READ', `Stremio returned an empty library, but ${profile.name} has ${profile.library_count} titles saved. That looks like a bad read, so nothing was changed; try again in a minute.`);
    }
  }

  /** What to save into a profile: notifications that belong to another profile aren't. */
  profileCopy(captured) {
    return this.repo.getState()?.notifs_foreign ? { ...captured, notifs: null } : captured;
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
