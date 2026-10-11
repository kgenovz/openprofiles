import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAddonRouter } from '../addon/routes.js';
import { avatarTileSvg } from '../addon/art.js';
import { isValidAvatar } from '../addon/avatars.js';
import { AVATAR_COLOURS, userMessageOf } from '../core/service.js';
import { createAuth } from './auth.js';
import { dashboardPage, errorPage, restorePreviewPage, signInPage } from './views.js';

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

  /** Run a POST action, store the outcome as a flash message, go back to the page. */
  const action = (fn) => async (req, res) => {
    try {
      const flash = await fn(req);
      if (flash) auth.setFlash(req, { type: 'ok', ...flash });
    } catch (err) {
      if (!err.userMessage) log.error('Unexpected error', { path: req.path, error: err.message, stack: err.stack });
      auth.setFlash(req, { type: 'error', text: userMessageOf(err) });
    }
    res.redirect(303, '/configure');
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

  r.get('/configure', (req, res) => {
    const flash = auth.takeFlash(req);
    const status = req.service.status();
    return sendPage(res, dashboardPage({
      csrf: req.session.csrf,
      flash,
      status,
      backups: req.service.listBackups(),
      bin: req.service.listBin(),
      activity: req.service.repo.listActivity(15),
      addon: req.service.addonInfo(),
      sessions: auth.listSessions(req),
    }));
  });

  // Before the :id route, which would otherwise match "others".
  r.post('/account/sessions/others/signout', action(async (req) => {
    auth.signOutOthers(req);
    return { text: 'Signed out everywhere else.' };
  }));

  r.post('/account/sessions/:id/signout', action(async (req) => {
    auth.signOutSession(req, req.params.id);
    return { text: 'Signed out there.' };
  }));

  r.post('/account/delete', async (req, res) => {
    if (String(req.body.confirm || '').trim().toLowerCase() !== 'delete') {
      auth.setFlash(req, { type: 'error', text: 'Type DELETE to confirm deleting your OpenProfiles account.' });
      return res.redirect(303, '/configure#account');
    }
    await accounts.deleteAccount(req.session.accountId);
    auth.logout(req, res);
    return sendPage(res, signInPage({ notice: 'Your OpenProfiles account and everything saved for it were deleted. Your Stremio account is as it was.' }));
  });

  r.post('/addon/rotate', action(async (req) => {
    const info = await req.service.rotateAddonToken();
    return {
      text: info.installed
        ? 'New add-on link made. The copy installed in Stremio was updated; the old link no longer works.'
        : 'New add-on link made. The old link no longer works.',
    };
  }));

  r.post('/profiles', action(async (req) => {
    const p = await req.service.createProfile({ name: req.body.name, from: req.body.from, colour: req.body.colour });
    return { text: `Created "${p.name}".` };
  }));

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
  }));

  r.post('/profiles/:id/rename', action(async (req) => {
    req.service.renameProfile(idParam(req), req.body.name);
    return { text: 'Renamed.' };
  }));

  r.post('/profiles/:id/avatar', action(async (req) => {
    req.service.setAvatar(idParam(req), req.body.colour, req.body.picture);
    return { text: 'Picture saved.' };
  }));

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

  r.post('/profiles/:id/delete', action(async (req) => {
    await req.service.deleteProfile(idParam(req));
    return { text: 'Profile deleted.' };
  }));

  r.post('/recovery/finish', action(async (req) => {
    const { warnings } = await req.service.finishInterrupted();
    return { text: 'Finished.', details: warnings };
  }));

  r.post('/recovery/rollback', action(async (req) => {
    const { warnings } = await req.service.rollbackInterrupted();
    return { text: 'Went back to how things were before.', details: warnings };
  }));

  r.post('/backups', action(async (req) => {
    const b = await req.service.createBackup(req.body.label);
    return { text: `Backed up (${b.library_count} titles, ${b.addon_count} add-ons).` };
  }));

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
    return {
      text: profile
        ? `Imported as the profile "${profile.name}" (and kept as a backup). Switch to it to load it into Stremio.`
        : 'Imported as a backup. Restore it from the Backups list to load it into Stremio.',
    };
  }));

  r.get('/backups/:id/restore', (req, res) => {
    const backup = req.service.getBackup(idParam(req));
    if (!backup) return sendPage(res, errorPage({ status: 404, message: 'That backup no longer exists.' }), 404);
    const status = req.service.status();
    const active = status.profiles.find((p) => p.id === status.activeProfileId) || null;
    return sendPage(res, restorePreviewPage({ csrf: req.session.csrf, backup, active, locked: Boolean(status.openJournal), account: status.account }));
  });

  r.post('/backups/:id/restore', action(async (req) => {
    const { warnings } = await req.service.restoreBackup(idParam(req));
    return { text: 'Backup restored. Click back into Stremio and it refreshes (Stremio 5). Other apps: close and reopen them.', details: warnings };
  }));

  r.post('/bin/:id/restore', action(async (req) => {
    const p = await req.service.restoreFromBin(idParam(req));
    return { text: `Brought "${p.name}" back.` };
  }));

  // Every profile and backup in one file; sealed with a passphrase if one is given.
  r.post('/export', (req, res) => {
    const passphrase = String(req.body.passphrase || '');
    if (passphrase && passphrase.length < 8) {
      auth.setFlash(req, { type: 'error', text: 'Use a passphrase of at least 8 characters, or leave it empty.' });
      return res.redirect(303, '/configure#backups');
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
  }));

  r.get('/backups/:id/download', (req, res) => {
    let data;
    try {
      data = req.service.exportBackup(idParam(req));
    } catch (err) {
      return sendPage(res, errorPage({ status: 404, message: userMessageOf(err) }), 404);
    }
    const stamp = data.created_at.slice(0, 10);
    res.set('Cache-Control', 'no-store');
    res.attachment(`openprofiles-backup-${stamp}-${idParam(req)}.json`);
    return res.json(data);
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
