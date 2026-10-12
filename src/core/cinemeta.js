// Cinemeta control, after StremShare's cinemetaControlService.
//
// Stremio serves Cinemeta from the manifest stored in the account's add-on
// list, not from whatever v3-cinemeta.strem.io serves today. So hiding a
// Cinemeta row is an edit to that stored copy, and it is per profile here
// because each profile has its own add-on list.
//
//  1. Hiding is destructive. Once `year` is filtered out nothing remembers it,
//     so bringing a row back means fetching the stock manifest again (through
//     the fetch guard). If that fetch fails the change is refused, never
//     half-applied. Hiding more never needs the network.
//  2. Popular is special. Stremio doesn't show a catalog with a required extra
//     but still searches it, so Popular hidden while search stays on is KEPT
//     with `{ name: 'search', isRequired: true }`. New and Featured have no
//     search to hang that on, so hiding them removes them.
//  3. Only `catalogs` and `resources` are rebuilt. Every other key, and the
//     names of catalogs the profile still has (the add-on manager can rename
//     them), come from the current copy. Catalogs Cinemeta adds that we don't
//     know (`last-videos`, `calendar-videos`, …) are never dropped: Stremio's
//     calendar and new-episode checks look them up.

export const CINEMETA_ID = 'com.linvo.cinemeta';
const STOCK_HOST = 'v3-cinemeta.strem.io';
const POPULAR = 'top';
const NEW = 'year';
const FEATURED = 'imdbRating';

export const SETTING_KEYS = ['hidePopular', 'hideNew', 'hideFeatured', 'removeSearch', 'removeMeta'];
export const STOCK_SETTINGS = Object.freeze({ hidePopular: false, hideNew: false, hideFeatured: false, removeSearch: false, removeMeta: false });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? v : structuredClone(v));

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function embedsStockUrl(url) {
  const raw = String(url).toLowerCase();
  if (raw.includes(STOCK_HOST)) return true;
  try {
    return decodeURIComponent(raw).includes(STOCK_HOST);
  } catch {
    return false;
  }
}

/**
 * 'stock' | 'wrapped' | null. A copy that merely embeds the stock URL (a
 * ratings wrapper, say) is "wrapped": its own server rebuilds that manifest,
 * so editing it here would be undone, and it isn't ours to edit.
 */
export function classify(addon) {
  const url = addon?.transportUrl ?? '';
  const id = addon?.manifest?.id ?? '';
  if (hostOf(url) === STOCK_HOST) return 'stock';
  if (id.startsWith(`${CINEMETA_ID}.`)) return 'wrapped';
  if (embedsStockUrl(url)) return 'wrapped';
  if (id === CINEMETA_ID) return 'stock';
  return null;
}

/**
 * Index of the stock Cinemeta in a list (-1 if none), and of the first copy
 * another add-on wraps (a ratings wrapper, say). A wrapped copy shows its own
 * Popular / New / Featured, so with both in a list each row can appear twice.
 */
export function findCinemeta(addons) {
  let index = -1;
  let wrappedIndex = -1;
  (addons || []).forEach((a, i) => {
    const kind = classify(a);
    if (kind === 'stock' && index === -1) index = i;
    else if (kind === 'wrapped' && wrappedIndex === -1) wrappedIndex = i;
  });
  return { index, wrapped: wrappedIndex !== -1, wrappedIndex };
}

const catalogsOf = (m) => (Array.isArray(m?.catalogs) ? m.catalogs.filter(isObject) : []);
const resourcesOf = (m) => (Array.isArray(m?.resources) ? m.resources : []);
const searchExtra = (c) => (Array.isArray(c?.extra) ? c.extra.find((e) => isObject(e) && e.name === 'search') ?? null : null);
const withId = (m, id) => catalogsOf(m).filter((c) => c.id === id);
const isMeta = (r) => r === 'meta' || (isObject(r) && r.name === 'meta');
export const hasMeta = (m) => resourcesOf(m).some(isMeta);

function popularHidden(m) {
  const popular = withId(m, POPULAR);
  return popular.length > 0 && popular.every((c) => searchExtra(c)?.isRequired === true);
}

/** The five settings, read back from a stored manifest. */
export function deriveSettings(manifest) {
  return {
    hidePopular: withId(manifest, POPULAR).length === 0 || popularHidden(manifest),
    hideNew: withId(manifest, NEW).length === 0,
    hideFeatured: withId(manifest, FEATURED).length === 0,
    removeSearch: !catalogsOf(manifest).some((c) => searchExtra(c) !== null),
    removeMeta: !hasMeta(manifest),
  };
}

