import { randomToken, safeEqual, sha256 } from '../crypto.js';

const COOKIE = 'op_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Single-admin auth for the web page: ADMIN_PASSWORD, a session cookie
 * (HttpOnly, SameSite=Strict), a per-session CSRF token on every POST and a
 * per-IP login rate limit.
 */
export function createAuth({ db, config, now = () => Date.now() }) {
  const secureCookie = config.publicUrl.startsWith('https://');
  const attempts = new Map(); // ip -> { count, resetAt }

  const q = {
    insert: db.prepare('INSERT INTO sessions (id_hash, csrf, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    get: db.prepare('SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?'),
    remove: db.prepare('DELETE FROM sessions WHERE id_hash = ?'),
    expire: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    setFlash: db.prepare('UPDATE sessions SET flash = ? WHERE id_hash = ?'),
  };

  function cookie(value, maxAgeMs) {
    return [
      `${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
      ...(secureCookie ? ['Secure'] : []),
    ].join('; ');
  }

  function loadSession(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const row = q.get.get(sha256(token), now());
    return row ? { idHash: row.id_hash, csrf: row.csrf, flash: row.flash } : null;
  }

  function rateLimited(ip) {
    const t = now();
    const entry = attempts.get(ip);
    if (!entry || entry.resetAt <= t) {
      attempts.set(ip, { count: 1, resetAt: t + LOGIN_WINDOW_MS });
      return false;
    }
    entry.count++;
    return entry.count > LOGIN_MAX_ATTEMPTS;
  }

  return {
    /** Returns 'ok' | 'wrong' | 'limited'. Sets the cookie on success. */
    login(req, res, password) {
      if (rateLimited(req.ip)) return 'limited';
      if (!safeEqual(password || '', config.adminPassword)) return 'wrong';
      attempts.delete(req.ip);
      q.expire.run(now());
      const token = randomToken(32);
      q.insert.run(sha256(token), randomToken(24), now(), now() + SESSION_TTL_MS);
      res.setHeader('Set-Cookie', cookie(token, SESSION_TTL_MS));
      return 'ok';
    },

    logout(req, res) {
      if (req.session) q.remove.run(req.session.idHash);
      res.setHeader('Set-Cookie', cookie('', 0));
    },

    /** Gate: unauthenticated GETs go to the login page, other methods get 401. */
    require(req, res, next) {
      req.session = loadSession(req);
      if (req.session) return next();
      if (req.method === 'GET') return res.redirect(303, '/login');
      return res.status(401).send('Sign in first.');
    },

    csrf(req, res, next) {
      if (req.method !== 'POST') return next();
      const sent = req.body?._csrf;
      if (typeof sent === 'string' && safeEqual(sent, req.session.csrf)) return next();
      return res.status(403).send('This form expired. Go back, reload the page and try again.');
    },

    setFlash(req, flash) {
      q.setFlash.run(JSON.stringify(flash), req.session.idHash);
    },

    takeFlash(req) {
      if (!req.session?.flash) return null;
      q.setFlash.run(null, req.session.idHash);
      return JSON.parse(req.session.flash);
    },
  };
}
