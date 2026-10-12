import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addonRef } from '../src/core/addons.js';
import { STOCK_SETTINGS, deriveSettings } from '../src/core/cinemeta.js';
import { decodeSnapshot } from '../src/core/guard.js';
import { NO_DETAILS_WARNING } from '../src/core/service.js';
import { FakeStremio, cinemetaAddon, cinemetaManifest, libItem, notif, richAddon } from './helpers/fakeStremio.js';
import { makeService } from './helpers/setup.js';

const HOUR = 60 * 60 * 1000;
const names = (addons) => addons.map((a) => a.manifest.name);

/** Original (active, from the account) with Cinemeta, a debrid add-on, TMDB and Local Files; Kids is an empty copy. */
async function setup({ localFiles = true, ...opts } = {}) {
  const fake = new FakeStremio().seed({
    library: [libItem('tt-a', { timeOffset: 600, temp: true }), libItem('tt-b')],
    notifs: [notif('tt-a 1 3')],
    addons: [
      cinemetaAddon(),
      richAddon('debrid', { url: 'https://debrid.example/SECRETKEY/manifest.json', resources: ['stream'] }),
      richAddon('tmdb', { resources: ['catalog', 'meta'] }),
      ...(localFiles ? [{ transportUrl: 'http://127.0.0.1:11470/local-addon/manifest.json', transportName: '', manifest: { id: 'org.stremio.local', name: 'Local Files', version: '1.10.0', resources: ['catalog', 'meta', 'stream'], types: ['movie', 'series', 'other'], catalogs: [] }, flags: { official: true, protected: true } }] : []),
    ],
  });
  const ctx = makeService({ fake, ...opts });
  await ctx.signIn();
  const kids = await ctx.service.createProfile({ name: 'Kids', from: 'empty' });
  const original = ctx.repo.listProfiles().find((p) => p.name === 'Original');
  const saved = (id) => decodeSnapshot(ctx.repo.cipher, ctx.repo.getProfileRow(id), 'p');
  const refs = (list) => list.map(addonRef);
  return { ...ctx, kids, original, saved, refs };
}

