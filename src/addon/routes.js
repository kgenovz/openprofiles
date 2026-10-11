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

  function stream(title, clip = 'switching.mp4') {
    return {
      name: 'OpenProfiles',
      // Stremio 4 reads `title`, Stremio 5 reads `description`. Key line first: phones truncate.
      title,
      description: title,
      url: `${publicUrl}/clips/${clip}`,
      behaviorHints: { notWebReady: true },
    };
  }

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
      ? [`${p.name} is in use`, "Don't see it? Close and reopen Stremio."]
      : [`Switched to ${p.name}`, 'Close and reopen Stremio to see it.'];
    if (result.warnings?.length) lines.push("Some parts didn't switch. The OpenProfiles page has details.");
    return res.json({ streams: [stream(lines.join('\n'))] });
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
