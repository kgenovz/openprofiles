import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { REDIRECT_TARGETS, autoRefreshTarget, createAddonRouter } from '../addon/routes.js';
import { LOGO_UPLOAD_MAX, PHOTO_UPLOAD_MAX, avatarTileSvg, normaliseLogo, normalisePhoto } from '../addon/art.js';
import { isPhoto, isValidAvatar } from '../addon/avatars.js';
import { AVATAR_COLOURS, BIN_DAYS, DEFAULT_COLOUR, UserError, userMessageOf } from '../core/service.js';
import { SECTIONS, Settings } from '../core/settings.js';
import { serverStats } from '../core/stats.js';
import { randomToken } from '../crypto.js';
import { createAuth, wantsJson } from './auth.js';
import { themeCss } from './theme.js';
import {
  accountPage, addonManagerPage, adminPage, avatarUrl, backupsPage, errorPage, installPage, managerAddonRow, passcodePage, privacyPage, profilesPage,
  restorePreviewPage, signInPage, unlockedPage, wizardAddonRow, wizardPage,
} from './views.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(HERE, 'static');
const FONTS_DIR = path.dirname(createRequire(import.meta.url).resolve('@fontsource/figtree/package.json'));

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; " +
    "frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Other sites never get a referrer. Our own forms still carry their origin
  // (with "no-referrer" a form POST says `Origin: null`, which the sign-in check refused).
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}

const idParam = (req) => {
  const id = Number(req.params.id);
  return Number.isSafeInteger(id) && id > 0 ? id : -1;
};

/** A profile id from a query or form field, or null. */
const profileIdOf = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

// A form's passcode turned away (missing, wrong, or too many wrong): the passcode page asks again.
const PASSCODE_REFUSALS = { PASSCODE_NEEDED: 400, BAD_PASSCODE: 400, WRONG_PASSCODE: 403, PASSCODE_WAIT: 429 };
// How long an unlock page's form stays good, and how many open ones an account can have.
const UNLOCK_NONCE_MS = 15 * 60 * 1000;
const UNLOCK_NONCES_PER_ACCOUNT = 20;

/** A request path fit for the log: add-on links carry the account's secret token as a segment. */
const logPath = (p) => String(p).replace(/[A-Za-z0-9_-]{20,}/g, '…');

/** A form field that may be sent once, many times or not at all. */
const many = (v) => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

/** Cinemeta switches as posted ("on" when ticked) into cinemeta.js settings. */
const cinemetaFromForm = (body, prefix = '') => ({
  hidePopular: body[`${prefix}popular`] !== '1',
  hideNew: body[`${prefix}new`] !== '1',
  hideFeatured: body[`${prefix}featured`] !== '1',
  removeSearch: body[`${prefix}search`] !== '1',
  removeMeta: body[`${prefix}meta`] !== '1',
});

/** Catalog renames posted as `name:<ref>:<type>:<id>` fields. */
function renamesFromForm(body) {
  // Field names come from the client: only well-formed refs, and objects without a
  // prototype, so a name like "name:__proto__:x" can't reach Object.prototype.
  const renames = Object.create(null);
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith('name:')) continue;
    const [, ref, ...rest] = key.split(':');
    const catalog = rest.join(':');
    if (!/^[0-9a-f]{16}$/.test(ref) || !catalog || catalog.length > 200) continue;
    (renames[ref] ??= Object.create(null))[catalog] = String(value);
  }
  return renames;
}

/**
 * `settings` (core/settings.js) holds what the Server tab changes; the pages
 * read it on every request, so a save shows at once.
 */