describe('add-on manager: a profile not in use', () => {
  it('reorders and removes in the saved copy only, with a backup to undo', async () => {
    const { service, repo, fake, kids, saved, refs } = await setup();
    const editor = await service.editableAddons(kids.id);
    assert.equal(editor.active, false);
    const writes = fake.callCount('addonCollectionSet');
    const [cinemeta, , tmdb, local] = editor.addons;
    const result = await service.saveAddons(kids.id, { base: editor.base, refs: refs([tmdb, cinemeta, local]) });
    assert.equal(result.changed, true);
    assert.equal(fake.callCount('addonCollectionSet'), writes, 'Stremio untouched');
    assert.deepEqual(names(saved(kids.id).addons), ['tmdb', 'Cinemeta', 'Local Files']);
    assert.match(repo.listActivity()[0].detail, /removed debrid; changed the order/);

    const undo = service.latestUndo();
    assert.equal(undo.id, result.backupId);
    assert.equal(undo.profile_name, 'Kids');
    await service.undoEdit(undo.id);
    assert.deepEqual(names(saved(kids.id).addons), ['Cinemeta', 'debrid', 'tmdb', 'Local Files']);
    assert.equal(service.latestUndo(), null, 'an undone edit is not offered again');
  });

  it("won't remove Cinemeta or Local Files, but they can move", async () => {
    const { service, kids, refs } = await setup();
    const editor = await service.editableAddons(kids.id);
    const [cinemeta, debrid, tmdb, local] = editor.addons;
    await assert.rejects(service.saveAddons(kids.id, { base: editor.base, refs: refs([debrid, tmdb, local]) }), (e) => e.code === 'PROTECTED' && /Cinemeta/.test(e.userMessage));
    const moved = await service.saveAddons(kids.id, { base: editor.base, refs: refs([local, debrid, tmdb, cinemeta]) });
    assert.equal(moved.changed, true);
  });

  it('refuses a save made from a page that is out of date', async () => {
    const { service, kids, refs } = await setup();
    const editor = await service.editableAddons(kids.id);
    await service.saveAddons(kids.id, { base: editor.base, refs: refs(editor.addons.slice().reverse()) });
    await assert.rejects(service.saveAddons(kids.id, { base: editor.base, refs: refs(editor.addons) }), (e) => e.code === 'CHANGED');
  });

  it('saving the same list changes nothing and takes no backup', async () => {
    const { service, repo, kids, refs } = await setup();
    const editor = await service.editableAddons(kids.id);
    const backups = repo.listBackups().length;
    assert.equal((await service.saveAddons(kids.id, { base: editor.base, refs: refs(editor.addons) })).changed, false);
    assert.equal(repo.listBackups().length, backups);
  });

  it('adds an add-on by its link, and one from another profile', async () => {
    const { service, web, kids, original, saved, refs } = await setup();
    web.manifests.set('https://youtube.example/manifest.json', richAddon('YouTube').manifest);
    const found = await service.lookupAddon('stremio://youtube.example/manifest.json');
    assert.equal(found.name, 'YouTube');

    // Take TMDB out of Kids so Original is the only place it's in.
    let editor = await service.editableAddons(kids.id);
    const withoutTmdb = editor.addons.filter((a) => a.manifest.name !== 'tmdb');
    await service.saveAddons(kids.id, { base: editor.base, refs: [...refs(withoutTmdb), found.ref] });
    assert.deepEqual(names(saved(kids.id).addons), ['Cinemeta', 'debrid', 'Local Files', 'YouTube']);
    assert.equal(saved(kids.id).addons[3].transportUrl, 'https://youtube.example/manifest.json');

    const manager = await service.addonManager(kids.id);
    const tmdb = manager.pool.find((a) => a.name === 'tmdb');
    assert.deepEqual(tmdb.from, ['Original']);
    editor = await service.editableAddons(kids.id);
    await service.saveAddons(kids.id, { base: editor.base, refs: refs(editor.addons), addRef: tmdb.ref });
    assert.equal(names(saved(kids.id).addons).at(-1), 'tmdb');
    assert.ok(saved(original.id).addons.length, 'Original untouched');
  });

  it('says what went wrong with a bad link, without saving', async () => {
    const { service, kids } = await setup();
    await assert.rejects(service.lookupAddon('https://nowhere.example/manifest.json'), (e) => e.code === 'ADDON_FETCH');
    await assert.rejects(service.lookupAddon('https://nowhere.example/configure'), (e) => e.code === 'ADDON_FETCH' && /manifest\.json/.test(e.userMessage));
    const editor = await service.editableAddons(kids.id);
    await assert.rejects(service.saveAddons(kids.id, { base: editor.base, refs: ['0123456789abcdef'] }), (e) => e.code === 'ADDON_GONE');
  });

  it('rename fields sent back unchanged are not an edit, and hidden catalogs are not offered', async () => {
    const { service, kids, refs } = await setup();
    const manager = await service.addonManager(kids.id);
    const cinemeta = manager.addons.find((a) => a.name === 'Cinemeta');
    assert.ok(!cinemeta.catalogs.some((c) => c.key === 'series:last-videos'), 'calendar catalogs never show, so no rename');
    assert.ok(cinemeta.catalogs.some((c) => c.key === 'movie:year'), 'New (genre required) shows in Discover');
    const renames = Object.fromEntries(manager.addons.map((a) => [a.ref, Object.fromEntries(a.catalogs.map((c) => [c.key, c.name]))]));
    const editor = await service.editableAddons(kids.id);
    const result = await service.saveAddons(kids.id, { base: editor.base, refs: refs(editor.addons), renames });
    assert.equal(result.changed, false);
  });

  it('limits how many add-on fetches an account makes in a short time', async () => {
    const { service, web } = await setup();
    web.manifests.set('https://a.example/manifest.json', richAddon('A').manifest);
    let refused = null;
    for (let i = 0; i < 100 && !refused; i++) {
      refused = await service.lookupAddon('https://a.example/manifest.json').then(() => null, (e) => e);
    }
    assert.equal(refused?.code, 'SLOW_DOWN');
    assert.ok(web.fetched.length <= 80);
  });

  it('renames a catalog', async () => {
    const { service, kids, saved, refs } = await setup();
    const editor = await service.editableAddons(kids.id);
    const tmdb = editor.addons[2];
    await service.saveAddons(kids.id, { base: editor.base, refs: refs(editor.addons), renames: { [addonRef(tmdb)]: { 'movie:tmdb-top': '  Family   films ' } } });
    assert.equal(saved(kids.id).addons[2].manifest.catalogs[0].name, 'Family films');
  });

  it('reports which add-ons answer', async () => {
    const { service, web, kids } = await setup();
    web.manifests.set('https://tmdb.example/manifest.json', richAddon('tmdb').manifest);
    const health = await service.checkAddonHealth(kids.id);
    const byName = Object.fromEntries((await service.editableAddons(kids.id)).addons.map((a) => [a.manifest.name, health[addonRef(a)]]));
    assert.deepEqual(byName, { Cinemeta: 'ok', debrid: 'unreachable', tmdb: 'ok', 'Local Files': 'device' });
  });
});

