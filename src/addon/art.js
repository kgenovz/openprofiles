import fs from 'node:fs';
import { createRequire } from 'node:module';
import opentype from 'opentype.js';
import sharp from 'sharp';
import { isBust, isPhoto, pictureSvg } from './avatars.js';

/**
 * Poster and background artwork, drawn as SVG paths from bundled
 * Figtree glyphs and rasterised with sharp. Using glyph paths (not SVG text)
 * means the output doesn't depend on whatever fonts the container has.
 * Specs: the "Poster tiles" and "Clips" artboards in the M2 design canvas.
 */

const require = createRequire(import.meta.url);
const WEIGHTS = [500, 700, 800];
const SUBSETS = ['latin', 'latin-ext'];

function loadFont(weight, subset) {
  const file = require.resolve(`@fontsource/figtree/files/figtree-${subset}-${weight}-normal.woff`);
  const buf = fs.readFileSync(file);
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

let fonts = null;
function fontsFor(weight) {
  fonts ??= Object.fromEntries(WEIGHTS.map((w) => [w, SUBSETS.map((s) => loadFont(w, s))]));
  return fonts[weight];
}

function glyphFor(char, weight) {
  for (const font of fontsFor(weight)) {
    const glyph = font.charToGlyph(char);
    if (glyph && glyph.index !== 0) return { font, glyph };
  }
  return null;
}

/** Characters the bundled fonts can draw; anything else is dropped. */
function drawable(text, weight) {
  return [...text].filter((ch) => ch === ' ' || glyphFor(ch, weight)).join('');
}

function measure(text, weight, size) {
  let width = 0;
  for (const ch of text) {
    const hit = glyphFor(ch, weight);
    if (hit) width += (hit.glyph.advanceWidth / hit.font.unitsPerEm) * size;
  }
  return width;
}

/** One line of text as an SVG path `d`, left edge at x, baseline at y. */
function linePath(text, weight, size, x, y) {
  let cursor = x;
  const parts = [];
  for (const ch of text) {
    const hit = glyphFor(ch, weight);
    if (!hit) continue;
    parts.push(hit.glyph.getPath(cursor, y, size).toPathData(2));
    cursor += (hit.glyph.advanceWidth / hit.font.unitsPerEm) * size;
  }
  return parts.join('');
}

/** Centred line whose visual (ink) middle sits on cy. */
function centredLine(text, weight, size, cx, cy) {
  const width = measure(text, weight, size);
  const x = cx - width / 2;
  // Cap height of Figtree is ~0.7em; centre on that rather than the full box.
  const baseline = cy + size * 0.35;
  return linePath(text, weight, size, x, baseline);
}

/** Shrink to fit down to `minScale`, then cut with an ellipsis. */
function fitLine(text, weight, size, maxWidth, minScale = 0.6) {
  let s = size;
  while (measure(text, weight, s) > maxWidth && s > size * minScale) s -= 1;
  if (measure(text, weight, s) <= maxWidth) return { text, size: s };
  let cut = [...text];
  while (cut.length > 1 && measure(`${cut.join('').trimEnd()}…`, weight, s) > maxWidth) cut = cut.slice(0, -1);
  return { text: `${cut.join('').trimEnd()}…`, size: s };
}

function initialOf(name) {
  const first = [...String(name).trim()][0];
  if (!first) return null;
  const upper = first.toLocaleUpperCase();
  return glyphFor(upper, 800) ? upper : null;
}

// Simple person glyph for names whose first letter the font can't draw.
function personPath(cx, cy, h) {
  const r = h * 0.2;
  const headY = cy - h * 0.18;
  const bodyTop = cy + h * 0.1;
  const w = h * 0.38;
  return `M${cx - r},${headY}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0Z` +
    `M${cx - w},${cy + h * 0.42}C${cx - w},${bodyTop} ${cx + w},${bodyTop} ${cx + w},${cy + h * 0.42}Z`;
}

function checkBadge(cx, cy, r) {
  const s = r / 30; // drawn on a 60 px badge in the design
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffffff"/>` +
    `<path d="M${cx - 14 * s},${cy + 1 * s}l${11 * s},${11 * s}l${19 * s},-${20 * s}" fill="none" stroke="#14141a" stroke-width="${8 * s}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

const svgDoc = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

const png = (svg) => sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();

export const POSTER_SIZE = 512;

/** The letter (or person glyph) centred on (cx, cy). */
function letterSvg(name, cx, cy, size) {
  const initial = initialOf(name);
  return initial
    ? `<path d="${centredLine(initial, 800, size, cx, cy)}" fill="#ffffff"/>`
    : `<path d="${personPath(cx, cy, size * 0.8)}" fill="#ffffff"/>`;
}

/** Picture or letter filling the area [0, areaH) of a W-wide image. */
function faceSvg({ name, avatar }, W, areaH) {
  if (avatar && avatar !== 'initial') {
    const size = Math.round(Math.min(W, areaH) * (isBust(avatar) ? 0.86 : 0.84));
    const x = Math.round((W - size) / 2);
    const y = isBust(avatar) ? areaH - size : Math.round((areaH - size) / 2);
    const svg = pictureSvg(avatar, { x, y, size });
    if (svg) return svg;
  }
  return letterSvg(name, W / 2, areaH / 2 + W * 0.03, W * 0.52);
}

/** An uploaded photo (JPEG bytes) filling a box, cropped to cover it. */
const photoSvg = (photo, w, h) => `<image href="data:image/jpeg;base64,${photo.toString('base64')}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>`;

/** `photo` is the profile's uploaded photo; it's only drawn when `avatar` is a 'photo:' preset. */
const usePhoto = (avatar, photo) => Boolean(photo && isPhoto(avatar));

/** Square picture tile (no name band) for the web page and the picture picker. */
export function avatarTileSvg({ name, colour, avatar, size = 256, photo = null }) {
  const face = usePhoto(avatar, photo) ? photoSvg(photo, size, size) : faceSvg({ name, avatar }, size, size);
  return svgDoc(size, size, `<rect width="${size}" height="${size}" fill="${colour}"/>${face}`);
}

export function posterSvg({ name, colour, active, avatar = 'initial', photo = null }) {
  const W = POSTER_SIZE;
  const bandH = Math.round(W * 0.22);
  // A photo fills the whole tile, under the name band.
  const glyph = usePhoto(avatar, photo) ? photoSvg(photo, W, W) : faceSvg({ name, avatar }, W, W - bandH);
  const label = drawable(String(name).trim(), 700);
  const fitted = fitLine(label, 700, W * 0.085, W * 0.88);
  const ring = active ? Math.round(W * 0.027) : 0;
  return svgDoc(W, W, [
    `<rect width="${W}" height="${W}" fill="${colour}"/>`,
    glyph,
    `<rect y="${W - bandH}" width="${W}" height="${bandH}" fill="#000000" fill-opacity="0.28"/>`,
    fitted.text ? `<path d="${centredLine(fitted.text, 700, fitted.size, W / 2, W - bandH / 2)}" fill="#ffffff"/>` : '',
    active ? `<rect x="${ring / 2}" y="${ring / 2}" width="${W - ring}" height="${W - ring}" fill="none" stroke="#ffffff" stroke-width="${ring}"/>` : '',
    active ? checkBadge(W - W * 0.06 - W * 0.1, W * 0.06 + W * 0.1, W * 0.1) : '',
  ].join(''));
}

export function backgroundSvg({ name, colour, avatar = 'initial', photo = null }) {
  const W = 1280;
  const H = 720;
  const initial = initialOf(name);
  const size = Math.round(H * 0.9);
  const picture = pictureSvg(avatar, { x: Math.round(W * 0.78 - size / 2), y: H - size, size });
  const faint = usePhoto(avatar, photo) ? `<g opacity="0.5">${photoSvg(photo, W, H)}</g>`
    : picture
    ? `<g opacity="0.22">${picture}</g>`
    : initial ? `<path d="${centredLine(initial, 800, H * 1.1, W * 0.78, H * 0.5)}" fill="#ffffff" fill-opacity="0.12"/>` : '';
  return svgDoc(W, H, [
    `<defs><linearGradient id="op-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></linearGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="${colour}"/>`,
    faint,
    `<rect width="${W}" height="${H}" fill="url(#op-bg)"/>`,
  ].join(''));
}

export const BRAND_COLOUR = '#8b6dff';

/** Add-on logo: two people on the brand colour (violet unless the owner picked another accent). */
export function logoSvg(colour = BRAND_COLOUR) {
  const W = 256;
  const fill = /^#[0-9a-f]{6}$/i.test(colour) ? colour : BRAND_COLOUR;
  return svgDoc(W, W, [
    `<rect width="${W}" height="${W}" rx="56" fill="${fill}"/>`,
    // The header icon from the design, drawn on a 24 px grid and scaled up.
    '<g fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" transform="translate(28 28) scale(8.33)">',
    '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6"/>',
    '<path d="M16 5.5a3 3 0 0 1 0 5.6M18 14.6c1.3.6 2.2 2 2.6 4.4"/></g>',
  ].join(''));
}

export const renderLogo = (colour) => png(logoSvg(colour));

export const LOGO_UPLOAD_MAX = 2 * 1024 * 1024;

/**
 * An uploaded logo, made safe to serve: decoded and drawn again as a fresh
 * 256 px square PNG, so nothing of the original file (metadata, scripts in an
 * SVG, a polyglot) survives. Only PNG, JPEG and WebP are read.
 */
export function normaliseLogo(buffer) {
  return redraw(buffer, LOGO_UPLOAD_MAX, (img) => img.resize(256, 256, { fit: 'cover' }).png({ compressionLevel: 9 }));
}

export const PHOTO_UPLOAD_MAX = 4 * 1024 * 1024;

/**
 * A profile photo, the same way: a fresh 512 px square JPEG (the poster's
 * size), cropped to the middle. The page script shrinks big phone photos
 * before uploading them.
 */
export function normalisePhoto(buffer) {
  return redraw(buffer, PHOTO_UPLOAD_MAX, (img) => img.resize(POSTER_SIZE, POSTER_SIZE, { fit: 'cover' }).jpeg({ quality: 85, mozjpeg: true }));
}

// Uploads are small pictures (the page shrinks photos first), but a few MB of PNG can claim a
// huge size and take hundreds of MB to decode. Bigger than this is refused before decoding.
const MAX_INPUT_PIXELS = 25_000_000;

/** Decode a PNG, JPEG or WebP (nothing else) and draw it again; null when it can't be read. */
async function redraw(buffer, maxBytes, finish) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > maxBytes) return null;
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    return null;
  }
  if (!['png', 'jpeg', 'webp'].includes(meta.format)) return null;
  if (!(meta.width * meta.height <= MAX_INPUT_PIXELS)) return null;
  try {
    return await finish(sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, pages: 1 }).rotate()).toBuffer();
  } catch {
    return null;
  }
}
export const renderPoster = (opts) => png(posterSvg(opts));
export const renderBackground = (opts) => png(backgroundSvg(opts));

/** Small in-memory cache: artwork only changes when a name, colour or active flag does. */
export class ArtCache {
  constructor(limit = 200) {
    this.limit = limit;
    this.map = new Map();
  }

  get(key, make) {
    if (this.map.has(key)) {
      const hit = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    const value = make().catch((err) => {
      this.map.delete(key);
      throw err;
    });
    this.map.set(key, value);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    return value;
  }
}
