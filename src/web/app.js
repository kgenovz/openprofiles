import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAddonRouter } from '../addon/routes.js';
import { avatarTileSvg } from '../addon/art.js';
import { isValidAvatar } from '../addon/avatars.js';
import { AVATAR_COLOURS, BIN_DAYS, DEFAULT_COLOUR, UserError, userMessageOf } from '../core/service.js';
import { createAuth } from './auth.js';
import {
  accountPage, addonManagerPage, backupsPage, errorPage, installPage, managerAddonRow, profilesPage, restorePreviewPage,
  signInPage, wizardAddonRow, wizardPage,
} from './views.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(HERE, 'static');
const CLIPS_DIR = path.join(HERE, '..', '..', 'assets', 'clips');
const FONTS_DIR = path.dirname(createRequire(import.meta.url).resolve('@fontsource/figtree/package.json'));

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; " +
    "frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}

const idParam = (req) => {
  const id = Number(req.params.id);
  return Number.isSafeInteger(id) && id > 0 ? id : -1;
};

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
  const renames = {};
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith('name:')) continue;
    const [, ref, ...rest] = key.split(':');
    (renames[ref] ??= {})[rest.join(':')] = String(value);
  }
  return renames;
}

export function createApp({ config, db, accounts, log }) {
  const app = express();
  const auth = createAuth({ db, config });
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use('/static', express.static(STATIC_DIR, { maxAge: '1h', index: false }));
  app.use('/fonts', express.static(FONTS_DIR, { maxAge: '30d', index: false, extensions: false }));
  app.use('/clips', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    next();
  }, express.static(CLIPS_DIR, { maxAge: '7d', index: false }));
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
      if (!err.userMessage) log.error('Unexpected error', { path: req.path, error: err.message, stack: err.stack });
      auth.setFlash(req, { type: 'error', text: userMessageOf(err) });
    }
    res.redirect(303, to);
  };

  /** For the page scripts: JSON in, JSON out, errors as `{ error }`. */
  const json = (fn) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store').json(await fn(req));
    } catch (err) {
      if (!err.userMessage) log.error('Unexpected error', { path: req.path, error: err.message, stack: err.stack });
      res.status(400).json({ error: userMessageOf(err) });
    }
  };

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/', auth.optional, (req, res) => res.redirect(303, req.session ? '/configure' : '/signin'));

  // Sign in with Stremio. The password goes to Stremio once and is never stored.
  app.get('/signin', auth.optional, (req, res) => {
    const again = req.query.again === '1';
    if (req.session && !again) return res.redirect(303, '/configure');
    return sendPage(res, signInPage({ again }));
  });
  app.post('/signin', async (req, res) => {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const limited = auth.checkSignInLimits(req, email);
    if (limited) {
      log.warn('Sign-in rate-limited', { ip: req.ip });
      return sendPage(res, signInPage({ error: limited, email }), 429);
    }
    try {
      const { accountId, created, warnings } = await accounts.signIn(email, password);
      const flash = created
        ? { type: 'ok', text: 'Welcome! Your account as it is now is saved as your "Original" profile, with a permanent backup.', details: warnings }
        : warnings.length ? { type: 'ok', text: 'Signed in.', details: warnings } : null;
      auth.startSession(req, res, accountId, email, flash);
      return res.redirect(303, '/configure');
    } catch (err) {
      if (!err.userMessage) log.error('Sign-in failed', { error: err.message });
      return sendPage(res, signInPage({ error: userMessageOf(err), email }), err.kind === 'auth' ? 401 : 400);
    }
  });

  // Stremio-facing routes, guarded by each account's add-on token rather than a session.
  app.use(createAddonRouter({ config, accounts, log }));

  const r = express.Router();
  r.use(auth.require, auth.csrf, (req, res, next) => {
    req.service = accounts.forAccount(req.session.accountId);
    next();
  });

  r.post('/logout', (req, res) => {
    auth.logout(req, res);
    res.redirect(303, '/signin');
  });

  const page = (req, extra = {}) => ({ csrf: req.session.csrf, account: req.service.status().account, flash: auth.takeFlash(req), ...extra });
  const notFound = (res, message) => sendPage(res, errorPage({ status: 404, message }), 404);

  // ── Profiles tab ───────────────────────────────────────────────────────────

  r.get('/configure', (req, res) => {
    const status = req.service.status();
    return sendPage(res, profilesPage({ ...page(req), status, addon: req.service.addonInfo(), undo: req.service.latestUndo() }));
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
      if (b.addons_shown !== '1') {
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
    if (!req.service.repo.getProfile(id)) return notFound(res, 'That profile no longer exists.');
    const status = req.service.status();
    return sendPage(res, profilesPage({
      ...page(req), status, addon: req.service.addonInfo(), undo: req.service.latestUndo(), editing: req.service.profileDetails(id),
    }));
  });

  r.post('/profiles/:id/switch', action(async (req) => {
    const result = await req.service.switchTo(idParam(req));
    if (result.alreadyActive) return { text: `"${result.profile.name}" is already in use.` };
    return {
      text: `Switched to "${result.profile.name}". Click back into Stremio and it refreshes (Stremio 5). Other apps: close and reopen them.`,
      details: result.warnings,
    };
  }));

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

  r.post('/profiles/:id/delete', action(async (req) => {
    await req.service.deleteProfile(idParam(req));
    return { text: `Profile deleted. It's in the bin on the Backups tab for ${BIN_DAYS} days.`, redirect: '/configure' };
  }, (req) => `/profiles/${idParam(req)}#danger`));

  // ── add-on manager and Cinemeta ─────────────────────────────────────────────

  r.get('/profiles/:id/addons', async (req, res) => {
    const id = idParam(req);
    if (!req.service.repo.getProfile(id)) return notFound(res, 'That profile no longer exists.');
    try {
      const manager = await req.service.addonManager(id);
      return sendPage(res, addonManagerPage({ ...page(req), manager, undo: req.service.latestUndo() }));
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

  r.post('/profiles/:id/cinemeta/reset', action(async (req) => {
    const result = await req.service.resetCinemeta(idParam(req), { base: String(req.body.base || '') });
    return editResult(result, 'Cinemeta');
  }, (req) => `/profiles/${idParam(req)}/addons#cinemeta-panel`));

  r.post('/profiles/:id/addons/health', json((req) => req.service.checkAddonHealth(idParam(req))));

  // Fetch an add-on by its link; the page gets the row to show, already rendered.
  r.post('/addons/lookup', express.json({ limit: '8kb' }), json(async (req) => {
    const found = await req.service.lookupAddon(String(req.body?.url || ''));
    if (found.self) throw new UserError('ADDON_FETCH', 'That is OpenProfiles itself. Every profile has it already.');
    const row = req.body?.for === 'wizard' ? wizardAddonRow(found, { checked: true }) : managerAddonRow(found, { isNew: true });
    return { ref: found.ref, name: found.name, html: String(row) };
  }));

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
    ...page(req), backups: req.service.listBackups(), bin: req.service.listBin(), undo: req.service.latestUndo(),
  })));

  r.post('/backups', action(async (req) => {
    const b = await req.service.createBackup(req.body.label);
    return { text: `Backed up (${b.library_count} titles, ${b.addon_count} add-ons).` };
  }, '/backups'));

  // Step 1 of an import: the page's script uploads the file and gets a summary back.
  r.post('/import/preview', express.text({ type: '*/*', limit: '64mb' }), (req, res) => {
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

  r.get('/backups/:id/restore', (req, res) => {
    const backup = req.service.getBackup(idParam(req));
    if (!backup) return notFound(res, 'That backup no longer exists.');
    const status = req.service.status();
    const active = status.profiles.find((p) => p.id === status.activeProfileId) || null;
    return sendPage(res, restorePreviewPage({ csrf: req.session.csrf, backup, active, locked: Boolean(status.openJournal), account: status.account }));
  });

  r.post('/backups/:id/restore', action(async (req) => {
    const result = await req.service.restoreBackup(idParam(req));
    if (result.profileOnly) return { text: "Put back. Only that profile's saved copy changed; Stremio didn't.", redirect: '/backups' };
    return { text: 'Backup restored. Click back into Stremio and it refreshes (Stremio 5). Other apps: close and reopen them.', details: result.warnings };
  }));

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
  r.post('/import/everything', express.json({ limit: '128mb' }), async (req, res) => {
    try {
      const { file, passphrase, acceptOtherAccount } = req.body || {};
      const result = await req.service.importEverything(file, { passphrase: passphrase || null, acceptOtherAccount: acceptOtherAccount === true });
      auth.setFlash(req, {
        type: 'ok',
        text: `Brought back ${result.profiles} profile${result.profiles === 1 ? '' : 's'} and ${result.backups} backup${result.backups === 1 ? '' : 's'}. Nothing in Stremio changed.`,
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

  r.get('/backups/:id/download', (req, res) => {
    let data;
    try {
      data = req.service.exportBackup(idParam(req));
    } catch (err) {
      return notFound(res, userMessageOf(err));
    }
    const stamp = data.created_at.slice(0, 10);
    res.set('Cache-Control', 'no-store');
    res.attachment(`openprofiles-backup-${stamp}-${idParam(req)}.json`);
    return res.json(data);
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
    ...page(req), sessions: auth.listSessions(req), activity: req.service.repo.listActivity(50),
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
    return sendPage(res, signInPage({ notice: 'Your OpenProfiles account and everything saved for it were deleted. Your Stremio account is as it was.' }));
  });

  // Picture tiles for the page (banners and the picker). SVG via <img>, so nothing in them runs.
  const sendSvg = (res, svg) => res
    .set('Cache-Control', 'private, max-age=86400')
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    .type('image/svg+xml')
    .send(svg);

  r.get('/avatars/profile/:id.svg', (req, res) => {
    const p = req.service.repo.getProfile(idParam(req));
    if (!p) return res.status(404).end();
    return sendSvg(res, avatarTileSvg({ name: p.name, colour: p.avatar_colour, avatar: p.avatar_preset }));
  });

  r.get('/avatars/preview.svg', (req, res) => {
    const { avatar = 'initial', colour = AVATAR_COLOURS[5], name = '' } = req.query;
    if (!isValidAvatar(avatar) || !AVATAR_COLOURS.includes(colour)) return res.status(400).end();
    return sendSvg(res, avatarTileSvg({ name: String(name).slice(0, 40), colour, avatar, size: 128 }));
  });

  app.use(r);

  app.use((req, res) => sendPage(res, errorPage({ status: 404, message: "There's nothing here." }), 404));
  // Four parameters is how Express recognises an error handler.
  app.use((err, req, res, _next) => {
    log.error('Request failed', { path: req.path, error: err.message, stack: err.stack });
    const status = err.status && err.status < 500 ? err.status : 500;
    sendPage(res, errorPage({ status, message: status === 500 ? 'The server log has details.' : 'That request was not valid.' }), status);
  });

  return app;
}
