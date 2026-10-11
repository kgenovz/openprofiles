import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { avatarTileSvg, renderPoster } from '../src/addon/art.js';
import { CHARACTERS, GENERATED_STYLES, isValidAvatar, parseAvatar, pictureSvg } from '../src/addon/avatars.js';
import { linkedWithKids } from './helpers/setup.js';

describe('avatars', () => {
  it('accepts the three kinds and nothing else', () => {
    assert.deepEqual(parseAvatar('initial'), { kind: 'initial' });
    assert.deepEqual(parseAvatar('char:spark'), { kind: 'char', id: 'spark' });
    assert.deepEqual(parseAvatar('gen:lorelei:abc_12'), { kind: 'gen', style: 'lorelei', seed: 'abc_12' });
    for (const bad of ['', 'char:', 'char:toString', 'char:dragon', 'gen:lorelei:', 'gen:adventurer:x', 'gen:lorelei:<svg>', 'gen:lorelei:a:b', null]) {
      assert.equal(isValidAvatar(bad), false, String(bad));
    }
  });

  it('only offers public-domain generator styles', () => {
    for (const { style } of Object.values(GENERATED_STYLES)) assert.equal(style.meta.license.name, 'CC0 1.0');
  });

  it('every character and style renders to a poster PNG', async () => {
    const presets = [...Object.keys(CHARACTERS).map((id) => `char:${id}`), ...Object.keys(GENERATED_STYLES).map((s) => `gen:${s}:seed1`)];
    for (const avatar of presets) {
      const meta = await sharp(await renderPoster({ name: 'Kids', colour: '#d6409f', active: false, avatar })).metadata();
      assert.equal(meta.width, 512, avatar);
    }
  });

  it('the same seed always gives the same face', () => {
    const a = pictureSvg('gen:notionists:same', { x: 0, y: 0, size: 100 });
    const b = pictureSvg('gen:notionists:same', { x: 0, y: 0, size: 100 });
    assert.equal(a, b);
    assert.match(avatarTileSvg({ name: 'K', colour: '#0a7fe0', avatar: 'initial' }), /<path/);
  });

  it('setAvatar stores a valid picture and refuses an unknown one', async () => {
    const { service, repo, kids } = await linkedWithKids();
    service.setAvatar(kids.id, '#d6409f', 'char:spark');
    assert.equal(repo.getProfile(kids.id).avatar_preset, 'char:spark');
    service.setAvatar(kids.id, '#0a7fe0');
    assert.equal(repo.getProfile(kids.id).avatar_preset, 'char:spark', 'colour-only change keeps the picture');
    assert.throws(() => service.setAvatar(kids.id, '#0a7fe0', 'char:dragon'), (e) => e.code === 'BAD_INPUT');
  });
});
