import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  STOCK_SETTINGS, anotherAddonServesMeta, buildManifest, classify, deriveSettings, describeSettings, findCinemeta, needsStock,
} from '../src/core/cinemeta.js';
import { CINEMETA_URL, cinemetaAddon, cinemetaManifest, richAddon } from './helpers/fakeStremio.js';

const settings = (s) => ({ ...STOCK_SETTINGS, ...s });
const ids = (m) => m.catalogs.map((c) => `${c.type}:${c.id}`);
const search = (c) => c.extra?.find((e) => e.name === 'search');

describe('Cinemeta control', () => {
  it('reads the stock manifest as nothing hidden', () => {
    assert.deepEqual(deriveSettings(cinemetaManifest()), STOCK_SETTINGS);
  });

  it('hiding Popular keeps it (so search still works) with a required search extra', () => {
    const m = buildManifest({ current: cinemetaManifest(), settings: settings({ hidePopular: true }) });
    const popular = m.catalogs.filter((c) => c.id === 'top');
    assert.equal(popular.length, 2, 'one per type, both kept');
    assert.ok(popular.every((c) => search(c)?.isRequired === true));
    assert.equal(deriveSettings(m).hidePopular, true);
    assert.equal(deriveSettings(m).removeSearch, false);
  });

  it('hiding New and Featured removes them, and never drops the calendar catalogs', () => {
    const m = buildManifest({ current: cinemetaManifest(), settings: settings({ hideNew: true, hideFeatured: true }) });
    assert.deepEqual(ids(m), ['movie:top', 'series:top', 'series:last-videos', 'series:calendar-videos']);
  });

  it('search off strips every search extra, and Popular hidden with search off is removed', () => {
    const noSearch = buildManifest({ current: cinemetaManifest(), settings: settings({ removeSearch: true }) });
    assert.ok(noSearch.catalogs.every((c) => !search(c)));
    assert.ok(noSearch.catalogs.some((c) => c.id === 'top'), 'Popular stays as a row');
    const both = buildManifest({ current: cinemetaManifest(), settings: settings({ removeSearch: true, hidePopular: true }) });
    assert.ok(!both.catalogs.some((c) => c.id === 'top'));
  });

  it('details off drops meta from resources and nothing else', () => {
    const m = buildManifest({ current: cinemetaManifest(), settings: settings({ removeMeta: true }) });
    assert.deepEqual(m.resources, ['catalog', 'addon_catalog']);
    assert.equal(deriveSettings(m).removeMeta, true);
  });

  it('bringing rows back needs the stock copy; hiding more never does', () => {
    const trimmed = buildManifest({ current: cinemetaManifest(), settings: settings({ hideNew: true, removeMeta: true }) });
    assert.equal(needsStock(trimmed, settings({ hideNew: true, removeMeta: true, hideFeatured: true })), false);
    assert.equal(needsStock(trimmed, settings({ removeMeta: true })), true, 'New back');
    assert.equal(needsStock(trimmed, settings({ hideNew: true })), true, 'details back');
    const noPopular = buildManifest({ current: cinemetaManifest(), settings: settings({ hidePopular: true, removeSearch: true }) });
    assert.equal(needsStock(noPopular, settings({ hidePopular: true })), true, 'search back needs Popular to carry it');
  });

  it('back to stock with the stock copy is byte-equal to stock, in stock order', () => {
    const trimmed = buildManifest({
      current: cinemetaManifest(),
      settings: settings({ hidePopular: true, hideNew: true, hideFeatured: true, removeSearch: true, removeMeta: true }),
    });
    const back = buildManifest({ current: trimmed, stock: cinemetaManifest(), settings: STOCK_SETTINGS });
    assert.deepEqual(back, cinemetaManifest());
  });

  it('keeps catalog names the add-on manager changed when it rebuilds', () => {
    const renamed = cinemetaManifest();
    renamed.catalogs[0].name = 'Top picks';
    const m = buildManifest({ current: renamed, stock: cinemetaManifest(), settings: settings({ hideNew: true }) });
    assert.equal(m.catalogs.find((c) => c.type === 'movie' && c.id === 'top').name, 'Top picks');
  });

  it('only edits the stock Cinemeta, not a copy another add-on wraps', () => {
    const wrapped = { transportUrl: `https://ratings.example/${encodeURIComponent(CINEMETA_URL)}/manifest.json`, manifest: { ...cinemetaManifest() } };
    assert.equal(classify(cinemetaAddon()), 'stock');
    assert.equal(classify(wrapped), 'wrapped');
    assert.deepEqual(findCinemeta([wrapped, cinemetaAddon()]), { index: 1, wrapped: true });
  });

  it('knows when another add-on gives details pages', () => {
    const list = [cinemetaAddon(), richAddon('tmdb', { resources: ['catalog', 'meta'] })];
    assert.equal(anotherAddonServesMeta(list, 0), true);
    assert.equal(anotherAddonServesMeta([cinemetaAddon(), richAddon('streams')], 0), false);
  });

  it('describes settings in a line', () => {
    assert.equal(describeSettings(settings({ hideNew: true, hideFeatured: true })), 'Popular shown; New and Featured hidden; search on; details pages on.');
    assert.equal(describeSettings(STOCK_SETTINGS), 'Popular, New and Featured shown; search on; details pages on.');
  });
});
