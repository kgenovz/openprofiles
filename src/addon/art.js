import fs from 'node:fs';
import { createRequire } from 'node:module';
import opentype from 'opentype.js';
import sharp from 'sharp';

/**
 * Poster, background and clip-frame artwork, drawn as SVG paths from bundled
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

export function posterSvg({ name, colour, active }) {
  const W = POSTER_SIZE;
  const bandH = Math.round(W * 0.22);
  const initial = initialOf(name);
  const glyph = initial
    ? `<path d="${centredLine(initial, 800, W * 0.52, W / 2, (W - bandH) / 2 + W * 0.03)}" fill="#ffffff"/>`
    : `<path d="${personPath(W / 2, (W - bandH) / 2, W * 0.42)}" fill="#ffffff"/>`;
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

export function backgroundSvg({ name, colour }) {
  const W = 1280;
  const H = 720;
  const initial = initialOf(name);
  return svgDoc(W, H, [
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></linearGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="${colour}"/>`,
    initial ? `<path d="${centredLine(initial, 800, H * 1.1, W * 0.78, H * 0.5)}" fill="#ffffff" fill-opacity="0.12"/>` : '',
    `<rect width="${W}" height="${H}" fill="url(#g)"/>`,
  ].join(''));
}

/** 1280×720 still for the switching / error clips. */
export function clipFrameSvg({ kind }) {
  const W = 1280;
  const H = 720;
  const ok = kind === 'switching';
  const title = ok ? 'Profile switched' : "Couldn't switch";
  const sub = ok
    ? ['Close and reopen Stremio to see it.']
    : ['The reason is under the stream in the list.', 'The OpenProfiles page has the details.'];
  const r = 87;
  const subLineH = 57;
  const blockH = 2 * r + 45 + 84 + 45 + sub.length * subLineH;
  const top = (H - blockH) / 2;
  const cy = top + r;
  const titleY = top + 2 * r + 45 + 42;
  const icon = ok
    ? `<path d="M${W / 2 - 34},${cy + 2}l25,25l45,-47" fill="none" stroke="#ffffff" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="M${W / 2},${cy - 35}v35M${W / 2},${cy + 33}v1" fill="none" stroke="#ffffff" stroke-width="16" stroke-linecap="round"/>`;
  return svgDoc(W, H, [
    `<rect width="${W}" height="${H}" fill="#0f0f14"/>`,
    `<circle cx="${W / 2}" cy="${cy}" r="${r}" fill="${ok ? '#8b6dff' : '#e5484d'}"/>`,
    icon,
    `<path d="${centredLine(title, 800, 70, W / 2, titleY)}" fill="#ffffff"/>`,
    ...sub.map((line, i) => `<path d="${centredLine(line, 500, 41, W / 2, titleY + 42 + 45 + subLineH / 2 + i * subLineH)}" fill="#c4c4cf"/>`),
  ].join(''));
}

/** Add-on logo: two people on the brand violet. */
export function logoSvg() {
  const W = 256;
  return svgDoc(W, W, [
    `<rect width="${W}" height="${W}" rx="56" fill="#8b6dff"/>`,
    // The header icon from the design, drawn on a 24 px grid and scaled up.
    '<g fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" transform="translate(28 28) scale(8.33)">',
    '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6"/>',
    '<path d="M16 5.5a3 3 0 0 1 0 5.6M18 14.6c1.3.6 2.2 2 2.6 4.4"/></g>',
  ].join(''));
}

export const renderLogo = () => png(logoSvg());
export const renderPoster = (opts) => png(posterSvg(opts));
export const renderBackground = (opts) => png(backgroundSvg(opts));
export const renderClipFrame = (opts) => png(clipFrameSvg(opts));

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
