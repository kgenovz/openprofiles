import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Every add-on link a person types is fetched by the server, so it must not be
// a way to reach the server's own network: no private, loopback or link-local
// addresses (checked on the address actually connected to, so DNS can't swap
// one in after the check), http(s) only, a small size cap and a short timeout.

export const FETCH_TIMEOUT_MS = 5000;
export const FETCH_MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;

export class FetchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [
  ['::', 96], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(net6, prefix, 'ipv6');

/** True for any address an add-on fetch must not connect to. Unparseable counts as private. */
export function isPrivateAddress(address) {
  const ip = String(address).replace(/^\[|\]$/g, '');
  if (net.isIPv4(ip)) return blocked.check(ip, 'ipv4');
  if (!net.isIPv6(ip)) return true;
  // IPv4-mapped (::ffff:a.b.c.d, in either spelling) is judged as the IPv4 address it carries.
  const normal = new URL(`http://[${ip}]`).hostname.slice(1, -1).toLowerCase();
  const mapped = normal.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return blocked.check(normal, 'ipv6');
}

/** Parse and vet a URL before any connection. */
export function checkUrl(raw, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new FetchError('BAD_URL', "That isn't a web address.");
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new FetchError('BAD_URL', 'Add-on links start with https://.');
  if (url.username || url.password) throw new FetchError('BAD_URL', "Add-on links can't contain a user name or password.");
  if (!allowPrivate) {
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new FetchError('BLOCKED', 'That link points at a private network, which OpenProfiles does not fetch from.');
    }
    if ((net.isIP(host.replace(/^\[|\]$/g, '')) || host.startsWith('[')) && isPrivateAddress(host)) {
      throw new FetchError('BLOCKED', 'That link points at a private network, which OpenProfiles does not fetch from.');
    }
  }
  return url;
}

function guardedLookup(allowPrivate) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const usable = allowPrivate ? addresses : addresses.filter((a) => !isPrivateAddress(a.address));
      if (usable.length === 0) {
        return callback(new FetchError('BLOCKED', 'That link points at a private network, which OpenProfiles does not fetch from.'));
      }
      if (options.all) return callback(null, usable);
      return callback(null, usable[0].address, usable[0].family);
    });
  };
}

function getOnce(url, { signal, maxBytes, allowPrivate }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      signal,
      lookup: guardedLookup(allowPrivate),
      headers: { accept: 'application/json', 'user-agent': 'OpenProfiles (+https://github.com/kgenovz/openprofiles)' },
    }, (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ status, location: res.headers.location });
      }
      const declared = Number(res.headers['content-length']);
      if (declared > maxBytes) {
        res.destroy();
        return reject(new FetchError('TOO_BIG', 'That add-on sent far more than a manifest.'));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          reject(new FetchError('TOO_BIG', 'That add-on sent far more than a manifest.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
      return undefined;
    });
    req.on('error', reject);
  });
}

/**
 * GET a JSON document through the guard. Redirects are followed (3 at most),
 * each one vetted like the first link. Throws FetchError with a message meant
 * for the person who typed the link.
 */
export async function fetchJson(raw, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = FETCH_MAX_BYTES, allowPrivate = false } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = checkUrl(raw, { allowPrivate });
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await getOnce(url, { signal, maxBytes, allowPrivate });
    } catch (err) {
      if (err instanceof FetchError) throw err;
      if (signal.aborted) throw new FetchError('TIMEOUT', `The add-on didn't answer within ${timeoutMs / 1000} seconds.`);
      throw new FetchError('UNREACHABLE', "Couldn't reach that add-on.");
    }
    if (res.location) {
      if (hop >= MAX_REDIRECTS) throw new FetchError('UNREACHABLE', 'That link redirects too many times.');
      url = checkUrl(new URL(res.location, url), { allowPrivate });
      continue;
    }
    if (res.status !== 200) throw new FetchError('UNREACHABLE', `The add-on answered with an error (${res.status}).`);
    try {
      return JSON.parse(res.body);
    } catch {
      throw new FetchError('NOT_JSON', "That link doesn't lead to an add-on manifest.");
    }
  }
}

/** Accept the forms people paste: stremio:// links, and nothing that isn't a manifest. */
export function normaliseAddonUrl(raw) {
  let text = String(raw ?? '').trim();
  if (/^stremio:\/\//i.test(text)) text = `https://${text.slice('stremio://'.length)}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new FetchError('BAD_URL', 'Paste the add-on\'s link: it ends in /manifest.json.');
  }
  if (!url.pathname.endsWith('/manifest.json')) {
    throw new FetchError('BAD_URL', 'That link should end in /manifest.json. In the add-on\'s setup page, copy its install link.');
  }
  return url.toString();
}

/** A manifest Stremio would accept, or a FetchError. */
export function checkManifest(m) {
  const ok = m && typeof m === 'object' && !Array.isArray(m)
    && typeof m.id === 'string' && m.id && typeof m.name === 'string' && typeof m.version === 'string'
    && Array.isArray(m.resources) && Array.isArray(m.types)
    && (m.catalogs === undefined || Array.isArray(m.catalogs));
  if (!ok) throw new FetchError('NOT_MANIFEST', "That link doesn't lead to an add-on manifest.");
  return m;
}

/** Fetch an add-on's manifest through the guard. */
export async function fetchManifest(raw, opts = {}) {
  return checkManifest(await fetchJson(normaliseAddonUrl(raw), opts));
}
