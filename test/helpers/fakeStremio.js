/**
 * In-memory stand-in for api.strem.io, plugged into StremioClient as its
 * fetch. Mirrors the behaviour the switch logic depends on: upsert-by-_id
 * datastore writes, RFC 3339 `_mtime` validation, notifItem refusing
 * `all: true`, and full-replace add-on collections.
 */
export class FakeStremio {
  constructor({ userId = 'user-1', email = 'kyle@example.com', password = 'hunter22', authKey = 'k'.repeat(40) } = {}) {
    this.user = { _id: userId, email };
    this.password = password;
    this.authKey = authKey;
    this.library = new Map();
    this.notifs = new Map();
    this.addons = [];
    this.calls = [];
    this.rules = [];
    this.fetch = this.fetch.bind(this);
  }

  // ── seeding & inspection ─────────────────────────────────────────────────

  seed({ library = [], notifs = [], addons }) {
    for (const it of library) this.library.set(it._id, structuredClone(it));
    for (const it of notifs) this.notifs.set(it._id, structuredClone(it));
    if (addons) this.addons = structuredClone(addons);
    return this;
  }

  activeIds() {
    return [...this.library.values()].filter((it) => it.removed !== true).map((it) => it._id).sort();
  }

  callCount(method, collection) {
    return this.calls.filter((c) => c.method === method && (!collection || c.body.collection === collection)).length;
  }

  /**
   * Make matching calls misbehave. `when(method, body, n)` sees the call's
   * 1-based index among calls to that method. `respond` is
   * `{ status, headers }`, `{ error: {...} }`, or `{ network: true }`.
   */
  failWhen(when, respond, { times = Infinity } = {}) {
    this.rules.push({ when, respond, times });
    return this;
  }

  // ── fetch ────────────────────────────────────────────────────────────────

  async fetch(url, init) {
    const method = new URL(url).pathname.replace(/^\/api\//, '');
    const body = JSON.parse(init.body);
    this.calls.push({ method, body });
    const n = this.calls.filter((c) => c.method === method).length;

    for (const rule of this.rules) {
      if (rule.times > 0 && rule.when(method, body, n)) {
        rule.times--;
        if (rule.respond.network) throw new TypeError('fetch failed');
        if (rule.respond.status) return new Response('{"oops":"server echoed secrets here"}', { status: rule.respond.status, headers: rule.respond.headers });
        return json({ error: rule.respond.error });
      }
    }

    const handler = this[`api_${method}`];
    if (!handler) return json({ error: { code: 404, message: 'unknown method' } });
    if (method !== 'login' && body.authKey !== this.authKey) {
      return json({ error: { code: 1, message: 'Session does not exist' } });
    }
    return handler.call(this, body);
  }

  api_login(body) {
    if (body.email !== this.user.email || body.password !== this.password) {
      return json({ error: { code: 3, message: `wrong password for ${body.email}` } });
    }
    return json({ result: { authKey: this.authKey, user: this.user } });
  }

  api_getUser() {
    return json({ result: { ...this.user } });
  }

  api_datastoreGet(body) {
    const store = this.store(body.collection);
    if (body.all) {
      if (body.collection === 'notifItem') return json({ error: { code: 5994, message: 'Cannot get all for this collection' } });
      return json({ result: [...store.values()].map((it) => structuredClone(it)) });
    }
    return json({ result: (body.ids || []).filter((id) => store.has(id)).map((id) => structuredClone(store.get(id))) });
  }

  api_datastoreMeta(body) {
    return json({ result: [...this.store(body.collection).values()].map((it) => [it._id, it._mtime]) });
  }

  api_datastorePut(body) {
    const store = this.store(body.collection);
    for (const item of body.changes) {
      if (typeof item._id !== 'string') return json({ error: { code: 2, message: 'JSON unmarshal err' } }, 400);
      if (body.collection === 'libraryItem') {
        if (typeof item._mtime !== 'string' || Number.isNaN(Date.parse(item._mtime))) {
          return json({ error: { code: 2, message: 'JSON unmarshal err' } }, 400);
        }
        if (!item.state || typeof item.type !== 'string') {
          return json({ error: { code: 2, message: 'JSON unmarshal err' } }, 400);
        }
      }
    }
    for (const item of body.changes) store.set(item._id, structuredClone(item));
    return json({ result: { success: true } });
  }

  api_addonCollectionGet() {
    return json({ result: { addons: structuredClone(this.addons), lastModified: Date.now() } });
  }

  api_addonCollectionSet(body) {
    this.addons = structuredClone(body.addons);
    return json({ result: { success: true } });
  }

  store(collection) {
    if (collection === 'libraryItem') return this.library;
    if (collection === 'notifItem') return this.notifs;
    throw new Error(`fake has no collection ${collection}`);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// ── fixtures ───────────────────────────────────────────────────────────────

export function libItem(id, { removed = false, temp = false, lastWatched = '', timeOffset = 0, mtime = '2026-01-01T00:00:00.000Z', name } = {}) {
  return {
    _id: id,
    name: name || id,
    type: 'series',
    poster: `https://img.example/${id}.jpg`,
    removed,
    temp,
    _ctime: '2025-01-01T00:00:00.000Z',
    _mtime: mtime,
    state: {
      lastWatched,
      timeWatched: timeOffset,
      timeOffset,
      overallTimeWatched: timeOffset,
      timesWatched: 0,
      flaggedWatched: 0,
      duration: 3_600_000,
      video_id: timeOffset ? `${id}:1:2` : '',
      watched: '',
      noNotif: false,
      season: timeOffset ? 1 : 0,
      episode: timeOffset ? 2 : 0,
    },
    behaviorHints: { defaultVideoId: null },
  };
}

export function notif(id, extra = {}) {
  return { _id: id, _mtime: '2026-01-01T00:00:00.000Z', metaId: id.split(' ')[0], videoId: id, videoReleased: '2026-01-01T00:00:00.000Z', dismissed: false, seen: false, delivered: true, ...extra };
}

export function addon(id, transportUrl = `https://${id}.example/manifest.json`) {
  return { transportUrl, transportName: '', manifest: { id, name: id, version: '1.0.0', resources: [], types: [], catalogs: [] }, flags: {} };
}