export const sameSettings = (a, b) => SETTING_KEYS.every((k) => Boolean(a[k]) === Boolean(b[k]));

/** Settings from untrusted input: anything not literally true is false. */
export function parseSettings(raw = {}) {
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, raw[k] === true]));
}

function stripSearch(c) {
  if (!Array.isArray(c.extra)) return c;
  return { ...c, extra: c.extra.filter((e) => !(isObject(e) && e.name === 'search')) };
}

function requireSearch(c) {
  const extra = Array.isArray(c.extra) ? c.extra.slice() : [];
  const i = extra.findIndex((e) => isObject(e) && e.name === 'search');
  if (i === -1) extra.push({ name: 'search', isRequired: true });
  else extra[i] = { ...extra[i], isRequired: true };
  return { ...c, extra };
}

/** Optional search: `isRequired` is deleted, not set false, so a reset is byte-equal to stock. */
function optionalSearch(c, addIfMissing) {
  const extra = Array.isArray(c.extra) ? c.extra.slice() : [];
  const i = extra.findIndex((e) => isObject(e) && e.name === 'search');
  if (i === -1) {
    if (!addIfMissing) return c;
    extra.push({ name: 'search' });
  } else {
    const rest = { ...extra[i] };
    delete rest.isRequired;
    extra[i] = rest;
  }
  return { ...c, extra };
}

const catalogKey = (c) => `${c?.type ?? ''}:${c?.id ?? ''}`;

/** Stock's catalogs in stock's order, keeping current names; stock may only add. */
function mergeStockCatalogs(current, stock) {
  const mine = new Map();
  for (const c of current) if (!mine.has(catalogKey(c))) mine.set(catalogKey(c), c);
  const taken = new Set();
  const merged = stock.map((c) => {
    taken.add(catalogKey(c));
    const edited = mine.get(catalogKey(c));
    return typeof edited?.name === 'string' ? { ...c, name: edited.name } : c;
  });
  for (const c of current) if (!taken.has(catalogKey(c))) merged.push(c);
  return merged;
}

/** Would these settings need rows or details the current copy no longer has? */
export function needsStock(current, settings) {
  const now = deriveSettings(current);
  // Popular also carries search, so search back on needs it back too.
  return ((!settings.hidePopular || !settings.removeSearch) && withId(current, POPULAR).length === 0)
    || (!settings.hideNew && now.hideNew)
    || (!settings.hideFeatured && now.hideFeatured)
    || (!settings.removeMeta && now.removeMeta);
}

/**
 * The manifest `settings` produce from `current`. `stock` (the freshly fetched
 * stock manifest, or null) supplies rows the current copy lost and the order
 * Cinemeta ships them in. Callers check `needsStock` first and refuse when it
 * is needed but missing.
 */
export function buildManifest({ current, stock = null, settings }) {
  const base = isObject(current) ? current : {};
  const usedStock = isObject(stock) && Array.isArray(stock.catalogs);
  const currentCatalogs = clone(catalogsOf(base));
  const source = usedStock ? mergeStockCatalogs(currentCatalogs, clone(catalogsOf(stock))) : currentCatalogs;
  const sourceResources = clone(usedStock && Array.isArray(stock.resources) ? stock.resources : base.resources) || [];

  const catalogs = source
    .filter((c) => {
      if (c.id === POPULAR) return settings.hidePopular ? !settings.removeSearch : true;
      if (c.id === NEW) return !settings.hideNew;
      if (c.id === FEATURED) return !settings.hideFeatured;
      return true;
    })
    .map((c) => {
      if (settings.removeSearch) return stripSearch(c);
      if (c.id === POPULAR && settings.hidePopular) return requireSearch(c);
      return optionalSearch(c, c.id === POPULAR);
    });

  let resources = sourceResources.filter((r) => !(settings.removeMeta && isMeta(r)));
  if (!settings.removeMeta && !resources.some(isMeta)) resources = [...resources, 'meta'];

  return { ...clone(base), catalogs, resources };
}

/**
 * Does this add-on give details pages for the titles Cinemeta covers: movies or
 * series with IMDb ids ("tt…")? A resource may set its own types and id
 * prefixes; otherwise the manifest's apply, and no prefixes means any id.
 */
