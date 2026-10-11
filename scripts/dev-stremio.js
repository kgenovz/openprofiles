// Local stand-in for api.strem.io so the web page can be tried without a real
// account. Run it, then start OpenProfiles with STREMIO_API_URL=http://localhost:7001.
// Sign in with kyle@example.com / hunter22.
import http from 'node:http';
import { FakeStremio, cinemetaAddon, libItem, notif, richAddon } from '../test/helpers/fakeStremio.js';

const port = Number(process.env.FAKE_STREMIO_PORT || 7001);
const fake = new FakeStremio().seed({
  library: [
    libItem('tt0903747', { name: 'Breaking Bad', lastWatched: '2026-10-08T20:00:00.000Z', timeOffset: 1_200_000, temp: true }),
    libItem('tt0108778', { name: 'Friends', lastWatched: '2026-09-20T20:00:00.000Z' }),
    libItem('tt2861424', { name: 'Rick and Morty', lastWatched: '2026-08-01T20:00:00.000Z' }),
  ],
  notifs: [notif('tt2861424 8 1')],
  addons: [
    cinemetaAddon(),
    richAddon('TMDB', { url: 'https://tmdb.example/manifest.json', resources: ['catalog', 'meta'] }),
    richAddon('Torrentio', { url: 'https://debrid.example/KEY/manifest.json', resources: ['stream'], catalogs: [] }),
    richAddon('OpenSubtitles v3', { url: 'https://opensubtitles.example/manifest.json', resources: ['subtitles'], catalogs: [] }),
  ],
});

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const response = await fake.fetch(`http://fake${req.url}`, { method: req.method, body: Buffer.concat(chunks).toString() || '{}' });
  res.writeHead(response.status, { 'content-type': 'application/json' });
  res.end(await response.text());
  console.log(`${req.url} -> ${response.status} (library: ${fake.activeIds().length} active)`);
}).listen(port, () => console.log(`Fake Stremio API on http://localhost:${port}`));