export function createApp({ config, db, accounts, log, settings = new Settings({ db }), startedAt = Date.now(), uploadReadMs = 2 * 60 * 1000 }) {
  const app = express();
  const auth = createAuth({ db, config });
  const themeVersion = () => crypto.createHash('sha1').update(themeCss(settings.branding())).digest('hex').slice(0, 10);
  /**
   * How the pages present this server, and whether the viewer runs it. A shared
   * server (anyone, or a list, can sign in) also says who runs it and what it keeps.
   */
  const site = (req) => ({
    ...settings.branding(),
    themeVersion: themeVersion(),
    shared: settings.get('access') !== 'owner',
    removeUnusedDays: settings.get('access') === 'open' ? settings.get('removeUnusedDays') : 0,
    admin: Boolean(req?.session && accounts.isAdmin(req.session.accountId)),
  });
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use('/static', express.static(STATIC_DIR, { maxAge: '1h', index: false }));
  app.use('/fonts', express.static(FONTS_DIR, { maxAge: '30d', index: false, extensions: false }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  const sendPage = (res, page, status = 200) => {
    res.status(status).set('Cache-Control', 'no-store').type('html').send(String(page));
  };

  /**
   * Run a POST action, store the outcome as a flash message, go back to a
   * page: `back` is a path or a function of the request. The action may
   * return `redirect` to go somewhere else on success.
   */
  const action = (fn, back = '/configure') => async (req, res) => {
    let to = typeof back === 'function' ? back(req) : back;
    try {
      const result = await fn(req);
      if (result?.redirect) to = result.redirect;
      if (result?.text) auth.setFlash(req, { type: 'ok', text: result.text, details: result.details });
    } catch (err) {
      if (!err.userMessage) log.error('Unexpected error', { path: logPath(req.path), error: err.message, stack: err.stack });
      auth.setFlash(req, { type: 'error', text: userMessageOf(err) });
    }
    res.redirect(303, to);
  };

  /** For the page scripts: JSON in, JSON out, errors as `{ error }`. */
  const json = (fn) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store').json(await fn(req));
    } catch (err) {
      if (!err.userMessage) log.error('Unexpected error', { path: logPath(req.path), error: err.message, stack: err.stack });
      res.status(400).json({ error: userMessageOf(err) });
    }
  };

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/privacy', (req, res) => sendPage(res, privacyPage({ site: site() })));
  // The accent colour (the page's CSP allows no inline styles). Links carry ?v=, so it can cache.
  app.get('/theme.css', (req, res) => res.set('Cache-Control', 'public, max-age=3600').type('css').send(themeCss(settings.branding())));
  app.get('/', auth.optional, (req, res) => res.redirect(303, req.session ? '/configure' : '/signin'));

  // Sign in with Stremio. The password goes to Stremio once and is never stored.
  app.get('/signin', auth.optional, (req, res) => {
    const again = req.query.again === '1';
    if (req.session && !again) return res.redirect(303, '/configure');
    const notice = req.query.deleted === '1' ? 'Your OpenProfiles account and everything saved for it were deleted. Your Stremio account is as it was.' : null;
    return sendPage(res, signInPage({ again, notice, site: site(), passcodeFor: again ? profileIdOf(req.query.passcode) : null }));
  });
  const ownOrigin = (() => {
    try {
      return new URL(config.publicUrl).origin;
    } catch {
      return null;
    }
  })();
  app.post('/signin', async (req, res, next) => {
    // A sign-in posted from another site would sign this browser into someone else's account.
    // Browsers that send Sec-Fetch-Site say where the form was: only this site's own pages count.
    // Older ones are judged by Origin when they send one: our pages' referrer policy keeps it
    // a real origin, so "null" (a sandboxed frame, a data: page) is foreign too. Without
    // Origin at all (scripts, very old browsers) the post goes ahead.
    const fetchSite = req.get('sec-fetch-site');
    const origin = req.get('origin');
    const foreign = fetchSite
      ? !['same-origin', 'none'].includes(fetchSite)
      : Boolean(origin && origin !== ownOrigin && origin !== `${req.protocol}://${req.get('host')}`);
    if (foreign) {
      return sendPage(res, signInPage({ error: 'Sign in from this page.', site: site() }), 403);
    }
    return next();
  }, async (req, res) => {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const limited = auth.checkSignInLimits(req, email);
    if (limited) {
      log.warn('Sign-in rate-limited');
      return sendPage(res, signInPage({ error: limited, email, site: site() }), 429);
    }
    try {
      const { accountId, created, warnings } = await accounts.signIn(email, password);
      const flash = created
        ? { type: 'ok', text: 'Welcome! Your account as it is now is saved as your "Original" profile, with a permanent backup.', details: warnings }
        : warnings.length ? { type: 'ok', text: 'Signed in.', details: warnings } : null;
      auth.startSession(req, res, accountId, email, flash);
      // Signed in again to reset a forgotten passcode: straight back to it.
      const passcodeFor = profileIdOf(req.body?.passcodeFor);
      return res.redirect(303, passcodeFor ? `/profiles/${passcodeFor}#passcode` : '/configure');
    } catch (err) {
      if (!err.userMessage) log.error('Sign-in failed', { error: err.message });
      const passcodeFor = profileIdOf(req.body?.passcodeFor);
      return sendPage(res, signInPage({ error: userMessageOf(err), email, site: site(), again: Boolean(passcodeFor), passcodeFor }), err.kind === 'auth' ? 401 : 400);
    }
  });

  // Stremio-facing routes, guarded by each account's add-on token rather than a session.
  app.use(createAddonRouter({ config, accounts, log, settings }));

  const r = express.Router();
  r.use(auth.require, auth.csrf, (req, res, next) => {
    req.service = accounts.forAccount(req.session.accountId);
    next();
  });

  r.post('/logout', (req, res) => {
    auth.logout(req, res);
    res.redirect(303, '/signin');
  });

  // Uploads are parsed in memory, so only one is read at a time across the server. A body
  // still arriving after uploadReadMs is cut off, so a slow sender can't hold that turn for
  // the 5 minutes Node itself would wait.
  let uploading = false;
  const oneUpload = (req, res, next) => {
    if (uploading) return res.status(429).set('Cache-Control', 'no-store').json({ error: 'Another upload is being read right now. Try again in a minute.' });
    uploading = true;
    const deadline = setTimeout(() => req.destroy(), uploadReadMs);
    req.on('end', () => clearTimeout(deadline));
    res.on('close', () => {
      clearTimeout(deadline);
      uploading = false;
    });
    return next();
  };

  const page = (req, extra = {}) => ({ site: site(req), csrf: req.session.csrf, account: req.service.status().account, flash: auth.takeFlash(req), ...extra });
  const notFound = (res, message, req = null) => sendPage(res, errorPage({ site: site(req), status: 404, message }), 404);
  /** The Undo bar's edit, unless this browser hid the bar for it. */
  const undoFor = (req) => {
    const undo = req.service.latestUndo();
    return undo && undo.id !== auth.hiddenUndo(req) ? undo : null;
  };

  // ── Profiles tab ───────────────────────────────────────────────────────────

  r.get('/configure', (req, res) => {
    const status = req.service.status();
    return sendPage(res, profilesPage({ ...page(req), status, addon: req.service.addonInfo(), undo: undoFor(req) }));
  });

  r.get('/profiles/new', async (req, res) => {
    let options;
    try {
      options = await req.service.wizardOptions();
    } catch (err) {
      if (!err.userMessage) log.error('Wizard failed to load', { error: err.message });
      auth.setFlash(req, { type: 'error', text: userMessageOf(err) });
      return res.redirect(303, '/configure');
    }
    if (!options.room) {
      auth.setFlash(req, { type: 'error', text: 'You have as many profiles as an account can have. Delete one first.' });
      return res.redirect(303, '/configure');
    }
    return sendPage(res, wizardPage({ ...page(req), options }));
  });

  // The wizard posts here (and so can a plain form with just a name).
  r.post('/profiles', async (req, res) => {
    const b = req.body;
    const values = {
      name: String(b.name ?? ''),
      from: ['empty', 'current', 'profile'].includes(b.from) ? b.from : 'empty',
      source: b.source,
      colour: AVATAR_COLOURS.includes(b.colour) ? b.colour : DEFAULT_COLOUR,
      picture: isValidAvatar(b.picture) ? b.picture : 'initial',
      addons: b.addons_shown === '1' ? many(b.addon) : null,
      cinemeta: b.cm_shown === '1' ? cinemetaFromForm(b, 'cm_') : null,
      switchNow: b.switchNow === '1',
    };
    try {
      const p = await req.service.createProfile({
        name: values.name,
        from: values.from,
        sourceProfileId: Number(values.source) || null,
        colour: values.colour,
        picture: values.picture,
        addonRefs: values.addons,
        addonUrl: String(b.addonUrl || '').trim() || null,
        cinemeta: values.cinemeta,
        switchNow: values.switchNow,
      });
      const switched = p.switched && !p.switched.alreadyActive;
      auth.setFlash(req, {
        type: 'ok',
        text: switched
          ? `Created "${p.name}" and switched to it. Click back into Stremio and it refreshes (Stremio 5). Other apps: close and reopen them.`
          : `Created "${p.name}". Stremio changes when you switch to it.`,
        details: p.warnings,
      });
      return res.redirect(303, '/configure');
    } catch (err) {
      if (!err.userMessage) log.error('Profile creation failed', { error: err.message, stack: err.stack });
      if (b.wizard !== '1') {
        auth.setFlash(req, { type: 'error', text: userMessageOf(err) });
        return res.redirect(303, '/configure');
      }
      // Back to the wizard with what was picked, so nothing has to be done again.
      try {
        const options = await req.service.wizardOptions();
        return sendPage(res, wizardPage({ ...page(req), options, error: userMessageOf(err), values }), 400);
      } catch {
        auth.setFlash(req, { type: 'error', text: userMessageOf(err) });
        return res.redirect(303, '/configure');
      }
    }
  });

  r.get('/profiles/:id', (req, res) => {
    const id = idParam(req);
    if (!req.service.repo.getProfile(id)) return notFound(res, 'That profile no longer exists.', req);
    const status = req.service.status();
    return sendPage(res, profilesPage({
      ...page(req), status, addon: req.service.addonInfo(), undo: undoFor(req), editing: req.service.profileDetails(id), fresh: auth.fresh(req),
    }));
  });

  /** A locked profile's passcode page, signed in: it posts to the profile's Switch. */
  const sendPasscodePage = (req, res, p, error = null, status = 200) => sendPage(res, passcodePage({
    ...page(req), profile: p, picture: avatarUrl(p), action: `/profiles/${p.id}/switch`, error, cancel: '/configure',
  }), status);

  r.get('/profiles/:id/unlock', (req, res) => {
    const p = req.service.repo.getProfile(idParam(req));
    if (!p) return notFound(res, 'That profile no longer exists.', req);
    if (!p.has_passcode || p.id === req.service.repo.getState()?.active_profile_id) return res.redirect(303, '/configure');
    return sendPasscodePage(req, res, p);
  });

  // A locked profile's Switch button posts without a code: that opens its passcode page first.
  r.post('/profiles/:id/switch', async (req, res) => {
    const id = idParam(req);
    const passcode = typeof req.body.passcode === 'string' ? req.body.passcode : null;
    try {
      const result = await req.service.switchTo(id, { passcode, via: 'web' });
      auth.setFlash(req, result.alreadyActive
        ? { type: 'ok', text: `"${result.profile.name}" is already in use.` }
        : {
          type: 'ok',
          text: `Switched to "${result.profile.name}". Click back into Stremio and it refreshes (Stremio 5). Other apps: close and reopen them.`,
          details: result.warnings,
        });
    } catch (err) {
      const p = Object.hasOwn(PASSCODE_REFUSALS, err.code) ? req.service.repo.getProfile(id) : null;
      if (p) {
        if (passcode === null && err.code === 'PASSCODE_NEEDED') return res.redirect(303, `/profiles/${id}/unlock`);
        return sendPasscodePage(req, res, p, err.userMessage, PASSCODE_REFUSALS[err.code]);
      }
      if (!err.userMessage) log.error('Unexpected error', { path: logPath(req.path), error: err.message, stack: err.stack });
      auth.setFlash(req, { type: 'error', text: userMessageOf(err) });
    }
    return res.redirect(303, '/configure');
  });

  r.post('/profiles/:id/passcode', action(async (req) => {
    const remove = req.body.remove === '1';
    const { profile, kind } = await req.service.setPasscode(idParam(req), {
      code: remove ? null : String(req.body.passcode ?? ''),
      current: typeof req.body.current === 'string' ? req.body.current : null,
      fresh: auth.fresh(req),
    });
    return {
      text: {
        set: `Locked ${profile.name}. Switching to it now asks for the passcode.`,
        change: `Changed ${profile.name}'s passcode.`,
        remove: `Removed ${profile.name}'s passcode.`,
      }[kind] ?? `${profile.name} has no passcode.`,
    };
  }, (req) => `/profiles/${idParam(req)}#passcode`));

  r.post('/profiles/:id/save', action(async (req) => {
    const { profile, notifsSaved } = await req.service.saveNow();
    return {
      text: `Saved "${profile.name}".`,
      details: notifsSaved ? [] : ["Stremio didn't return notifications, so the previously saved ones were kept."],
    };
  }, (req) => (req.query.back === 'edit' ? `/profiles/${idParam(req)}#saved` : '/configure')));

  r.post('/profiles/:id/rename', action(async (req) => {
    req.service.renameProfile(idParam(req), req.body.name);
    return { text: 'Renamed.' };
  }, (req) => `/profiles/${idParam(req)}#basics`));

  r.post('/profiles/:id/avatar', action(async (req) => {
    req.service.setAvatar(idParam(req), req.body.colour, req.body.picture);
    return { text: 'Picture saved.' };
  }, (req) => `/profiles/${idParam(req)}#picture`));

  // A photo for the profile's picture. The page script shrinks it and uploads the bytes;
  // they're decoded and drawn again before anything is kept.
  r.post('/profiles/:id/photo', oneUpload, express.raw({ type: () => true, limit: PHOTO_UPLOAD_MAX }), json(async (req) => {
    const id = idParam(req);
    req.service.requireProfile(id);
    const jpeg = await normalisePhoto(req.body);
    if (!jpeg) throw new UserError('PHOTO', "That picture couldn't be read. Use a PNG, JPG or WebP photo.");
    const p = req.service.setPhoto(id, jpeg);
    auth.setFlash(req, { type: 'ok', text: `New photo for ${p.name}. Stremio shows it from the next time it loads the row.` });
    return { ok: true };
  }));

  r.post('/profiles/:id/photo/remove', action(async (req) => {
    const p = req.service.removePhoto(idParam(req));
    return { text: `Removed ${p.name}'s photo.` };
  }, (req) => `/profiles/${idParam(req)}#picture`));

  r.post('/profiles/:id/delete', action(async (req) => {
    await req.service.deleteProfile(idParam(req));
    return { text: `Profile deleted. It's in the bin on the Backups tab for ${BIN_DAYS} days.`, redirect: '/configure' };
  }, (req) => `/profiles/${idParam(req)}#danger`));

  // ── add-on manager and Cinemeta ─────────────────────────────────────────────

  r.get('/profiles/:id/addons', async (req, res) => {
    const id = idParam(req);
    if (!req.service.repo.getProfile(id)) return notFound(res, 'That profile no longer exists.', req);
    try {
      const manager = await req.service.addonManager(id);
      return sendPage(res, addonManagerPage({ ...page(req), manager, undo: undoFor(req) }));
    } catch (err) {
      if (!err.userMessage) log.error('Add-on manager failed to load', { error: err.message });
      auth.setFlash(req, { type: 'error', text: userMessageOf(err) });
      return res.redirect(303, `/profiles/${id}#addons`);
    }
  });

  const editResult = (result, what) => {
    if (!result.changed) return { text: 'Nothing to save: that is how it already was.' };
    return {
      text: `Saved ${result.profile.name}'s ${what}${result.active ? ' and updated Stremio' : ''}.`,
      details: result.warnings,
    };
  };

  r.post('/profiles/:id/addons', action(async (req) => {
    const removes = new Set(many(req.body.remove));
    const result = await req.service.saveAddons(idParam(req), {
      base: String(req.body.base || ''),
      refs: many(req.body.ref).filter((ref) => !removes.has(ref)),
      renames: renamesFromForm(req.body),
      addRef: String(req.body.addRef || '') || null,
      addUrl: String(req.body.addUrl || '').trim() || null,
    });
    return editResult(result, 'add-ons');
  }, (req) => `/profiles/${idParam(req)}/addons`));

  r.post('/profiles/:id/cinemeta', action(async (req) => {
    const handoff = many(req.body.handoff).filter(Boolean).pop();
    const wanted = handoff ? { handoff } : cinemetaFromForm(req.body);
    const result = await req.service.saveCinemeta(idParam(req), wanted, { base: String(req.body.base || '') });
    return editResult(result, 'Cinemeta');
  }, (req) => `/profiles/${idParam(req)}/addons#cinemeta-panel`));

  r.post('/profiles/:id/metadata', action(async (req) => {
    const result = await req.service.setMetadataSource(idParam(req), String(req.body.source || ''), { base: String(req.body.base || '') });
    if (!result.changed) return { text: `Details pages already come from ${result.sourceName}.` };
    return {
      text: `${result.profile.name}'s details pages now come from ${result.sourceName}${result.active ? ', in Stremio too' : ''}.`,
      details: result.warnings,
    };
  }, (req) => `/profiles/${idParam(req)}/addons#metadata`));

  r.post('/profiles/:id/cinemeta/add', action(async (req) => {
    const result = await req.service.addCinemeta(idParam(req), { base: String(req.body.base || '') });
    if (!result.changed) return { text: `${result.profile.name} already has Cinemeta.` };
    return {
      text: result.shell
        ? `Added Cinemeta to ${result.profile.name}${result.active ? ' and Stremio' : ''} for the Calendar and new-episode notifications only: its rows, search and details pages are off, so nothing shows twice.`
        : `Added Cinemeta to ${result.profile.name}${result.active ? ' and Stremio' : ''}, at the bottom of the list. Calendar and new-episode notifications work again.`,
    };
  }, (req) => `/profiles/${idParam(req)}/addons#cinemeta-panel`));

  r.post('/profiles/:id/cinemeta/reset', action(async (req) => {
    const result = await req.service.resetCinemeta(idParam(req), { base: String(req.body.base || '') });
    return editResult(result, 'Cinemeta');
  }, (req) => `/profiles/${idParam(req)}/addons#cinemeta-panel`));

  r.post('/profiles/:id/addons/health', json((req) => req.service.checkAddonHealth(idParam(req))));

  // Fetch an add-on by its link; the page gets the row to show, already rendered.
  r.post('/addons/lookup', express.json({ limit: '64kb' }), json(async (req) => {
    const found = await req.service.lookupAddon(String(req.body?.url || ''));
    if (found.self) throw new UserError('ADDON_FETCH', 'That is OpenProfiles itself. Every profile has it already.');
    const row = req.body?.for === 'wizard' ? wizardAddonRow(found, { checked: true }) : managerAddonRow(found, { isNew: true });
    return { ref: found.ref, name: found.name, html: String(row) };
  }));

  // Hide the Undo bar for this edit in this browser. The page script sends it in the background.
  r.post('/edits/:id/hide', (req, res) => {
    auth.hideUndo(res, idParam(req));
    if (req.get('x-requested-with') === 'fetch') return res.status(204).end();
    return res.redirect(303, '/configure');
  });

  r.post('/edits/:id/undo', action(async (req) => {
    const what = req.service.repo.getBackup(idParam(req))?.edit_kind === 'cinemeta' ? 'Cinemeta is' : 'add-ons are';
    const result = await req.service.undoEdit(idParam(req));
    return { text: `Undone: ${result.profile.name}'s ${what} back as before${result.active ? ', in Stremio too' : ''}.` };
  }, (req) => {
    const row = req.service.repo.getBackup(idParam(req));
    return row?.profile_id ? `/profiles/${row.profile_id}#addons` : '/configure';
  }));

  // ── recovery ───────────────────────────────────────────────────────────────

  r.post('/recovery/finish', action(async (req) => {
    const { warnings } = await req.service.finishInterrupted();
    return { text: 'Finished.', details: warnings };
  }));

  r.post('/recovery/rollback', action(async (req) => {
    const { warnings } = await req.service.rollbackInterrupted();
    return { text: 'Went back to how things were before.', details: warnings };
  }));

  // ── Backups tab ────────────────────────────────────────────────────────────

  r.get('/backups', (req, res) => sendPage(res, backupsPage({
    ...page(req), backups: req.service.listBackups(), bin: req.service.listBin(), undo: undoFor(req),
  })));

  r.post('/backups', action(async (req) => {
    const b = await req.service.createBackup(req.body.label);
    return { text: `Backed up (${b.library_count} titles, ${b.addon_count} add-ons).` };
  }, '/backups'));

  // Step 1 of an import: the page's script uploads the file and gets a summary back.
  r.post('/import/preview', oneUpload, express.text({ type: '*/*', limit: '64mb' }), (req, res) => {
    res.set('Cache-Control', 'no-store');
    let raw;
    try {
      raw = JSON.parse(req.body);
    } catch {
      return res.status(400).json({ error: "That file isn't valid JSON, so it can't be a StremShare backup." });
    }
    try {
      return res.json(req.service.previewImport(raw));
    } catch (err) {
      if (!err.userMessage) log.error('Import preview failed', { error: err.message });
      return res.status(400).json({ error: userMessageOf(err) });
    }
  });

  r.post('/import/confirm', action(async (req) => {
    const asProfile = req.body.as !== 'backup';
    const { profile } = await req.service.confirmImport(String(req.body.id || ''), {
      asProfile,
      name: req.body.name,
      acceptOtherAccount: req.body.acceptOtherAccount === '1',
    });
    return profile
      ? { text: `Imported as the profile "${profile.name}" (and kept as a backup). Switch to it to load it into Stremio.`, redirect: '/configure' }
      : { text: 'Imported as a backup. Restore it from the list to load it into Stremio.' };
  }, '/backups'));

  /** A backup's restore preview; a backup of a locked profile asks for its passcode there. */
  const sendRestorePreview = (req, res, backup, error = null, code = 200) => {
    const status = req.service.status();
    const active = status.profiles.find((p) => p.id === status.activeProfileId) || null;
    const backupOf = backup.profile_id != null && backup.profile_id !== status.activeProfileId ? req.service.repo.getProfile(backup.profile_id) : null;
    const addonsOnly = backup.kind === 'pre_change' && backup.profile_id != null && Boolean(req.service.repo.getProfile(backup.profile_id));
    return sendPage(res, restorePreviewPage({
      site: site(req),
      csrf: req.session.csrf, backup, active, locked: Boolean(status.openJournal), account: status.account, backupOf, addonsOnly,
      codeFor: req.service.lockedHolder(backup), error,
    }), code);
  };

  r.get('/backups/:id/restore', (req, res) => {
    const backup = req.service.getBackup(idParam(req));
    if (!backup) return notFound(res, 'That backup no longer exists.', req);
    return sendRestorePreview(req, res, backup);
  });

  r.post('/backups/:id/restore', async (req, res) => {
    const id = idParam(req);
    try {
      const result = await req.service.restoreBackup(id, { passcode: typeof req.body.passcode === 'string' ? req.body.passcode : null });
      auth.setFlash(req, result.profileOnly
        ? { type: 'ok', text: "Put back. Only that profile's saved copy changed; Stremio didn't." }
        : { type: 'ok', text: 'Backup restored. Click back into Stremio and it refreshes (Stremio 5). Other apps: close and reopen them.', details: result.warnings });
      return res.redirect(303, result.profileOnly ? '/backups' : '/configure');
    } catch (err) {
      const backup = Object.hasOwn(PASSCODE_REFUSALS, err.code) ? req.service.getBackup(id) : null;
      if (backup) return sendRestorePreview(req, res, backup, err.userMessage, PASSCODE_REFUSALS[err.code]);
      if (!err.userMessage) log.error('Unexpected error', { path: logPath(req.path), error: err.message, stack: err.stack });
      auth.setFlash(req, { type: 'error', text: userMessageOf(err) });
      return res.redirect(303, '/configure');
    }
  });

  r.post('/backups/:id/restore-addons', action(async (req) => {
    const result = await req.service.restoreAddonsFromBackup(idParam(req));
    if (!result.changed) return { text: `${result.profile.name}'s add-ons were already like that.` };
    return { text: `Put back ${result.profile.name}'s add-ons${result.active ? ', in Stremio too' : ''}. The library wasn't touched.` };
  }, '/backups'));

  r.post('/bin/:id/restore', action(async (req) => {
    const p = await req.service.restoreFromBin(idParam(req));
    return { text: `Brought "${p.name}" back.`, redirect: `/profiles/${p.id}#edit` };
  }, '/backups#bin'));

  // Every profile and backup in one file; sealed with a passphrase if one is given.
  r.post('/export', (req, res) => {
    const passphrase = String(req.body.passphrase || '');
    if (passphrase && passphrase.length < 8) {
      auth.setFlash(req, { type: 'error', text: 'Use a passphrase of at least 8 characters, or leave it empty.' });
      return res.redirect(303, '/backups#everything');
    }
    const data = req.service.exportEverything(passphrase || null);
    res.set('Cache-Control', 'no-store');
    res.attachment(`openprofiles-everything-${new Date().toISOString().slice(0, 10)}.json`);
    return res.json(data);
  });

  // Bring back an "everything" export (the page's script uploads it as JSON).
  r.post('/import/everything', oneUpload, express.json({ limit: '128mb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const { file, passphrase, acceptOtherAccount } = req.body || {};
      const result = await req.service.importEverything(file, { passphrase: passphrase || null, acceptOtherAccount: acceptOtherAccount === true });
      auth.setFlash(req, {
        type: 'ok',
        text: `Brought back ${result.profiles} profile${result.profiles === 1 ? '' : 's'} and ${result.backups} backup${result.backups === 1 ? '' : 's'}${result.olderLeftOut ? ` (the newest; ${result.olderLeftOut} older ones stay in the file)` : ''}. Nothing in Stremio changed.`,
        details: result.skipped ? [`${result.skipped} item${result.skipped === 1 ? " couldn't" : "s couldn't"} be read and ${result.skipped === 1 ? 'was' : 'were'} skipped.`] : [],
      });
      return res.json({ ok: true });
    } catch (err) {
      if (!err.userMessage) log.error('Import of an export failed', { error: err.message });
      return res.status(400).json({ error: userMessageOf(err), code: err.code });
    }
  });

  r.post('/backups/:id/delete', action(async (req) => {
    await req.service.deleteBackup(idParam(req));
    return { text: 'Backup deleted.' };
  }, '/backups'));

  const sendBackupFile = (req, res) => {
    let data;
    try {
      data = req.service.exportBackup(idParam(req));
    } catch (err) {
      return notFound(res, userMessageOf(err), req);
    }
    const stamp = data.created_at.slice(0, 10);
    res.set('Cache-Control', 'no-store');
    res.attachment(`openprofiles-backup-${stamp}-${idParam(req)}.json`);
    return res.json(data);
  };

  /** A backup of a locked profile asks for its passcode before the download (POSTed back here). */
  const sendDownloadCode = (req, res, holder, error = null, code = 200) => sendPage(res, passcodePage({
    ...page(req), profile: holder, picture: avatarUrl(holder), action: `/backups/${idParam(req)}/download`, error,
    cancel: '/backups', title: 'Download backup', tab: 'backups',
  }), code);

  r.get('/backups/:id/download', (req, res) => {
    const holder = req.service.lockedHolder(req.service.getBackup(idParam(req)));
    return holder ? sendDownloadCode(req, res, holder) : sendBackupFile(req, res);
  });

  r.post('/backups/:id/download', async (req, res) => {
    try {
      await req.service.checkBackupPasscode(idParam(req), typeof req.body.passcode === 'string' ? req.body.passcode : null);
    } catch (err) {
      const holder = req.service.lockedHolder(req.service.getBackup(idParam(req)));
      if (holder && Object.hasOwn(PASSCODE_REFUSALS, err.code)) return sendDownloadCode(req, res, holder, err.userMessage, PASSCODE_REFUSALS[err.code]);
      throw err;
    }
    return sendBackupFile(req, res);
  });

  // ── Install tab ────────────────────────────────────────────────────────────

  r.get('/install', (req, res) => sendPage(res, installPage({ ...page(req), addon: req.service.addonInfo() })));

  r.post('/addon/rotate', action(async (req) => {
    const info = await req.service.rotateAddonToken();
    return {
      text: info.installed
        ? 'New add-on link made. The copy installed in Stremio was updated; the old link no longer works.'
        : 'New add-on link made. The old link no longer works.',
    };
  }, '/install'));

  // ── Account tab ────────────────────────────────────────────────────────────

  r.get('/account', (req, res) => sendPage(res, accountPage({
    ...page(req), sessions: auth.listSessions(req), activity: req.service.repo.listActivity(200),
  })));

  // Before the :id route, which would otherwise match "others".
  r.post('/account/sessions/others/signout', action(async (req) => {
    auth.signOutOthers(req);
    return { text: 'Signed out everywhere else.' };
  }, '/account'));

  r.post('/account/sessions/:id/signout', action(async (req) => {
    auth.signOutSession(req, req.params.id);
    return { text: 'Signed out there.' };
  }, '/account'));

  r.post('/account/delete', async (req, res) => {
    if (String(req.body.confirm || '').trim().toLowerCase() !== 'delete') {
      auth.setFlash(req, { type: 'error', text: 'Type DELETE to confirm deleting your OpenProfiles account.' });
      return res.redirect(303, '/account#delete');
    }
    await accounts.deleteAccount(req.session.accountId);
    auth.logout(req, res);
    return res.redirect(303, '/signin?deleted=1');
  });

  // Picture tiles for the page (banners and the picker). SVG via <img>, so nothing in them runs.
  const sendSvg = (res, svg) => res
    .set('Cache-Control', 'private, max-age=86400')
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:")
    .type('image/svg+xml')
    .send(svg);

  /** A profile's picture tile, for `service`'s account. */
  const sendProfileTile = (res, service, id) => {
    const p = service.repo.getProfile(id);
    if (!p) return res.status(404).end();
    let photo = null;
    if (isPhoto(p.avatar_preset)) {
      try {
        photo = service.repo.getProfilePhoto(p.id);
      } catch {
        // unreadable: the letter instead
      }
    }
    return sendSvg(res, avatarTileSvg({ name: p.name, colour: p.avatar_colour, avatar: p.avatar_preset, photo }));
  };

  r.get('/avatars/profile/:id.svg', (req, res) => sendProfileTile(res, req.service, idParam(req)));

  // The photo on its own, for the picture picker. The hash in the link changes with the photo.
  r.get('/avatars/profile/:id/photo.jpg', (req, res) => {
    let photo = null;
    try {
      if (req.service.repo.getProfile(idParam(req))) photo = req.service.repo.getProfilePhoto(idParam(req));
    } catch {
      // unreadable
    }
    if (!photo) return res.status(404).end();
    return res.set('Cache-Control', 'private, max-age=86400').type('jpeg').send(photo);
  });

  r.get('/avatars/preview.svg', (req, res) => {
    const { avatar = 'initial', colour = AVATAR_COLOURS[5], name = '' } = req.query;
    if (!isValidAvatar(avatar) || !AVATAR_COLOURS.includes(colour)) return res.status(400).end();
    return sendSvg(res, avatarTileSvg({ name: String(name).slice(0, 40), colour, avatar, size: 128 }));
  });

  // ── Server tab: only for whoever runs the server ───────────────────────────

  // Everyone else gets the same "nothing here" as any unknown page.
  const adminOnly = (req, res, next) => (accounts.isAdmin(req.session.accountId) ? next() : notFound(res, "There's nothing here.", req));

  /** The facts that stay in the environment, as the Server tab shows them. */
  const fixedFacts = () => [
    ['Address', config.publicUrl],
    ['Add-ons on private networks', config.allowPrivateAddons ? 'Allowed' : 'Not allowed'],
    ['Trusted proxies', String(config.trustProxy ?? 'none')],
    ['Encryption key', config.secretKey ? 'From SECRET_KEY' : 'secret.key in the data folder'],
  ];

  r.get('/admin', adminOnly, (req, res) => {
    const described = Object.fromEntries(Object.values(SECTIONS).flat().map((key) => [key, settings.describe(key)]));
    const stats = serverStats({ db, dataDir: config.dataDir ?? '.', settings, log, startedAt });
    return sendPage(res, adminPage({ ...page(req), stats, settings: described, fixed: fixedFacts() }));
  });

  const SAVED = {
    access: 'Saved who can sign in.', look: 'Saved the look.', signin: 'Saved the sign-in page.', announcement: 'Saved the announcement.',
    stremio: 'Saved. Installed copies in Stremio pick it up at their next switch.', about: 'Saved.', log: 'Saved. The log changes from now on.',
  };
  r.post('/admin/settings/:section', adminOnly, action(async (req) => {
    const section = String(req.params.section);
    if (!Object.hasOwn(SECTIONS, section)) throw new UserError('SETTINGS', "That isn't a settings section.");
    const changed = settings.saveSection(section, req.body);
    return { text: changed.length ? SAVED[section] : 'Nothing to save: that is how it already was.' };
  }, (req) => `/admin#${Object.hasOwn(SECTIONS, req.params.section) ? req.params.section : ''}`));

  /** The section a setting is in, for going back to it. */
  const sectionOf = (key) => Object.keys(SECTIONS).find((id) => SECTIONS[id].includes(key)) ?? '';
  r.post('/admin/reset/:key', adminOnly, action(async (req) => {
    const key = String(req.params.key);
    if (!sectionOf(key)) throw new UserError('SETTINGS', "That isn't a setting.");
    settings.reset(key);
    return { text: 'Back to the value in .env.' };
  }, (req) => `/admin#${sectionOf(String(req.params.key))}`));

  // The page script uploads the picture as is; it's decoded and redrawn before it's kept.
  r.post('/admin/logo', adminOnly, oneUpload, express.raw({ type: () => true, limit: LOGO_UPLOAD_MAX }), json(async (req) => {
    const png = await normaliseLogo(req.body);
    if (!png) throw new UserError('LOGO', "That picture couldn't be read. Use a PNG, JPG or WebP file under 2 MB.");
    settings.setLogo(png);
    auth.setFlash(req, { type: 'ok', text: 'New logo saved. Stremio shows it from the next switch.' });
    return { ok: true };
  }));

  r.post('/admin/logo/remove', adminOnly, action(async () => {
    settings.setLogo(null);
    return { text: 'Back to the drawn logo.' };
  }, '/admin#look'));

  // ── the unlock page Stremio opens for a locked profile ─────────────────────
  //
  // No sign-in: the add-on token in the link already proves the account, and a
  // bad one gets the same 404 as any unknown page. With no session to carry a
  // CSRF token, each form carries a one-time nonce, kept in memory for
  // UNLOCK_NONCE_MS (a restart only means entering the code again).

  const unlockNonces = new Map(); // account id → Map(nonce → { profileId, expiresAt })

  const issueNonce = (accountId, profileId) => {
    const now = Date.now();
    const mine = unlockNonces.get(accountId) ?? new Map();
    for (const [n, e] of mine) if (e.expiresAt <= now) mine.delete(n);
    while (mine.size >= UNLOCK_NONCES_PER_ACCOUNT) mine.delete(mine.keys().next().value);
    const nonce = randomToken(18);
    mine.set(nonce, { profileId, expiresAt: now + UNLOCK_NONCE_MS });
    unlockNonces.set(accountId, mine);
    return nonce;
  };

  /** Spends the nonce: true when it was this account's, for this profile, and still good. */
  const takeNonce = (accountId, profileId, nonce) => {
    const mine = unlockNonces.get(accountId);
    const entry = typeof nonce === 'string' ? mine?.get(nonce) : null;
    if (!entry) return false;
    mine.delete(nonce);
    return entry.profileId === profileId && entry.expiresAt > Date.now();
  };

  /** The account and profile an unlock link names, or null after answering 404. */
  const unlockTarget = (req, res) => {
    const hit = accounts.byAddonToken(req.params.token);
    const profile = hit?.service.repo.getProfile(idParam(req));
    if (!profile) {
      sendPage(res, errorPage({ site: site(), status: 404, message: "There's nothing here." }), 404);
      return null;
    }
    accounts.noteAddonUse(hit.account.id);
    const active = hit.service.repo.getState()?.active_profile_id === profile.id;
    return { ...hit, profile, active, token: req.params.token };
  };

  const sendUnlockPage = (res, { account, profile, token }, error = null, status = 200) => sendPage(res, passcodePage({
    site: site(),
    nonce: issueNonce(account.id, profile.id),
    profile,
    picture: avatarUrl(profile, `/${token}`),
    action: `/${token}/unlock/${profile.id}`,
    error,
    locked: Boolean(profile.has_passcode),
  }), status);

  // Back into Stremio by the same deep link as the Refresh stream: Library on Android, Home elsewhere.
  const sendUnlocked = (req, res, { profile }, switched) => sendPage(res, unlockedPage({
    site: site(), profile, switched, target: REDIRECT_TARGETS[autoRefreshTarget(req.get('user-agent'))],
  }));

  app.get('/:token/unlock/:id', (req, res) => {
    const hit = unlockTarget(req, res);
    if (!hit) return undefined;
    return hit.active ? sendUnlocked(req, res, hit, false) : sendUnlockPage(res, hit);
  });

  app.post('/:token/unlock/:id', async (req, res) => {
    const hit = unlockTarget(req, res);
    if (!hit) return undefined;
    if (!takeNonce(hit.account.id, hit.profile.id, req.body?.nonce)) {
      return sendUnlockPage(res, hit, 'This page had expired. Enter the passcode again.', 403);
    }
    try {
      await hit.service.switchTo(hit.profile.id, { passcode: String(req.body?.passcode ?? ''), via: 'stremio' });
    } catch (err) {
      if (!err.userMessage) log.error('Switch from the unlock page failed', { error: err.message });
      return sendUnlockPage(res, hit, userMessageOf(err), PASSCODE_REFUSALS[err.code] ?? 400);
    }
    // A page of its own, so reloading it doesn't post again.
    return res.redirect(303, `/${hit.token}/unlock/${hit.profile.id}/done`);
  });

  app.get('/:token/unlock/:id/done', (req, res) => {
    const hit = unlockTarget(req, res);
    if (!hit) return undefined;
    return hit.active ? sendUnlocked(req, res, hit, true) : res.redirect(303, `/${hit.token}/unlock/${hit.profile.id}`);
  });

  app.get('/:token/avatars/profile/:id.svg', (req, res) => {
    const hit = accounts.byAddonToken(req.params.token);
    return hit ? sendProfileTile(res, hit.service, idParam(req)) : res.status(404).end();
  });

  app.use(r);

  app.use((req, res) => sendPage(res, errorPage({ site: site(), status: 404, message: "There's nothing here." }), 404));
  // Four parameters is how Express recognises an error handler.
  app.use((err, req, res, _next) => {
    // A body that won't parse or is too big is the sender's problem, not the server's: a warning,
    // and its error message quotes part of the body, so only the type goes in the log.
    const parse = err.type === 'entity.parse.failed' || err.type === 'entity.too.large';
    if (parse) log.warn('Request body refused', { path: logPath(req.path), error: err.type });
    else log.error('Request failed', { path: logPath(req.path), error: err.message, stack: err.stack });
    const status = err.status && err.status < 500 ? err.status : 500;
    const message = status === 500 ? 'The server log has details.'
      : err.type === 'entity.too.large' ? "That's more than this page can send. An add-on link that long is more than OpenProfiles takes."
        : 'That request was not valid.';
    if (wantsJson(req)) return res.status(status).set('Cache-Control', 'no-store').json({ error: message });
    return sendPage(res, errorPage({ site: site(), status, message }), status);
  });

  return app;
}
