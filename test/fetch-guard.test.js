import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { checkUrl, fetchJson, isPrivateAddress, normaliseAddonUrl } from '../src/core/fetchGuard.js';

describe('fetch guard: addresses', () => {
  it('blocks private, loopback, link-local and mapped addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', 'not-an-ip']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });

  it('refuses links that are not plain web links to public hosts', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/manifest.json', 'http://localhost/manifest.json',
      'http://box.local/manifest.json', 'http://127.0.0.1:11470/manifest.json', 'http://[::1]/manifest.json',
      'https://user:pass@example.com/manifest.json', 'http://169.254.169.254/latest/meta-data']) {
      assert.throws(() => checkUrl(url), (e) => ['BAD_URL', 'BLOCKED'].includes(e.code), url);
    }
    assert.equal(checkUrl('https://v3-cinemeta.strem.io/manifest.json').hostname, 'v3-cinemeta.strem.io');
  });

  it('turns pasted stremio:// links into https and wants a manifest', () => {
    assert.equal(normaliseAddonUrl('stremio://addon.example/abc/manifest.json'), 'https://addon.example/abc/manifest.json');
    assert.throws(() => normaliseAddonUrl('https://addon.example/configure'), /manifest\.json/);
  });
});

describe('fetch guard: fetching', () => {
  let server;
  let base;
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') return res.end(JSON.stringify({ hello: 'world' }));
      if (req.url === '/big') return res.end(`"${'x'.repeat(600 * 1024)}"`);
      if (req.url === '/slow') return setTimeout(() => res.end('{}'), 1000);
      if (req.url === '/hop') return res.writeHead(302, { location: '/ok' }).end();
      return res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  // The test server is on 127.0.0.1, so these opt in to private addresses.
  const open = { allowPrivate: true };

  it('fetches JSON and follows redirects', async () => {
    assert.deepEqual(await fetchJson(`${base}/ok`, open), { hello: 'world' });
    assert.deepEqual(await fetchJson(`${base}/hop`, open), { hello: 'world' });
  });

  it('stops at 512 KB and after the timeout', async () => {
    await assert.rejects(fetchJson(`${base}/big`, open), (e) => e.code === 'TOO_BIG');
    await assert.rejects(fetchJson(`${base}/slow`, { ...open, timeoutMs: 150 }), (e) => e.code === 'TIMEOUT');
  });

  it('refuses the server itself without the opt-in', async () => {
    await assert.rejects(fetchJson(`${base}/ok`), (e) => e.code === 'BLOCKED');
  });

  it('checks the address a name resolves to, not only the name', async () => {
    // "localhost." (trailing dot) gets past the name check and resolves to loopback.
    await assert.rejects(fetchJson(`http://localhost.:${server.address().port}/ok`), (e) => e.code === 'BLOCKED');
  });
});
