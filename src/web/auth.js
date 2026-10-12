import { randomToken, safeEqual, sha256 } from '../crypto.js';

const COOKIE = 'op_session';
const UNDO_HIDDEN_COOKIE = 'op_undo_hidden';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 5 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_PER_IP = 10;
const MAX_ATTEMPTS_PER_EMAIL = 5;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    // Other apps on the same host can leave cookies we can't decode; skip them.
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // not ours
    }
  }
  return out;
}

const LIMITER_MAX_KEYS = 10000;
const MAX_EMAIL_LENGTH = 254;

/**
 * Counts attempts per key in a window; `hit` returns true once the key is over
 * its limit. Expired keys are swept, and the map has a ceiling, so a flood of
 * distinct keys can't grow memory without bound.
 */
function limiter(max, now) {
  const seen = new Map();
  let nextSweep = 0;
  return {
    hit(key) {
      const t = now();
      if (t >= nextSweep) {
        for (const [k, e] of seen) if (e.resetAt <= t) seen.delete(k);
        nextSweep = t + 60 * 1000;
      }
      const entry = seen.get(key);
      if (!entry || entry.resetAt <= t) {
        while (seen.size >= LIMITER_MAX_KEYS) seen.delete(seen.keys().next().value);
        seen.set(key, { count: 1, resetAt: t + LOGIN_WINDOW_MS });
        return false;
      }
      entry.count++;
      return entry.count > max;
    },
    clear(key) {
      seen.delete(key);
    },
  };
}

/** IPv6 clients usually hold a whole /64, so they are counted per /64. */
function ipKey(ip = '') {
  if (!ip.includes(':') || ip.startsWith('::ffff:')) return ip;
  const [head] = ip.split('::');
  const groups = ip.includes('::') ? head.split(':').filter(Boolean) : ip.split(':');
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/**
 * Sessions for people signed in with their Stremio account: a cookie
 * (HttpOnly, SameSite=Strict) mapped to an account, a per-session CSRF token
 * on every POST, sign-in rate limits per IP and per email, and a list of
 * where each account is signed in.
 */
export function createAuth({ db, config, now = () => Date.now() }) {
  const secureCookie = config.publicUrl.startsWith('https://');
  const byIp = limiter(MAX_ATTEMPTS_PER_IP, now);
  const byEmail = limiter(MAX_ATTEMPTS_PER_EMAIL, now);

  const q = {
    insert: db.prepare(`INSERT INTO sessions (id_hash, account_id, csrf, user_agent, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    get: db.prepare('SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?'),
    touch: db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?'),
    remove: db.prepare('DELETE FROM sessions WHERE id_hash = ?'),
    removeForAccount: db.prepare('DELETE FROM sessions WHERE account_id = ? AND hex(id_hash) = ?'),
    removeOthers: db.prepare('DELETE FROM sessions WHERE account_id = ? AND id_hash != ?'),
    list: db.prepare(`SELECT hex(id_hash) AS id, user_agent, created_at, last_seen_at FROM sessions
      WHERE account_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`),
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
    if (!row) return null;
    // Idle expiry: each visit (at most every few minutes) pushes it out again.
    if (now() - row.last_seen_at > TOUCH_EVERY_MS) q.touch.run(now(), now() + SESSION_TTL_MS, row.id_hash);
    return { idHash: row.id_hash, accountId: row.account_id, csrf: row.csrf, flash: row.flash };
  }

  return {
    /** Checks the rate limits before asking Stremio. Returns an error message, or null to go ahead. */
    checkSignInLimits(req, email) {
      const address = String(email || '').trim().toLowerCase();
      if (address.length > MAX_EMAIL_LENGTH) return "That isn't an email address Stremio would accept.";
      // Over the address limit: refused before the email is even counted.
      if (byIp.hit(ipKey(req.ip))) return 'Too many sign-in attempts. Wait 15 minutes and try again.';
      return byEmail.hit(address) ? 'Too many sign-in attempts. Wait 15 minutes and try again.' : null;
    },

    /** After Stremio accepted the sign-in: start a session for the account and set the cookie. */
    startSession(req, res, accountId, email, flash = null) {
      byEmail.clear(String(email || '').trim().toLowerCase());
      q.expire.run(now());
      const token = randomToken(32);
      const ua = String(req.get('user-agent') || '').slice(0, 300);
      const idHash = sha256(token);
      q.insert.run(idHash, accountId, randomToken(24), ua, now(), now(), now() + SESSION_TTL_MS);
      if (flash) q.setFlash.run(JSON.stringify(flash), idHash);
      res.setHeader('Set-Cookie', cookie(token, SESSION_TTL_MS));
    },

    logout(req, res) {
      if (req.session) q.remove.run(req.session.idHash);
      res.setHeader('Set-Cookie', cookie('', 0));
    },

    /** Where this account is signed in. `current` marks the session making the request. */
    listSessions(req) {
      const current = Buffer.from(req.session.idHash).toString('hex').toUpperCase();
      return q.list.all(req.session.accountId, now()).map((s) => ({ ...s, current: s.id === current }));
    },

    signOutSession(req, id) {
      q.removeForAccount.run(req.session.accountId, String(id).toUpperCase());
    },

    signOutOthers(req) {
      q.removeOthers.run(req.session.accountId, req.session.idHash);
    },

    /** Gate: signed-out GETs go to the sign-in page, other methods get 401. */
    require(req, res, next) {
      req.session = loadSession(req);
      if (req.session) return next();
      if (req.method === 'GET') return res.redirect(303, '/signin');
      return res.status(401).send('Sign in first.');
    },

    /** Like require, but lets signed-out requests through (for the sign-in page itself). */
    optional(req, res, next) {
      req.session = loadSession(req);
      next();
    },

    csrf(req, res, next) {
      if (req.method !== 'POST') return next();
      // Forms send a hidden field; the import upload (fetch) sends a header.
      const sent = req.get('x-csrf-token') ?? req.body?._csrf;
      if (typeof sent === 'string' && safeEqual(sent, req.session.csrf)) return next();
      return res.status(403).send('This form expired. Go back, reload the page and try again.');
    },

    setFlash(req, flash) {
      q.setFlash.run(JSON.stringify(flash), req.session.idHash);
    },

    /** The edit whose Undo bar this browser hid (a later edit shows the bar again). */
    hiddenUndo(req) {
      return Number(parseCookies(req.headers.cookie)[UNDO_HIDDEN_COOKIE]) || null;
    },

    hideUndo(res, backupId) {
      res.append('Set-Cookie', [
        `${UNDO_HIDDEN_COOKIE}=${Number(backupId)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=86400',
        ...(secureCookie ? ['Secure'] : []),
      ].join('; '));
    },

    takeFlash(req) {
      if (!req.session?.flash) return null;
      q.setFlash.run(null, req.session.idHash);
      return JSON.parse(req.session.flash);
    },
  };
}
