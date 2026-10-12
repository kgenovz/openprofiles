import { createRequire } from 'node:module';
import { DEFAULT_ADDON_DESCRIPTION, DEFAULT_CATALOG_NAME, DEFAULT_NAME } from '../core/settings.js';

const { version } = createRequire(import.meta.url)('../../package.json');

export const ADDON_ID = 'community.openprofiles';
// Stremio titles a Home row "<catalog name> - <type>": "Switch profile - OpenProfiles".
export const CATALOG_TYPE = 'OpenProfiles';
export const CATALOG_ID = 'openprofiles';
export const ID_PREFIX = 'openprofiles:';

/**
 * The row's catalog id names the profile whose add-on list it's in:
 * "openprofiles.3". Stremio keeps a Home row it already loaded while the
 * request for it (add-on link, type, catalog id) stays the same, even when the
 * add-ons change (stremio-core catalogs_with_extra.rs), so with one fixed id
 * the checkmark stayed on the old profile until Home was closed. A different
 * id per profile makes every switch load the row again.
 */
export function catalogId(profileId) {
  return profileId == null ? CATALOG_ID : `${CATALOG_ID}.${profileId}`;
}

/** Any id the row has had: the plain one (installed before ids named profiles) or a profile's. */
export function isCatalogId(id) {
  return id === CATALOG_ID || id.startsWith(`${CATALOG_ID}.`);
}

/** How the add-on presents itself; the Server tab can change all of it (Settings.addon()). */
export const DEFAULT_PRESENTATION = {
  name: DEFAULT_NAME, description: DEFAULT_ADDON_DESCRIPTION, catalogName: DEFAULT_CATALOG_NAME, logoVersion: null,
};

/**
 * The catalog type stays "OpenProfiles" whatever the add-on is called: Stremio
 * keeps it with installed copies and in its library, so changing it would
 * break the row until the next switch. `profileId` is the profile in use (see catalogId).
 */
export function buildManifest({ publicUrl }, presentation = DEFAULT_PRESENTATION, profileId = null) {
  const p = { ...DEFAULT_PRESENTATION, ...presentation };
  return {
    id: ADDON_ID,
    version,
    name: p.name,
    description: p.description,
    logo: `${publicUrl}/logo.png${p.logoVersion ? `?v=${p.logoVersion}` : ''}`,
    types: [CATALOG_TYPE],
    catalogs: [{ type: CATALOG_TYPE, id: catalogId(profileId), name: p.catalogName }],
    // One meta resource only: stremio-core matches the first one, and without
    // it Stremio says "No addons were requested for this meta" and never asks
    // for streams.
    resources: [
      'catalog',
      { name: 'meta', types: [CATALOG_TYPE], idPrefixes: [ID_PREFIX] },
      { name: 'stream', types: [CATALOG_TYPE], idPrefixes: [ID_PREFIX] },
    ],
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

/**
 * What the switch needs to keep OpenProfiles installed in every profile it
 * writes. `presentation` returns the current name and texts, so a switch
 * also carries the Server tab's latest ones into Stremio. `descriptor` takes
 * the profile whose add-on list it goes into.
 */
export function createSelfAddon({ publicUrl }, presentation = () => DEFAULT_PRESENTATION) {
  const manifestUrl = (token) => `${publicUrl}/${token}/manifest.json`;
  return {
    id: ADDON_ID,
    manifestUrl,
    descriptor: (token, profileId = null) => ({
      transportUrl: manifestUrl(token),
      transportName: '',
      manifest: buildManifest({ publicUrl }, presentation(), profileId),
      flags: {},
    }),
  };
}

export function isSelfAddon(addon) {
  return addon?.manifest?.id === ADDON_ID;
}

/**
 * Make sure OpenProfiles is in an add-on list with its current URL and
 * manifest. Keeps its position if present (the user may have reordered it),
 * else appends it. Without this, switching into a profile saved before
 * OpenProfiles was installed would remove the switcher row.
 */
export function ensureSelfAddon(addons, descriptor) {
  const i = addons.findIndex(isSelfAddon);
  if (i === -1) return [...addons, descriptor];
  const out = [...addons];
  out[i] = { ...addons[i], transportUrl: descriptor.transportUrl, manifest: descriptor.manifest };
  return out;
}

export function profileMetaId(profileId) {
  return `${ID_PREFIX}${profileId}`;
}

export function parseProfileMetaId(id) {
  if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) return null;
  const n = Number(id.slice(ID_PREFIX.length));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Deep link that opens Stremio's install dialog. */
export function stremioInstallUrl(manifestUrl) {
  return manifestUrl.replace(/^https?:\/\//, 'stremio://');
}
