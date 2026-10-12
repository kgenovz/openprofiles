const EMAIL = 'kyle@example.com';
const STREMIO_PASSWORD = 'hunter22';

/** Minimal cookie-keeping client for the test server. */
export class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
  }

  async request(path, { method = 'GET', form } = {}) {
    const res = await fetch(this.base + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(';');
      const i = pair.indexOf('=');
      this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, text: await res.text() };
  }

  get cookie() {
    return [...this.jar].filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async csrf() {
    const page = await this.request('/configure');
    return page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  }

  /** `fields` is an object, or an array of [name, value] pairs when a name repeats. */
  async post(path, fields = {}) {
    const csrf = await this.csrf();
    const form = Array.isArray(fields) ? [['_csrf', csrf], ...fields] : { _csrf: csrf, ...fields };
    return this.request(path, { method: 'POST', form });
  }

  /** JSON POST the way the page scripts send it (CSRF token in a header). */
  async postJson(path, body) {
    const res = await fetch(this.base + path, {
      method: 'POST',
      headers: { cookie: this.cookie, 'content-type': 'application/json', 'x-csrf-token': await this.csrf() },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  async signIn(password = STREMIO_PASSWORD) {
    return this.request('/signin', { method: 'POST', form: { email: EMAIL, password } });
  }
}
