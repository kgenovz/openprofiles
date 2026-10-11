import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { userMessageOf } from '../core/service.js';
import { createAuth } from './auth.js';
import { dashboardPage, errorPage, loginPage, restorePreviewPage, setupPage } from './views.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');

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

export function createApp({ config, db, service, log }) {
  const app = express();
  const auth = createAuth({ db, config });
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use('/static', express.static(STATIC_DIR, { maxAge: '1h', index: false }));
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
  app.get('/', (req, res) => res.redirect(303, '/configure'));

  app.get('/login', (req, res) => sendPage(res, loginPage({})));
  app.post('/login', (req, res) => {
    const outcome = auth.login(req, res, req.body?.password);
    if (outcome === 'ok') return res.redirect(303, '/configure');
    const error = outcome === 'limited' ? 'Too many attempts. Wait 15 minutes and try again.' : 'Wrong password.';
    if (outcome === 'limited') log.warn('Admin login rate-limited', { ip: req.ip });
    return sendPage(res, loginPage({ error }), outcome === 'limited' ? 429 : 401);
  });

  const r = express.Router();
  r.use(auth.require, auth.csrf);

  r.post('/logout', (req, res) => {
    auth.logout(req, res);
    res.redirect(303, '/login');
  });

  r.get('/configure', (req, res) => {
    const flash = auth.takeFlash(req);
    const status = service.status();
    const { csrf } = req.session;
    if (!status.linked) return sendPage(res, setupPage({ csrf, flash }));
    return sendPage(res, dashboardPage({
      csrf, flash, status, backups: service.listBackups(), journal: service.recentActivity(10),
    }));
  });

  r.post('/account/link', action(async (req) => {
    const { created, warnings } = await service.linkAccount(String(req.body.email || '').trim(), String(req.body.password || ''));
    return {
      text: created ? 'Connected. Your account is saved as the "Original" profile.' : 'Signed in to Stremio again.',
      details: warnings,
    };
  }));

  r.post('/profiles', action(async (req) => {
    const p = await service.createProfile({ name: req.body.name, from: req.body.from, colour: req.body.colour });
    return { text: `Created "${p.name}".` };
  }));

  r.post('/profiles/:id/switch', action(async (req) => {
    const result = await service.switchTo(idParam(req));
    if (result.alreadyActive) return { text: `"${result.profile.name}" is already in use.` };
    return {
      text: `Switched to "${result.profile.name}". Close and reopen Stremio on each device to see it.`,
      details: result.warnings,
    };
  }));

  r.post('/profiles/:id/save', action(async () => {
    const { profile, notifsSaved } = await service.saveNow();
    return {
      text: `Saved "${profile.name}".`,
      details: notifsSaved ? [] : ["Stremio didn't return notifications, so the previously saved ones were kept."],
    };
  }));

  r.post('/profiles/:id/rename', action(async (req) => {
    service.renameProfile(idParam(req), req.body.name);
    return { text: 'Renamed.' };
  }));

  r.post('/profiles/:id/avatar', action(async (req) => {
    service.setAvatar(idParam(req), req.body.colour);
    return { text: 'Colour saved.' };
  }));

  r.post('/profiles/:id/delete', action(async (req) => {
    await service.deleteProfile(idParam(req));
    return { text: 'Profile deleted.' };
  }));

  r.post('/recovery/finish', action(async () => {
    const { warnings } = await service.finishInterrupted();
    return { text: 'Finished.', details: warnings };
  }));

  r.post('/recovery/rollback', action(async () => {
    const { warnings } = await service.rollbackInterrupted();
    return { text: 'Went back to how things were before.', details: warnings };
  }));

  r.post('/backups', action(async (req) => {
    const b = await service.createBackup(req.body.label);
    return { text: `Backed up (${b.library_count} titles, ${b.addon_count} add-ons).` };
  }));

  r.get('/backups/:id/restore', (req, res) => {
    const backup = service.getBackup(idParam(req));
    if (!backup) return sendPage(res, errorPage({ status: 404, message: 'That backup no longer exists.' }), 404);
    const status = service.status();
    const active = status.profiles.find((p) => p.id === status.activeProfileId) || null;
    return sendPage(res, restorePreviewPage({ csrf: req.session.csrf, backup, active, locked: Boolean(status.openJournal) }));
  });

  r.post('/backups/:id/restore', action(async (req) => {
    const { warnings } = await service.restoreBackup(idParam(req));
    return { text: 'Backup restored. Close and reopen Stremio on each device to see it.', details: warnings };
  }));

  r.post('/backups/:id/delete', action(async (req) => {
    await service.deleteBackup(idParam(req));
    return { text: 'Backup deleted.' };
  }));

  r.get('/backups/:id/download', (req, res) => {
    let data;
    try {
      data = service.exportBackup(idParam(req));
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
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error('Request failed', { path: req.path, error: err.message, stack: err.stack });
    const status = err.status && err.status < 500 ? err.status : 500;
    sendPage(res, errorPage({ status, message: status === 500 ? 'The server log has details.' : 'That request was not valid.' }), status);
  });

  return app;
}