export function givesTitleDetails(addon) {
  const m = addon?.manifest;
  if (!isObject(m)) return false;
  const types = Array.isArray(m.types) ? m.types : [];
  return resourcesOf(m).some((r) => {
    if (!isMeta(r)) return false;
    const own = isObject(r) && Array.isArray(r.types) ? r.types : types;
    const prefixes = isObject(r) && Array.isArray(r.idPrefixes) ? r.idPrefixes : Array.isArray(m.idPrefixes) ? m.idPrefixes : null;
    const imdb = !prefixes || prefixes.some((p) => typeof p === 'string' && 'tt0000001'.startsWith(p));
    return imdb && (own.includes('movie') || own.includes('series'));
  });
}

/**
 * A metadata add-on that only covers its own titles: details pages for movies
 * or series, but only for its own ids (e.g. TMDB set to "tmdb:" ids), plus
 * searchable catalogs. Stremio only asks it about titles from its catalogs,
 * so it can't replace Cinemeta for the library or Cinemeta's rows.
 */
export function givesOwnDetailsOnly(addon) {
  const m = addon?.manifest;
  if (!isObject(m) || givesTitleDetails(addon)) return false;
  const types = Array.isArray(m.types) ? m.types : [];
  const movieOrSeries = resourcesOf(m).some((r) => {
    if (!isMeta(r)) return false;
    const own = isObject(r) && Array.isArray(r.types) ? r.types : types;
    return own.includes('movie') || own.includes('series');
  });
  return movieOrSeries && catalogsOf(m).some((c) => searchExtra(c) !== null);
}

/**
 * A full metadata add-on can do Cinemeta's whole job: details pages for those
 * titles, and catalogs with search. Clones like a ratings wrapper, TMDB and
 * AIOMetadata all are.
 */
export function isFullMetadata(addon) {
  return givesTitleDetails(addon) && catalogsOf(addon.manifest).some((c) => searchExtra(c) !== null);
}

/** Index of the add-on Stremio takes details pages from: the first in the list that gives them (-1: none). */
export function detailsSource(addons) {
  return (addons || []).findIndex(givesTitleDetails);
}

/**
 * Settings that hand Cinemeta's job to another add-on: stock Cinemeta's rows
 * off, and its search and details pages off too wherever that add-on gives
 * them (so search results and details pages come from it alone).
 */
export function settingsForHandoff(addon) {
  return {
    hidePopular: true,
    hideNew: true,
    hideFeatured: true,
    removeSearch: catalogsOf(addon?.manifest).some((c) => searchExtra(c) !== null),
    removeMeta: givesTitleDetails(addon),
  };
}

/** Does any other add-on in the list give details pages for movies or series? */
export function anotherAddonServesMeta(addons, cinemetaIndex) {
  return (addons || []).some((a, i) => i !== cinemetaIndex && givesTitleDetails(a));
}

/** One line for the profile page, e.g. "Popular shown; New and Featured hidden; search on; details pages on." */
export function describeSettings(s) {
  const rows = [['Popular', !s.hidePopular], ['New', !s.hideNew], ['Featured', !s.hideFeatured]];
  const on = rows.filter(([, v]) => v).map(([n]) => n);
  const off = rows.filter(([, v]) => !v).map(([n]) => n);
  const list = (names) => names.join(names.length === 2 ? ' and ' : ', ');
  const parts = [];
  if (off.length === 0) parts.push('Popular, New and Featured shown');
  else if (on.length === 0) parts.push('Popular, New and Featured hidden');
  else parts.push(`${list(on)} shown; ${list(off)} hidden`);
  parts.push(`search ${s.removeSearch ? 'off' : 'on'}`, `details pages ${s.removeMeta ? 'off' : 'on'}`);
  return `${parts.join('; ')}.`;
}

/** Plain words for the activity log. */
export function describeChanges(before, after) {
  const out = [];
  const flip = (key, onWord, offWord) => {
    if (Boolean(before[key]) !== Boolean(after[key])) out.push(after[key] ? offWord : onWord);
  };
  flip('hidePopular', 'showed Popular', 'hid Popular');
  flip('hideNew', 'showed New', 'hid New');
  flip('hideFeatured', 'showed Featured', 'hid Featured');
  flip('removeSearch', 'turned search on', 'turned search off');
  flip('removeMeta', 'turned details pages on', 'turned details pages off');
  return out;
}