describe('add-on manager: the profile in use', () => {
  it('writes Stremio, after a backup of the whole account', async () => {
    const { service, repo, fake, original, saved, refs } = await setup();
    const editor = await service.editableAddons(original.id);
    assert.equal(editor.active, true);
    const without = editor.addons.filter((a) => a.manifest.name !== 'debrid');
    const result = await service.saveAddons(original.id, { base: editor.base, refs: refs(without) });
    assert.deepEqual(names(fake.addons), ['Cinemeta', 'tmdb', 'Local Files']);
    assert.deepEqual(names(saved(original.id).addons), ['Cinemeta', 'tmdb', 'Local Files']);
    const backup = repo.getBackup(result.backupId);
    assert.equal(backup.kind, 'pre_change');
    assert.equal(backup.library_count, 2, 'the backup holds the library too');
  });

  it('notices add-ons changed in Stremio after the page was opened', async () => {
    const { service, fake, original, refs } = await setup();
    const editor = await service.editableAddons(original.id);
    fake.addons = fake.addons.slice(0, 3);
    await assert.rejects(service.saveAddons(original.id, { base: editor.base, refs: refs(editor.addons) }), (e) => e.code === 'CHANGED');
  });

  it('undo puts the add-ons back and leaves what was watched since', async () => {
    const { service, fake, original, refs } = await setup();
    const editor = await service.editableAddons(original.id);
    const { backupId } = await service.saveAddons(original.id, { base: editor.base, refs: refs(editor.addons.filter((a) => a.manifest.name !== 'tmdb')) });
    fake.seed({ library: [libItem('tt-new', { timeOffset: 30 })] });
    await service.undoEdit(backupId);
    assert.deepEqual(names(fake.addons), ['Cinemeta', 'debrid', 'tmdb', 'Local Files']);
    assert.ok(fake.activeIds().includes('tt-new'), 'library untouched');
  });

  it('a failed Stremio write changes nothing and leaves no undo behind', async () => {
    const { service, fake, original, refs } = await setup();
    const editor = await service.editableAddons(original.id);
    fake.failWhen((m) => m === 'addonCollectionSet', { status: 500 });
    await assert.rejects(service.saveAddons(original.id, { base: editor.base, refs: refs(editor.addons.slice(1).concat(editor.addons[0])) }), (e) => e.code === 'WRITE_FAILED');
    assert.equal(service.latestUndo(), null);
  });

  it('offers undo for 24 hours', async () => {
    const ctx = await setup();
    const editor = await ctx.service.editableAddons(ctx.kids.id);
    await ctx.service.saveAddons(ctx.kids.id, { base: editor.base, refs: ctx.refs(editor.addons.slice().reverse()) });
    assert.ok(ctx.service.latestUndo());
    ctx.advance(25 * HOUR);
    assert.equal(ctx.service.latestUndo(), null);
  });
});

