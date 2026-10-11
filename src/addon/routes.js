import crypto from 'node:crypto';
import express from 'express';
import { safeEqual } from '../crypto.js';
import { userMessageOf } from '../core/service.js';
import { ArtCache, renderBackground, renderLogo, renderPoster } from './art.js';
import {
  CATALOG_ID, CATALOG_TYPE, buildManifest, parseProfileMetaId, profileMetaId,
} from './manifest.js';

// Stremio waits on the stream request while the switch runs. Past this, answer
// "still switching" and let the switch finish in the background.
const SWITCH_WAIT_MS = 25_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Where the refresh redirect sends each device. Found by testing on real apps
 * (2026-10-11):
 *   - Desktop (Stremio 5): any deep link brings the window to the front, and
 *     focus re-syncs library and add-ons (stremio-web App.js), so go Home.
 *   - Android: Home ("/") re-syncs the library but keeps the old add-ons on
 *     Home; Library (or Add-ons) reloads everything once you go back Home.
 *     Intents do nothing, and chained deep links don't fire (the browser only
 *     follows the next one when it's reopened).
 */
export function autoRefreshTarget(userAgent = '') {
  return /Android/i.test(userAgent) ? 'library' : 'home';
}

/** What the browser tab shows for a moment during the hand-off. `target` is one of REDIRECT_TARGETS. */
function handoffPage(target) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>OpenProfiles</title></head>
<body style="margin:0;min-height:100vh;background:#0f0f14;display:grid;place-items:center">
<a href="${target}" style="display:inline-block;padding:14px 28px;border-radius:12px;background:#8b6dff;color:#fff;font:700 17px system-ui,sans-serif;text-decoration:none">Back to Stremio</a>
</body></html>`;
}

// Only these targets, so /refresh/go can't be pointed anywhere else.
const REDIRECT_TARGETS = { home: 'stremio:///', library: 'stremio:///library' };

function artVersion(...parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 10);
}

/**
 * The add-on Stremio talks to. Every route but the logo and clips sits under
 * the secret token, because opening a profile's stream switches the account.
 */
export function createAddonRouter({ config, service, log, waitMs = SWITCH_WAIT_MS }) {
  const router = express.Router();
  const art = new ArtCache();
  const { publicUrl } = config;

  const cors = (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', '*');
    next();
  };
  const noStore = (res) => res.set('Cache-Control', 'no-store');

  /** Resolves the token or answers 404 (same as an unknown path, so tokens can't be probed). */
  const withToken = (handler) => async (req, res) => {
    const state = service.repo.getState();
    if (!state || !service.repo.getAccount() || !safeEqual(req.params.token, state.addon_token)) {
      return res.status(404).json({ err: 'Not found' });
    }
    return handler(req, res, state);
  };

  const base = (token) => `${publicUrl}/${token}`;

  function posterUrl(token, p, active) {
    return `${base(token)}/poster/${p.id}.png?v=${artVersion(p.name, p.avatar_colour, p.avatar_preset, active)}`;
  }

  function preview(token, p, active) {
    return {
      id: profileMetaId(p.id),
      type: CATALOG_TYPE,
      name: p.name,
      poster: posterUrl(token, p, active),
      posterShape: 'square',
      description: describe(p, active),
    };
  }

  function describe(p, active) {
    const counts = `${p.library_count} title${p.library_count === 1 ? '' : 's'} · ${p.addon_count} add-on${p.addon_count === 1 ? '' : 's'}`;
    return active
      ? `${counts}. This is the profile in use.`
      : `${counts}. Opening this switches the account to ${p.name}. Then close and reopen Stremio.`;
  }

  // `description` only. stremio-core reads `title` as an alias of it
  // (types/resource/stream.rs), so sending both is a duplicate field: the
  // stream fails to parse, is skipped, and Stremio says "No streams were found".
  // Key line first: phones truncate.
  function stream(description, clip = 'switching.mp4') {
    return {
      name: 'OpenProfiles',
      description,
      url: `${publicUrl}/clips/${clip}`,
      behaviorHints: { notWebReady: true },
    };
  }

  /**
   * The "tap to refresh" stream; `userAgent` is the one on the stream request.
   *   - Desktop (a browser user agent: Stremio 5 runs in WebView2): open
   *     /refresh/go in the browser, which redirects back to Home. Leaving and
   *     re-entering the window re-syncs (stremio-web re-syncs on focus). A
   *     direct stremio:// link doesn't work here: the desktop app hands every
   *     stream link to the browser, which can't open it (tested 2026-10-11).
   *   - Android app (sends no user agent): the stream's link is the deep
   *     link itself. The app hands it straight back to itself and reloads, with
   *     no browser. Via the browser, Chrome wouldn't follow the redirect into
   *     an app without a tap on the page. Live-tested on a Galaxy S22, 2026-10-11.
   */
  function refreshStream(description, userAgent = '') {
    const desktop = /Windows NT|Macintosh|X11|CrOS/.test(userAgent);
    return {
      name: 'OpenProfiles',
      description,
      externalUrl: desktop ? `${publicUrl}/refresh/go?to=auto` : REDIRECT_TARGETS.library,
    };
  }

  // An HTTP redirect into the app. Browsers still show the response body while
  // they hand a stremio:// link over (Express's default is "Found.
  // Redirecting to …"), so the body is a near-empty page in Stremio's colours.
  // `to=auto` picks per device (see autoRefreshTarget).
  router.get('/refresh/go', (req, res) => {
    const to = req.query.to === 'auto' ? autoRefreshTarget(req.get('user-agent')) : req.query.to;
    const target = REDIRECT_TARGETS[to] ?? REDIRECT_TARGETS.home;
    res.status(302)
      .set('Location', target)
      .set('Cache-Control', 'no-store')
      .type('html')
      .send(handoffPage(target));
  });

  router.get('/logo.png', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400').type('png').send(await art.get('logo', renderLogo));
  });

  router.get('/:token/manifest.json', cors, withToken((req, res) => {
    noStore(res);
    res.json(buildManifest({ publicUrl }));
  }));

  // Stremio's "Configure" button opens <transport base>/configure.
  router.get('/:token/configure', withToken((req, res) => res.redirect(303, '/configure')));

  const catalog = withToken((req, res, state) => {
    noStore(res);
    if (req.params.type !== CATALOG_TYPE || req.params.id !== CATALOG_ID) return res.json({ metas: [] });
    const metas = service.repo.listProfiles().map((p) => preview(state.addon_token, p, p.id === state.active_profile_id));
    return res.json({ metas });
  });
  router.get('/:token/catalog/:type/:id.json', cors, catalog);
  router.get('/:token/catalog/:type/:id/:extra.json', cors, catalog);

  router.get('/:token/meta/:type/:id.json', cors, withToken((req, res, state) => {
    noStore(res);
    const id = parseProfileMetaId(req.params.id);
    const p = id && service.repo.getProfile(id);
    if (!p) return res.status(404).json({ meta: null });
    const active = p.id === state.active_profile_id;
    return res.json({
      meta: {
        ...preview(state.addon_token, p, active),
        // Echo the requested type: Stremio drops a meta whose type differs from the request.
        type: req.params.type,
        background: `${base(state.addon_token)}/background/${p.id}.png?v=${artVersion(p.name, p.avatar_colour, p.avatar_preset)}`,
        behaviorHints: { defaultVideoId: profileMetaId(p.id) },
      },
    });
  }));

  // Requesting the stream IS the switch. Stremio may ask twice (or prefetch
  // when the page opens); switchTo is idempotent, so that's harmless.
  router.get('/:token/stream/:type/:id.json', cors, withToken(async (req, res) => {
    noStore(res);
    const id = parseProfileMetaId(req.params.id);
    const p = id && service.repo.getProfile(id);
    if (!p) return res.json({ streams: [stream("Couldn't switch: that profile no longer exists.", 'switch-error.mp4')] });

    const work = service.switchTo(id);
    const outcome = await Promise.race([
      work.then((result) => ({ result }), (error) => ({ error })),
      sleep(waitMs).then(() => ({ pending: true })),
    ]);

    if (outcome.pending) {
      work.catch(() => {}); // the service has already logged and journaled it
      return res.json({ streams: [stream(`Still switching to ${p.name}\nWait a minute, then close and reopen Stremio.`)] });
    }
    if (outcome.error) {
      if (!outcome.error.userMessage) log.error('Switch from Stremio failed', { error: outcome.error.message });
      return res.json({ streams: [stream(`Couldn't switch: ${userMessageOf(outcome.error)}`, 'switch-error.mp4')] });
    }
    const { result } = outcome;
    const lines = result.alreadyActive
      ? [`${p.name} is in use`, "Tap to refresh Stremio if you don't see it yet."]
      : [`Switched to ${p.name}`, 'Tap here to refresh Stremio.'];
    if (result.warnings?.length) lines.push("Some parts didn't switch. The OpenProfiles page has details.");
    return res.json({
      streams: [
        refreshStream(lines.join('\n'), req.get('user-agent')),
        stream("Didn't refresh? Close and reopen Stremio.\nThis clip is just a reminder."),
      ],
    });
  }));

  router.get('/:token/poster/:id.png', withToken(async (req, res, state) => {
    const p = service.repo.getProfile(Number(req.params.id));
    if (!p) return res.status(404).end();
    const active = p.id === state.active_profile_id;
    const png = await art.get(`poster|${p.name}|${p.avatar_colour}|${p.avatar_preset}|${active}`,
      () => renderPoster({ name: p.name, colour: p.avatar_colour, avatar: p.avatar_preset, active }));
    res.set('Cache-Control', 'private, max-age=86400').type('png').send(png);
  }));

  router.get('/:token/background/:id.png', withToken(async (req, res) => {
    const p = service.repo.getProfile(Number(req.params.id));
    if (!p) return res.status(404).end();
    const png = await art.get(`bg|${p.name}|${p.avatar_colour}|${p.avatar_preset}`,
      () => renderBackground({ name: p.name, colour: p.avatar_colour, avatar: p.avatar_preset }));
    res.set('Cache-Control', 'private, max-age=86400').type('png').send(png);
  }));

  return router;
}
