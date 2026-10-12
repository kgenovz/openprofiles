import crypto from 'node:crypto';

/** Shown to the owner as is (the web layer reads `userMessage`, like service.js's UserError). */
export class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.code = 'SETTINGS';
    this.userMessage = message;
  }
}

/**
 * What the owner can change on the Server tab. Each setting comes from, in
 * order: a value saved on the Server tab, its environment variable, its
 * default. Saving a value equal to what it would be anyway removes the saved
 * one, so "From .env" stays true until the owner really changes something.
 *
 * Settings that decide where the server lives or what it trusts (PUBLIC_URL,
 * SECRET_KEY, TRUST_PROXY, STREMIO_API_URL, ALLOW_PRIVATE_ADDONS, PORT,
 * DATA_DIR) are deliberately not here: they stay in the environment.
 */

export const DEFAULT_NAME = 'OpenProfiles';
export const DEFAULT_HEADLINE = 'Profiles for your Stremio account';
export const DEFAULT_INTRO = "Give everyone in the house their own library, Continue Watching and add-ons, and switch from a row on Stremio's Home.";
export const DEFAULT_ADDON_DESCRIPTION = 'Switch between the profiles saved for this Stremio account. Opening a profile switches to it; tap its stream to refresh Stremio.';
export const DEFAULT_CATALOG_NAME = 'Switch profile';
export const ACCENT_COLOURS = ['#8b6dff', '#0a7fe0', '#0f8f80', '#3b8f4b', '#b7790b', '#e05d0c', '#e5484d', '#d6409f'];
const MAX_LIST = 500;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

class Invalid extends Error {}
const invalid = (message) => { throw new Invalid(message); };

/** One line of text: collapses whitespace, caps the length. Empty → null. */
const line = (max, what) => (raw) => {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (s.length > max) invalid(`${what} can be at most ${max} characters.`);
  return s || null;
};

const oneOf = (values, what) => (raw) => {
  const s = String(raw ?? '').trim().toLowerCase();
  return values.includes(s) ? s : invalid(`${what} must be one of: ${values.join(', ')}.`);
};