describe('Cinemeta control per profile', () => {
  it('hides rows without the network, and brings them back from the stock copy', async () => {
    const { service, web, kids, saved } = await setup();
    let editor = await service.editableAddons(kids.id);
    await service.saveCinemeta(kids.id, { ...STOCK_SETTINGS, hideNew: true, hideFeatured: true }, { base: editor.base });
    assert.deepEqual(web.fetched, [], 'hiding needs no fetch');
    assert.deepEqual(deriveSettings(saved(kids.id).addons[0].manifest), { ...STOCK_SETTINGS, hideNew: true, hideFeatured: true });

    editor = await service.editableAddons(kids.id);
    await service.saveCinemeta(kids.id, { ...STOCK_SETTINGS, hideFeatured: true }, { base: editor.base });
    assert.equal(web.fetched.length, 1);
    assert.equal(deriveSettings(saved(kids.id).addons[0].manifest).hideNew, false);
  });

  it("refuses to bring rows back when Cinemeta can't be reached", async () => {
    const { service, web, kids, saved } = await setup();
    let editor = await service.editableAddons(kids.id);
    await service.saveCinemeta(kids.id, { ...STOCK_SETTINGS, hideNew: true }, { base: editor.base });
    web.manifests.clear();
    editor = await service.editableAddons(kids.id);
    const before = saved(kids.id).addons;
    await assert.rejects(service.saveCinemeta(kids.id, STOCK_SETTINGS, { base: editor.base }), (e) => e.code === 'CINEMETA_UNREACHABLE');
    await assert.rejects(service.resetCinemeta(kids.id, { base: editor.base }), (e) => e.code === 'CINEMETA_UNREACHABLE');
    assert.deepEqual(saved(kids.id).addons, before);
  });

  it('warns when details pages go and nothing else gives them', async () => {
    const { service, kids, refs } = await setup({ localFiles: false });
    let editor = await service.editableAddons(kids.id);
    const withTmdb = await service.saveCinemeta(kids.id, { ...STOCK_SETTINGS, removeMeta: true }, { base: editor.base });
    assert.deepEqual(withTmdb.warnings, [], 'TMDB gives details pages');
    editor = await service.editableAddons(kids.id);
    await service.saveAddons(kids.id, { base: editor.base, refs: refs(editor.addons.filter((a) => a.manifest.name !== 'tmdb')) });
    editor = await service.editableAddons(kids.id);
    await service.saveCinemeta(kids.id, STOCK_SETTINGS, { base: editor.base });
    editor = await service.editableAddons(kids.id);
    const alone = await service.saveCinemeta(kids.id, { ...STOCK_SETTINGS, removeMeta: true }, { base: editor.base });
    assert.deepEqual(alone.warnings, [NO_DETAILS_WARNING]);
  });

  it('with a wrapped Cinemeta too, says so and can hand the catalogs to it', async () => {
    const { service, fake, original, saved } = await setup();
    const wrapper = {
      transportUrl: 'https://ratingswrapper.example/abc/manifest.json',
      transportName: '',
      manifest: { ...cinemetaManifest(), id: 'com.linvo.cinemeta.ratings-wrapper', name: 'Cinemeta with Ratings', resources: ['catalog', 'meta'] },
      flags: {},
    };
    fake.addons = [...fake.addons.slice(0, 1), wrapper, ...fake.addons.slice(1)];
    const manager = await service.addonManager(original.id);
    assert.equal(manager.cinemeta.wrappedName, 'Cinemeta with Ratings');
    assert.ok(manager.addons.find((a) => a.name === 'Cinemeta with Ratings').wrapsCinemeta);

    await service.saveCinemeta(original.id, { handoff: manager.cinemeta.wrappedRef }, { base: manager.base });
    const stock = saved(original.id).addons.find((a) => a.manifest.id === 'com.linvo.cinemeta');
    assert.deepEqual(deriveSettings(stock.manifest), { hidePopular: true, hideNew: true, hideFeatured: true, removeSearch: true, removeMeta: true });
    assert.ok(stock.manifest.catalogs.some((c) => c.id === 'calendar-videos'), 'calendar catalogs stay');
    const live = fake.addons.find((a) => a.manifest.id === 'com.linvo.cinemeta.ratings-wrapper');
    assert.equal(live.manifest.catalogs.length, 8, "the wrapper's own copy is untouched");
  });

  it("changes where details pages come from: the pick moves to the top and Cinemeta's details go off, or back on", async () => {
    const { service, fake, original, saved } = await setup();
    const aio = richAddon('AIOMetadata', { resources: ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt', 'tmdb:'] }] });
    const tmdbIds = richAddon('The Movie Database Addon', {
      resources: ['catalog', 'meta'],
      catalogs: [{ type: 'movie', id: 'tmdb.search', name: 'Search', extra: [{ name: 'search', isRequired: true }] }],
    });
    tmdbIds.manifest.idPrefixes = ['tmdb:'];
    fake.addons = [...fake.addons, aio, tmdbIds];
    let manager = await service.addonManager(original.id);
    assert.ok(manager.metadata.options.find((o) => o.name === 'The Movie Database Addon').ownIds, 'TMDB on tmdb: ids is offered, marked as its own ids');
    assert.equal(manager.metadata.currentName, 'Cinemeta', 'stock Cinemeta is first, so it gives details pages');
    assert.deepEqual(manager.metadata.options.map((o) => o.name), ['Cinemeta', 'tmdb', 'Local Files', 'AIOMetadata', 'The Movie Database Addon']);
    const debrid = manager.addons.find((a) => a.name === 'debrid');
    await assert.rejects(service.setMetadataSource(original.id, debrid.ref, { base: manager.base }), (e) => e.code === 'NO_METADATA');

    const pick = manager.metadata.options.find((o) => o.name === 'AIOMetadata').ref;
    const result = await service.setMetadataSource(original.id, pick, { base: manager.base });
    assert.equal(result.sourceName, 'AIOMetadata');
    let list = saved(original.id).addons;
    assert.equal(list[0].manifest.name, 'AIOMetadata', 'moved to the top');
    const stock = list.find((a) => a.manifest.id === 'com.linvo.cinemeta').manifest;
    assert.equal(deriveSettings(stock).removeMeta, true, "Cinemeta's details off");
    assert.equal(deriveSettings(stock).hidePopular, false, 'its catalogs stay');
    manager = await service.addonManager(original.id);
    assert.equal(manager.metadata.currentName, 'AIOMetadata');
    assert.equal((await service.setMetadataSource(original.id, pick, { base: manager.base })).changed, false, 'picking the current one changes nothing');

    const cinemeta = manager.metadata.options.find((o) => o.name === 'Cinemeta').ref;
    await service.setMetadataSource(original.id, cinemeta, { base: manager.base });
    list = saved(original.id).addons;
    assert.equal(list[0].manifest.name, 'Cinemeta');
    assert.equal(deriveSettings(list[0].manifest).removeMeta, false, "Cinemeta's details back on");
  });

  it('a TMDB-ids-only setup: TMDB can be the source, and the warning says what that means', async () => {
    const { service, fake, saved, refs } = await setup({ localFiles: false });
    const tmdbIds = richAddon('The Movie Database Addon', {
      resources: ['catalog', 'meta'],
      catalogs: [{ type: 'movie', id: 'tmdb.search', name: 'Search', extra: [{ name: 'search', isRequired: true }] }],
    });
    tmdbIds.manifest.idPrefixes = ['tmdb:'];
    fake.addons = [...fake.addons, tmdbIds];
    // A profile with Cinemeta, the debrid add-on and TMDB on its own ids (nothing else gives details).
    const kids2 = await service.createProfile({ name: 'TMDB only', from: 'empty' });
    let editor = await service.editableAddons(kids2.id);
    await service.saveAddons(kids2.id, { base: editor.base, refs: refs(editor.addons.filter((a) => a.manifest.name !== 'tmdb')) });

    let manager = await service.addonManager(kids2.id);
    const pick = manager.metadata.options.find((o) => o.name === 'The Movie Database Addon').ref;
    const result = await service.setMetadataSource(kids2.id, pick, { base: manager.base });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /only for its own ids.*IMDb ids/);
    assert.equal(saved(kids2.id).addons[0].manifest.name, 'The Movie Database Addon');

    manager = await service.addonManager(kids2.id);
    assert.equal(manager.metadata.currentName, 'The Movie Database Addon', 'with nothing for IMDb ids, it is the source');
    assert.equal(manager.metadata.currentOwnIds, true);
  });

  it('reset puts the stock manifest back exactly', async () => {
    const { service, kids, saved } = await setup();
    let editor = await service.editableAddons(kids.id);
    await service.saveCinemeta(kids.id, { hidePopular: true, hideNew: true, hideFeatured: true, removeSearch: true, removeMeta: true }, { base: editor.base });
    editor = await service.editableAddons(kids.id);
    await service.resetCinemeta(kids.id, { base: editor.base });
    assert.deepEqual(saved(kids.id).addons[0].manifest, cinemetaManifest());
  });
});

describe('the new-profile wizard', () => {
  it('offers every add-on any profile has, and how each start is set', async () => {
    const { service, kids, refs } = await setup();
    const editor = await service.editableAddons(kids.id);
    await service.saveAddons(kids.id, { base: editor.base, refs: refs(editor.addons.filter((a) => a.manifest.name !== 'debrid')) });
    const options = await service.wizardOptions();
    assert.equal(options.activeName, 'Original');
    assert.deepEqual(options.pool.map((a) => a.name), ['Cinemeta', 'debrid', 'tmdb', 'Local Files']);
    assert.deepEqual(options.pool.find((a) => a.name === 'tmdb').from, ['Original', 'Kids']);
    assert.equal(options.starts.live.refs.length, 4);
    assert.equal(options.starts.profiles.find((p) => p.name === 'Kids').refs.length, 3);
    assert.deepEqual(options.starts.live.cinemeta.settings, STOCK_SETTINGS);
    assert.ok(options.pool.find((a) => a.name === 'Cinemeta').protected);
  });

  it('creates a profile with the picked add-ons, order, picture and Cinemeta, without touching Stremio', async () => {
    const { service, fake, saved } = await setup();
    const options = await service.wizardOptions();
    const byName = Object.fromEntries(options.pool.map((a) => [a.name, a.ref]));
    const before = fake.calls.filter((c) => c.method.endsWith('Set') || c.method === 'datastorePut').length;
    const p = await service.createProfile({
      name: 'Movie night', from: 'current', colour: '#3b8f4b', picture: 'char:spark',
      addonRefs: [byName.tmdb, byName.Cinemeta, byName['Local Files']],
      cinemeta: { ...STOCK_SETTINGS, hideNew: true, hideFeatured: true },
    });
    assert.equal(fake.calls.filter((c) => c.method.endsWith('Set') || c.method === 'datastorePut').length, before, 'no writes');
    assert.equal(p.avatar_preset, 'char:spark');
    const snap = saved(p.id);
    assert.deepEqual(names(snap.addons), ['tmdb', 'Cinemeta', 'Local Files']);
    assert.equal(deriveSettings(snap.addons[1].manifest).hideNew, true);
    assert.equal(snap.library.length, 2, 'a copy of the account');
  });

  it("copies another profile's saved state, and can switch to it right away", async () => {
    const { service, fake, kids } = await setup();
    const p = await service.createProfile({ name: 'Kids 2', from: 'profile', sourceProfileId: kids.id, switchNow: true });
    assert.equal(p.switched.profile.name, 'Kids 2');
    assert.equal(service.status().activeProfileId, p.id);
    assert.deepEqual(fake.activeIds(), [], 'Kids was empty');
  });

  it("won't drop Cinemeta, and says when a picked add-on is gone", async () => {
    const { service } = await setup();
    const options = await service.wizardOptions();
    const tmdb = options.pool.find((a) => a.name === 'tmdb').ref;
    await assert.rejects(service.createProfile({ name: 'X', from: 'empty', addonRefs: [tmdb] }), (e) => e.code === 'PROTECTED');
    await assert.rejects(service.createProfile({ name: 'X', from: 'empty', addonRefs: ['ffffffffffffffff'] }), (e) => e.code === 'ADDON_GONE');
  });

  it('warns when the new profile has no details pages', async () => {
    const { service } = await setup({ localFiles: false });
    const options = await service.wizardOptions();
    const byName = Object.fromEntries(options.pool.map((a) => [a.name, a.ref]));
    const noMeta = { ...STOCK_SETTINGS, removeMeta: true };
    const bare = await service.createProfile({ name: 'Bare', from: 'empty', addonRefs: [byName.Cinemeta, byName.debrid], cinemeta: noMeta });
    assert.deepEqual(bare.warnings, [NO_DETAILS_WARNING]);
    const ok = await service.createProfile({ name: 'With TMDB', from: 'empty', addonRefs: [byName.Cinemeta, byName.tmdb], cinemeta: noMeta });
    assert.deepEqual(ok.warnings, []);
  });
});
