import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('../../package.json');

export const ADDON_ID = 'community.openprofiles';
// Stremio titles a Home row "<catalog name> - <type>": "Switch profile - OpenProfiles".
export const CATALOG_TYPE = 'OpenProfiles';
export const CATALOG_ID = 'openprofiles';
export const ID_PREFIX = 'openprofiles:';

export function buildManifest({ publicUrl }) {
  return {
    id: ADDON_ID,
    version,
    name: 'OpenProfiles',
    description: 'Switch between the profiles saved for this Stremio account. Opening a profile switches to it; tap its stream to refresh Stremio.',
    logo: `${publicUrl}/logo.png`,
    types: [CATALOG_TYPE],
    catalogs: [{ type: CATALOG_TYPE, id: CATALOG_ID, name: 'Switch profile' }],
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

/** What the switch needs to keep OpenProfiles installed in every profile it writes. */
export function createSelfAddon({ publicUrl }) {
  const manifestUrl = (token) => `${publicUrl}/${token}/manifest.json`;
  return {
    id: ADDON_ID,
    manifestUrl,
    descriptor: (token) => ({
      transportUrl: manifestUrl(token),
      transportName: '',
      manifest: buildManifest({ publicUrl }),
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
