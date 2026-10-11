import { StremioError, MESSAGES } from './errors.js';

const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const MAX_BACKOFF_MS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const NOTIF_ID_CHUNK = 500;
// Stremio's "session does not exist" error code for a dead authKey.
const AUTH_ERROR_CODE = 1;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_BACKOFF_MS);
  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_BACKOFF_MS);
  return null;
}

/**
 * Thin client for https://api.strem.io. Every method we call is idempotent
 * (reads, or upserts keyed by `_id`), so transient failures are retried.
 */
export class StremioClient {
  constructor({ baseUrl = 'https://api.strem.io', fetchImpl = globalThis.fetch, sleep = realSleep, log, maxAttempts = 4, timeoutMs = 20000, userAgent = 'OpenProfiles' } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.log = log;
    this.maxAttempts = maxAttempts;
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
  }

  async call(method, body) {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await this.fetch(`${this.baseUrl}/api/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': this.userAgent },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        if (attempt < this.maxAttempts) {
          await this.backoff(method, attempt, 'network error', null);
          continue;
        }
        throw new StremioError('unreachable', MESSAGES.unreachable, { method });
      }

      if (res.status >= 400) {
        // Drain without reading into anything we might log.
        await res.body?.cancel().catch(() => {});
        if (RETRIABLE_STATUS.has(res.status) && attempt < this.maxAttempts) {
          await this.backoff(method, attempt, `HTTP ${res.status}`, parseRetryAfter(res.headers.get('retry-after')));
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          throw new StremioError('busy', MESSAGES.busy, { method, status: res.status });
        }
        throw new StremioError('api', `Stremio rejected the request (${method}).`, { method, status: res.status });
      }

      const declared = Number(res.headers.get('content-length'));
      if (declared > MAX_RESPONSE_BYTES) {
        await res.body?.cancel().catch(() => {});
        throw new StremioError('bad_response', MESSAGES.badResponse, { method });
      }
      let data;
      try {
        const text = await res.text();
        if (text.length > MAX_RESPONSE_BYTES) throw new Error('too large');
        data = JSON.parse(text);
      } catch {
        throw new StremioError('bad_response', MESSAGES.badResponse, { method });
      }

      if (data && data.error) {
        const code = typeof data.error === 'object' ? data.error.code : undefined;
        if (method === 'login') throw new StremioError('auth', MESSAGES.badLogin, { method, code });
        const msg = typeof data.error === 'object' ? String(data.error.message || '') : String(data.error);
        if (code === AUTH_ERROR_CODE || /session/i.test(msg)) {
          throw new StremioError('auth', MESSAGES.auth, { method, code });
        }
        throw new StremioError('api', `Stremio rejected the request (${method}).`, { method, code });
      }
      return data ? data.result : undefined;
    }
  }

  async backoff(method, attempt, reason, retryAfterMs) {
    const ms = retryAfterMs ?? Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
    this.log?.warn(`Stremio ${method}: ${reason}, retry ${attempt}/${this.maxAttempts - 1} in ${ms}ms`);
    await this.sleep(ms);
  }

  async login(email, password) {
    const result = await this.call('login', { email, password, type: 'Login', facebook: false });
    if (!result || typeof result.authKey !== 'string' || !result.authKey) {
      throw new StremioError('bad_response', MESSAGES.badResponse, { method: 'login' });
    }
    return result.authKey;
  }

  async getUser(authKey) {
    const result = await this.call('getUser', { type: 'GetUser', authKey });
    if (!result || !result._id) throw new StremioError('bad_response', MESSAGES.badResponse, { method: 'getUser' });
    return {
      id: result._id,
      email: result.email || '',
      parentId: result.parent_id || null,
      userProfiles: result.premiumPrefs?.userProfiles || null,
    };
  }

  /** Every libraryItem row, including tombstones (`removed: true`). */
  async getLibrary(authKey) {
    const result = await this.call('datastoreGet', { authKey, collection: 'libraryItem', all: true });
    if (!Array.isArray(result)) throw new StremioError('bad_response', MESSAGES.badResponse, { method: 'datastoreGet' });
    return result;
  }

  async putLibrary(authKey, changes) {
    await this.call('datastorePut', { authKey, collection: 'libraryItem', changes });
  }

  /** notifItem can't be read with `all: true` (error 5994): list ids, then fetch them. */
  async getNotifs(authKey) {
    const meta = await this.call('datastoreMeta', { authKey, collection: 'notifItem' });
    if (!Array.isArray(meta)) throw new StremioError('bad_response', MESSAGES.badResponse, { method: 'datastoreMeta' });
    const ids = meta.map((entry) => (Array.isArray(entry) ? entry[0] : entry)).filter((id) => typeof id === 'string' && id);
    const items = [];
    for (let i = 0; i < ids.length; i += NOTIF_ID_CHUNK) {
      const result = await this.call('datastoreGet', { authKey, collection: 'notifItem', ids: ids.slice(i, i + NOTIF_ID_CHUNK) });
      if (!Array.isArray(result)) throw new StremioError('bad_response', MESSAGES.badResponse, { method: 'datastoreGet' });
      items.push(...result);
    }
    return items;
  }

  async putNotifs(authKey, changes) {
    await this.call('datastorePut', { authKey, collection: 'notifItem', changes });
  }

  async getAddons(authKey) {
    const result = await this.call('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true });
    if (!result || !Array.isArray(result.addons)) {
      throw new StremioError('bad_response', MESSAGES.badResponse, { method: 'addonCollectionGet' });
    }
    return result.addons;
  }

  /** Full replace; array order is display order. */
  async setAddons(authKey, addons) {
    await this.call('addonCollectionSet', { type: 'AddonCollectionSet', authKey, addons });
  }
}