const FIELDS = {
  access: { env: 'ACCESS', def: 'owner', parse: oneOf(['owner', 'list', 'open'], 'Who can sign in') },
  allowedAccounts: {
    env: 'ALLOWED_ACCOUNTS',
    def: [],
    parse: (raw) => {
      const list = [...new Set(String(raw ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
      if (list.length > MAX_LIST) invalid(`The list can hold at most ${MAX_LIST} accounts.`);
      if (list.some((s) => s.length > 254)) invalid("That list has an entry too long to be a Stremio email or user id.");
      return list;
    },
  },
  maxAccounts: {
    env: 'MAX_ACCOUNTS',
    def: null,
    parse: (raw) => {
      const s = String(raw ?? '').trim();
      if (!s) return null;
      const n = Number(s);
      return Number.isInteger(n) && n > 0 && n <= 100000 ? n : invalid('The account limit must be a whole number above 0, or empty for no limit.');
    },
  },
  logLevel: { env: 'LOG_LEVEL', def: 'info', parse: oneOf(['error', 'warn', 'info', 'debug'], 'The log level') },
  operator: { env: 'OPERATOR', def: null, parse: line(80, '"Run by"') },
  privacyNote: { env: 'PRIVACY_NOTE', def: null, parse: line(500, 'The privacy note') },
  contact: {
    def: null,
    parse: (raw) => {
      const s = line(200, 'The contact')(raw);
      if (!s) return null;
      if (EMAIL_RE.test(s)) return s;
      try {
        const url = new URL(s);
        if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
      } catch {
        // falls through
      }
      return invalid('The contact must be an email address or a web address starting with https://.');
    },
  },
  serverName: { def: DEFAULT_NAME, parse: line(40, 'The name') },
  accent: {
    def: null,
    parse: (raw) => {
      const s = String(raw ?? '').trim().toLowerCase();
      // The stock violet is the designed light/dark pair, not one fixed colour.
      if (!s || s === ACCENT_COLOURS[0]) return null;
      return /^#[0-9a-f]{6}$/.test(s) ? s : invalid('The accent colour must be a hex colour like #0a7fe0.');
    },
  },
  appearance: { def: 'auto', parse: oneOf(['auto', 'light', 'dark'], 'Appearance') },
  signinHeadline: { def: DEFAULT_HEADLINE, parse: line(80, 'The headline') },
  signinIntro: { def: DEFAULT_INTRO, parse: line(300, 'The introduction') },
  selfHostLinks: { def: true, parse: (raw) => raw === true || raw === '1' || raw === 'on' },
  announcement: { def: null, parse: line(280, 'The announcement') },
  addonName: { def: DEFAULT_NAME, parse: line(40, 'The add-on name') },
  catalogName: { def: DEFAULT_CATALOG_NAME, parse: line(40, 'The row name') },
  addonDescription: { def: DEFAULT_ADDON_DESCRIPTION, parse: line(300, 'The description') },
};

/** Which settings each Server tab form saves. Ticked-or-not boxes are absent when off. */
export const SECTIONS = {
  access: ['access', 'allowedAccounts', 'maxAccounts'],
  look: ['serverName', 'accent', 'appearance'],
  signin: ['signinHeadline', 'signinIntro', 'selfHostLinks'],
  announcement: ['announcement'],
  stremio: ['addonName', 'catalogName', 'addonDescription'],
  about: ['operator', 'contact', 'privacyNote'],
  log: ['logLevel'],
};

// Text that would fall back to a default when emptied (a name, a headline) goes back to it.
const EMPTY_MEANS_DEFAULT = new Set(['serverName', 'signinHeadline', 'signinIntro', 'addonName', 'catalogName', 'addonDescription']);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class Settings {
  constructor({ db, env = {}, now = () => Date.now() }) {
    this.db = db;
    this.env = env;
    this.now = now;
    this.listeners = [];
    this.saved = new Map(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, JSON.parse(r.value)]));
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  /** The value from the environment, or undefined when it isn't set (or doesn't parse). */
  envValue(key) {
    const f = FIELDS[key];
    const raw = f.env ? this.env[f.env] : undefined;
    if (raw == null || String(raw).trim() === '') return undefined;
    try {
      return f.parse(raw);
    } catch {
      return undefined;
    }
  }

  inherited(key) {
    const fromEnv = this.envValue(key);
    return fromEnv === undefined ? FIELDS[key].def : fromEnv;
  }

  get(key) {
    if (!Object.hasOwn(FIELDS, key)) throw new Error(`Unknown setting ${key}`);
    return this.saved.has(key) ? this.saved.get(key) : this.inherited(key);
  }

  /** For the Server tab: the value, where it comes from, and the env var it overrides. */
  describe(key) {
    const f = FIELDS[key];
    const fromEnv = this.envValue(key);
    return {
      value: this.get(key),
      source: this.saved.has(key) ? 'saved' : fromEnv !== undefined ? 'env' : 'default',
      env: f.env ?? null,
      envSet: fromEnv !== undefined,
      envRaw: fromEnv !== undefined ? String(this.env[f.env]).trim() : null,
    };
  }

  /**
   * Save one Server tab form. Every field of the section is validated before
   * anything is written; problems come back together in one SettingsError.
   */
  saveSection(section, body = {}) {
    const keys = SECTIONS[section];
    if (!keys) throw new SettingsError("That isn't a settings section.");
    const problems = [];
    const next = {};
    for (const key of keys) {
      try {
        let value = FIELDS[key].parse(body[key] ?? '');
        if (value === null && EMPTY_MEANS_DEFAULT.has(key)) value = this.inherited(key);
        next[key] = value;
      } catch (err) {
        if (!(err instanceof Invalid)) throw err;
        problems.push(err.message);
      }
    }
    if (section === 'access' && next.access === 'list' && next.allowedAccounts?.length === 0) {
      problems.push('Add at least one Stremio email or user id to the list.');
    }
    if (problems.length) throw new SettingsError(problems.join(' '));
    return this.write(next);
  }

  /** Back to the environment's value (or the default). */
  reset(key) {
    if (!Object.hasOwn(FIELDS, key)) throw new SettingsError("That isn't a setting.");
    const after = { access: this.get('access'), allowedAccounts: this.get('allowedAccounts'), [key]: this.inherited(key) };
    if (after.access === 'list' && after.allowedAccounts.length === 0) {
      throw new SettingsError('That would leave the list rule with nobody on the list. Change who can sign in first.');
    }
    return this.write({ [key]: this.inherited(key) });
  }

  write(values) {
    const changed = [];
    const upsert = this.db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    const remove = this.db.prepare('DELETE FROM settings WHERE key = ?');
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        const before = this.get(key);
        if (same(value, this.inherited(key))) {
          if (this.saved.has(key)) {
            remove.run(key);
            this.saved.delete(key);
          }
        } else {
          upsert.run(key, JSON.stringify(value), this.now());
          this.saved.set(key, value);
        }
        if (!same(before, this.get(key))) changed.push(key);
      }
    })();
    if (changed.length) for (const fn of this.listeners) fn(changed);
    return changed;
  }

  // ── what the rest of the server reads ─────────────────────────────────────

  access() {
    return { mode: this.get('access'), allowed: this.get('allowedAccounts'), maxAccounts: this.get('maxAccounts') ?? Infinity };
  }

  /** The uploaded logo as PNG bytes, or null for the drawn one. */
  logo() {
    const saved = this.saved.get('logo');
    return saved ? Buffer.from(saved.png, 'base64') : null;
  }

  /** `png` must already be re-encoded (art.js normaliseLogo); null removes the upload. */
  setLogo(png) {
    const upsert = this.db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('logo', ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    if (png) {
      const value = { png: png.toString('base64'), hash: crypto.createHash('sha1').update(png).digest('hex').slice(0, 10) };
      upsert.run(JSON.stringify(value), this.now());
      this.saved.set('logo', value);
    } else {
      this.db.prepare("DELETE FROM settings WHERE key = 'logo'").run();
      this.saved.delete('logo');
    }
    for (const fn of this.listeners) fn(['logo']);
  }

  /** Changes whenever the logo picture would: a new upload, or a new colour for the drawn one. */
  logoVersion() {
    const saved = this.saved.get('logo');
    if (saved) return saved.hash;
    return crypto.createHash('sha1').update(`drawn|${this.get('accent') ?? ''}`).digest('hex').slice(0, 10);
  }

  /** How the web pages present the server. */
  branding() {
    return {
      name: this.get('serverName'),
      accent: this.get('accent'),
      appearance: this.get('appearance'),
      customLogo: this.saved.has('logo'),
      logoVersion: this.logoVersion(),
      headline: this.get('signinHeadline'),
      intro: this.get('signinIntro'),
      selfHostLinks: this.get('selfHostLinks'),
      announcement: this.get('announcement'),
      contact: this.get('contact'),
      operator: this.get('operator'),
      privacyNote: this.get('privacyNote'),
    };
  }

  /** How the add-on presents itself in Stremio. */
  addon() {
    return {
      name: this.get('addonName'),
      description: this.get('addonDescription'),
      catalogName: this.get('catalogName'),
      logoVersion: this.logoVersion(),
    };
  }
}

