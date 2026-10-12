import crypto from 'node:crypto';
import { isSelfAddon } from '../addon/manifest.js';
import { CINEMETA_ID, classify, deriveSettings, findCinemeta } from './cinemeta.js';

// Add-on lists as the add-on manager and the wizard see them. Pages refer to
// an add-on by a short hash of its link (`ref`), never the link itself:
// links often carry debrid keys.

const LOCAL_FILES_ID = 'org.stremio.local';
const MAX_CATALOG_NAME = 60;
// Tile colours for add-ons (they have no picture we load: the page doesn't fetch other sites).
const TILE_COLOURS = ['#e05d0c', '#0f8f80', '#3b8f4b', '#0a7fe0', '#8e4ec6', '#d6409f', '#b7790b', '#e5484d'];

export const addonRef = (addon) => crypto.createHash('sha256').update(String(addon.transportUrl)).digest('hex').slice(0, 16);

/** Stremio marks Cinemeta and Local Files protected: they can be moved, not removed. */
export function isProtectedAddon(addon) {
  return addon?.flags?.protected === true || [CINEMETA_ID, LOCAL_FILES_ID].includes(addon?.manifest?.id);
}

/** Runs inside the Stremio app (Local Files), so the server can't and shouldn't reach it. */
export function runsOnDevice(addon) {
  try {
    const host = new URL(addon.transportUrl).hostname;
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
}

function servesMeta(manifest) {
  if (!manifest || typeof manifest !== 'object') return false;
  const types = Array.isArray(manifest.types) ? manifest.types : [];
  return (Array.isArray(manifest.resources) ? manifest.resources : []).some((r) => {
    if (r === 'meta') return types.includes('movie') || types.includes('series');
    if (r && typeof r === 'object' && r.name === 'meta') {
      const own = Array.isArray(r.types) ? r.types : types;
      return own.includes('movie') || own.includes('series');
    }
    return false;
  });
}

const resourceName = (r) => (typeof r === 'string' ? r : r?.name);

/** What a page needs to show one add-on. */
export function describeAddon(addon) {
  const m = addon.manifest ?? {};
  const ref = addonRef(addon);
  let host = '';
  try {
    host = new URL(addon.transportUrl).hostname;
  } catch { /* shown without a host */ }
  const resources = [...new Set((Array.isArray(m.resources) ? m.resources : []).map(resourceName).filter(Boolean))];
  const name = String(m.name || m.id || 'Add-on').slice(0, 80);
  return {
    ref,
    id: String(m.id ?? ''),
    name,
    version: typeof m.version === 'string' ? m.version.slice(0, 20) : '',
    host,
    resources,
    // Only catalogs Stremio shows can usefully be renamed: a required extra other than
    // a genre picker (Cinemeta's calendar ones, a hidden Popular) keeps a catalog out of sight.
    catalogs: (Array.isArray(m.catalogs) ? m.catalogs : [])
      .filter((c) => c && typeof c === 'object' && c.id != null)
      .filter((c) => !(Array.isArray(c.extra) && c.extra.some((e) => e?.isRequired === true && e.name !== 'genre')))
      .map((c) => ({ key: `${c.type ?? ''}:${c.id}`, type: String(c.type ?? ''), name: String(c.name ?? c.id) })),
    protected: isProtectedAddon(addon),
    self: isSelfAddon(addon),
    cinemeta: classify(addon) === 'stock',
    wrapsCinemeta: classify(addon) === 'wrapped',
    servesMeta: servesMeta(m),
    onDevice: runsOnDevice(addon),
    initial: name.trim().charAt(0).toUpperCase() || '?',
    colour: TILE_COLOURS[parseInt(ref.slice(0, 4), 16) % TILE_COLOURS.length],
  };
}

/** A short "what it does" line: "v1.4.0 · catalogs, streams · kids.example.com". */
export function addonDetail(d) {
  const words = { catalog: 'catalogs', stream: 'streams', subtitles: 'subtitles', meta: 'details', addon_catalog: 'add-on lists' };
  const does = d.resources.map((r) => words[r] ?? r).join(', ');
  return [d.version && `v${d.version}`, does, d.host].filter(Boolean).join(' · ');
}

export const addonsHash = (addons) => crypto.createHash('sha256').update(JSON.stringify(addons)).digest('hex').slice(0, 32);

/** JSON with object keys sorted, so the same data always gives the same text. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * What an add-on list amounts to (links, order and manifests), independent of
 * key order or flags, so a list read back from Stremio compares equal to the
 * one written.
 */
export const addonsFingerprint = (addons) => crypto.createHash('sha256')
  .update(stableJson((addons || []).map((a) => [a.transportUrl, a.manifest ?? null])))
  .digest('hex').slice(0, 32);

/** Cinemeta's settings in a list, or null when the list has no stock Cinemeta. */
export function cinemetaOf(addons) {
  const { index, wrapped, wrappedIndex } = findCinemeta(addons);
  return {
    present: index !== -1,
    wrapped,
    wrappedName: wrapped ? String(addons[wrappedIndex].manifest?.name || 'Another add-on') : null,
    settings: index === -1 ? null : deriveSettings(addons[index].manifest),
  };
}

/**
 * Every add-on to choose from, by ref. Sources earlier in `sources` win when
 * two have the same link (e.g. Cinemeta, whose manifest differs per profile).
 * `from` names where each one was seen.
 */
export function addonPool(sources) {
  const pool = new Map();
  for (const { label, addons } of sources) {
    for (const addon of addons || []) {
      const ref = addonRef(addon);
      const entry = pool.get(ref);
      if (entry) {
        if (label && !entry.from.includes(label)) entry.from.push(label);
      } else {
        pool.set(ref, { addon, from: label ? [label] : [] });
      }
    }
  }
  return pool;
}

/** Catalog renames: `{ [ref]: { 'type:id': name } }`, applied to a copy of the add-on. */
export function renameCatalogs(addon, names) {
  if (!names || !Array.isArray(addon.manifest?.catalogs)) return addon;
  let changed = false;
  const catalogs = addon.manifest.catalogs.map((c) => {
    const wanted = names[`${c?.type ?? ''}:${c?.id}`];
    if (typeof wanted !== 'string') return c;
    const clean = wanted.replace(/\s+/g, ' ').trim().slice(0, MAX_CATALOG_NAME);
    if (!clean || clean === (c.name ?? String(c.id))) return c;
    changed = true;
    return { ...c, name: clean };
  });
  return changed ? { ...addon, manifest: { ...addon.manifest, catalogs } } : addon;
}

/**
 * Build an ordered list from refs, looking each up in `lookup(ref)`. Unknown
 * refs return their position in `missing` rather than being dropped silently.
 */
export function listFromRefs(refs, lookup, renames = {}) {
  const seen = new Set();
  const addons = [];
  const missing = [];
  for (const ref of refs) {
    if (typeof ref !== 'string' || seen.has(ref)) continue;
    seen.add(ref);
    const addon = lookup(ref);
    if (!addon) missing.push(ref);
    else addons.push(renameCatalogs(addon, renames[ref]));
  }
  return { addons, missing };
}

/** Protected add-ons (and OpenProfiles) in `before` that `after` dropped. */
export function droppedProtected(before, after) {
  const kept = new Set(after.map(addonRef));
  return before.filter((a) => (isProtectedAddon(a) || isSelfAddon(a)) && !kept.has(addonRef(a)));
}

/** Human summary of a list edit, for the activity log: "removed YouTube; added TMDB; reordered". */
export function describeListChange(before, after) {
  const name = (a) => a.manifest?.name || a.manifest?.id || 'an add-on';
  const beforeRefs = before.map(addonRef);
  const afterRefs = after.map(addonRef);
  const removed = before.filter((a) => !afterRefs.includes(addonRef(a))).map(name);
  const added = after.filter((a) => !beforeRefs.includes(addonRef(a))).map(name);
  const common = afterRefs.filter((r) => beforeRefs.includes(r));
  const reordered = common.join() !== beforeRefs.filter((r) => afterRefs.includes(r)).join();
  const renamed = after.some((a) => {
    const old = before.find((b) => addonRef(b) === addonRef(a));
    return old && JSON.stringify(old.manifest?.catalogs ?? null) !== JSON.stringify(a.manifest?.catalogs ?? null);
  });
  const parts = [];
  if (removed.length) parts.push(`removed ${removed.join(', ')}`);
  if (added.length) parts.push(`added ${added.join(', ')}`);
  if (reordered) parts.push('changed the order');
  if (renamed) parts.push('renamed catalogs');
  return parts.join('; ');
}
