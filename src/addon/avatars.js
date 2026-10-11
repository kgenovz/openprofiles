import { createAvatar } from '@dicebear/core';
import { lorelei, notionists, openPeeps, pixelArt, thumbs } from '@dicebear/collection';

/**
 * Profile pictures, from the "Profile pictures" artboard of the design canvas.
 * Stored in profiles.avatar_preset as one of:
 *   'initial'                  the first letter of the name
 *   'char:<id>'                a hand-drawn character below
 *   'gen:<style>:<seed>'       a generated face (DiceBear, CC0 styles only)
 */

const INK = '#14141a';

// Each is drawn on a 100×100 grid in white and ink over the profile colour.
export const CHARACTERS = {
  cat: {
    label: 'Cat',
    svg: `<path d="M22 46 L27 14 L47 32 Z M78 46 L73 14 L53 32 Z" fill="#fff"/>
<path d="M27 38 L30 22 L40 32 Z M73 38 L70 22 L60 32 Z" fill="#000" fill-opacity="0.14"/>
<ellipse cx="50" cy="57" rx="32" ry="28" fill="#fff"/>
<ellipse cx="38" cy="53" rx="4" ry="6" fill="${INK}"/><ellipse cx="62" cy="53" rx="4" ry="6" fill="${INK}"/>
<path d="M46 63 h8 l-4 5 z" fill="${INK}"/>
<path d="M50 68 q-4 5 -9 3 M50 68 q4 5 9 3" stroke="${INK}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
<path d="M22 62 h13 M23 69 l12 -3 M78 62 h-13 M77 69 l-12 -3" stroke="${INK}" stroke-opacity="0.5" stroke-width="2" stroke-linecap="round"/>`,
  },
  fox: {
    label: 'Fox',
    svg: `<path d="M16 16 L42 34 L24 52 Z M84 16 L58 34 L76 52 Z" fill="#fff"/>
<path d="M16 16 L28 24 L20 34 Z M84 16 L72 24 L80 34 Z" fill="${INK}"/>
<path d="M18 44 Q50 20 82 44 L57 82 Q50 90 43 82 Z" fill="#fff"/>
<path d="M18 44 Q50 20 82 44 Q66 58 50 55 Q34 58 18 44 Z" fill="#000" fill-opacity="0.12"/>
<ellipse cx="38" cy="51" rx="3.5" ry="5" fill="${INK}"/><ellipse cx="62" cy="51" rx="3.5" ry="5" fill="${INK}"/>
<ellipse cx="50" cy="80" rx="5" ry="4" fill="${INK}"/>`,
  },
  bear: {
    label: 'Bear',
    svg: `<circle cx="26" cy="30" r="12" fill="#fff"/><circle cx="74" cy="30" r="12" fill="#fff"/>
<circle cx="26" cy="30" r="6" fill="#000" fill-opacity="0.14"/><circle cx="74" cy="30" r="6" fill="#000" fill-opacity="0.14"/>
<circle cx="50" cy="56" r="32" fill="#fff"/>
<ellipse cx="50" cy="67" rx="14" ry="11" fill="#000" fill-opacity="0.1"/>
<circle cx="38" cy="50" r="4" fill="${INK}"/><circle cx="62" cy="50" r="4" fill="${INK}"/>
<ellipse cx="50" cy="62" rx="6" ry="4.5" fill="${INK}"/>
<path d="M50 66 v4 M44 71 q6 5 12 0" stroke="${INK}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`,
  },
  owl: {
    label: 'Owl',
    svg: `<path d="M25 28 L22 10 L37 19 Z M75 28 L78 10 L63 19 Z" fill="#fff"/>
<path d="M22 42 Q22 15 50 15 Q78 15 78 42 V70 Q78 90 50 90 Q22 90 22 70 Z" fill="#fff"/>
<circle cx="38" cy="43" r="12" fill="#000" fill-opacity="0.12"/><circle cx="62" cy="43" r="12" fill="#000" fill-opacity="0.12"/>
<circle cx="38" cy="43" r="6.5" fill="${INK}"/><circle cx="62" cy="43" r="6.5" fill="${INK}"/>
<circle cx="40" cy="41" r="2" fill="#fff"/><circle cx="64" cy="41" r="2" fill="#fff"/>
<path d="M45 53 L55 53 L50 62 Z" fill="${INK}"/>
<path d="M37 73 q4 4 8 0 M55 73 q4 4 8 0 M46 81 q4 4 8 0" stroke="#000" stroke-opacity="0.2" stroke-width="2.4" fill="none" stroke-linecap="round"/>`,
  },
  robot: {
    label: 'Robot',
    svg: `<path d="M50 13 V25" stroke="#fff" stroke-width="4" stroke-linecap="round"/><circle cx="50" cy="11" r="5" fill="#fff"/>
<rect x="11" y="44" width="11" height="20" rx="4" fill="#fff"/><rect x="78" y="44" width="11" height="20" rx="4" fill="#fff"/>
<rect x="19" y="24" width="62" height="60" rx="15" fill="#fff"/>
<rect x="27" y="38" width="46" height="25" rx="12.5" fill="${INK}"/>
<circle cx="40" cy="50.5" r="5" fill="#fff"/><circle cx="60" cy="50.5" r="5" fill="#fff"/>
<path d="M37 73 h26" stroke="${INK}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="0.1 6.5"/>`,
  },
  ghost: {
    label: 'Ghost',
    svg: `<path d="M24 87 V46 Q24 15 50 15 Q76 15 76 46 V87 L67 80 L59 87 L50 80 L41 87 L33 80 Z" fill="#fff"/>
<ellipse cx="40" cy="46" rx="5" ry="7" fill="${INK}"/><ellipse cx="60" cy="46" rx="5" ry="7" fill="${INK}"/>
<ellipse cx="50" cy="63" rx="5" ry="6" fill="${INK}"/>
<circle cx="32" cy="57" r="4" fill="#000" fill-opacity="0.1"/><circle cx="68" cy="57" r="4" fill="#000" fill-opacity="0.1"/>`,
  },
  alien: {
    label: 'Alien',
    svg: `<path d="M37 24 L28 10 M63 24 L72 10" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>
<circle cx="27" cy="9" r="4.5" fill="#fff"/><circle cx="73" cy="9" r="4.5" fill="#fff"/>
<path d="M50 18 C74 18 84 36 82 52 C80 72 62 90 50 90 C38 90 20 72 18 52 C16 36 26 18 50 18 Z" fill="#fff"/>
<path d="M27 50 Q33 37 46 48 Q42 63 27 50 Z M73 50 Q67 37 54 48 Q58 63 73 50 Z" fill="${INK}"/>
<path d="M44 74 q6 4 12 0" stroke="${INK}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`,
  },
  dino: {
    label: 'Dino',
    svg: `<path d="M28 28 L34 11 L42 25 L50 8 L58 25 L66 11 L72 28 Z" fill="#000" fill-opacity="0.2"/>
<path d="M21 50 Q21 22 50 22 Q79 22 79 50 V64 Q79 87 50 87 Q21 87 21 64 Z" fill="#fff"/>
<circle cx="31" cy="34" r="3" fill="#000" fill-opacity="0.1"/><circle cx="69" cy="36" r="2.5" fill="#000" fill-opacity="0.1"/>
<circle cx="38" cy="47" r="5" fill="${INK}"/><circle cx="62" cy="47" r="5" fill="${INK}"/>
<circle cx="39.5" cy="45.5" r="1.6" fill="#fff"/><circle cx="63.5" cy="45.5" r="1.6" fill="#fff"/>
<circle cx="45" cy="66" r="2.2" fill="${INK}"/><circle cx="55" cy="66" r="2.2" fill="${INK}"/>
<path d="M33 74 Q50 85 67 74" stroke="${INK}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`,
  },
  astronaut: {
    label: 'Astronaut',
    svg: `<circle cx="17" cy="48" r="4.5" fill="#fff"/><circle cx="83" cy="48" r="4.5" fill="#fff"/>
<circle cx="50" cy="48" r="34" fill="#fff"/>
<rect x="26" y="31" width="48" height="35" rx="17.5" fill="${INK}"/>
<path d="M34 43 q5 -7 14 -7" stroke="#fff" stroke-opacity="0.65" stroke-width="3" fill="none" stroke-linecap="round"/>
<rect x="30" y="80" width="40" height="10" rx="5" fill="#fff"/>
<rect x="30" y="80" width="40" height="10" rx="5" fill="#000" fill-opacity="0.14"/>`,
  },
  monster: {
    label: 'Monster',
    svg: `<path d="M30 32 L23 9 L42 25 Z M70 32 L77 9 L58 25 Z" fill="#fff"/>
<path d="M30 32 L23 9 L42 25 Z M70 32 L77 9 L58 25 Z" fill="#000" fill-opacity="0.12"/>
<path d="M18 89 V50 Q18 20 50 20 Q82 20 82 50 V89 L73 84 L64 89 L55 84 L45 89 L36 84 L27 89 Z" fill="#fff"/>
<circle cx="50" cy="48" r="14" fill="#000" fill-opacity="0.1"/>
<circle cx="50" cy="48" r="8.5" fill="${INK}"/><circle cx="53" cy="45" r="2.6" fill="#fff"/>
<path d="M35 66 Q50 80 65 66 Z" fill="${INK}"/>
<path d="M42 67 l3 4.5 l3 -4.5 Z M52 67 l3 4.5 l3 -4.5 Z" fill="#fff"/>`,
  },
  // Claude's self-portrait: a soft eight-armed spark with a calm face.
  spark: {
    label: 'Spark',
    svg: `<g fill="#faf9f5">
<rect x="43" y="7" width="14" height="86" rx="7"/>
<rect x="43" y="7" width="14" height="86" rx="7" transform="rotate(45 50 50)"/>
<rect x="43" y="7" width="14" height="86" rx="7" transform="rotate(90 50 50)"/>
<rect x="43" y="7" width="14" height="86" rx="7" transform="rotate(135 50 50)"/>
<circle cx="50" cy="50" r="27"/></g>
<path d="M38 49 q4.5 -5 9 0 M53 49 q4.5 -5 9 0" stroke="${INK}" stroke-width="2.8" fill="none" stroke-linecap="round"/>
<path d="M43 58 q7 6 14 0" stroke="${INK}" stroke-width="2.8" fill="none" stroke-linecap="round"/>
<circle cx="36" cy="57" r="3.8" fill="#d97757" fill-opacity="0.6"/><circle cx="64" cy="57" r="3.8" fill="#d97757" fill-opacity="0.6"/>`,
  },
};

const FRIENDLY_PEEP_FACES = ['awe', 'calm', 'cheeky', 'cute', 'driven', 'eatingHappy', 'explaining', 'eyesClosed',
  'lovingGrin1', 'lovingGrin2', 'smile', 'smileBig', 'smileLOL', 'smileTeethGap'];

// Public-domain (CC0 1.0) DiceBear styles only, so nothing needs a credit line.
export const GENERATED_STYLES = {
  lorelei: { label: 'Lorelei', style: lorelei, options: {} },
  notionists: { label: 'Notionists', style: notionists, options: {} },
  openPeeps: { label: 'Open Peeps', style: openPeeps, options: { face: FRIENDLY_PEEP_FACES, maskProbability: 0 } },
  pixelArt: { label: 'Pixel Art', style: pixelArt, options: {} },
  // Pale shapes only, so they show up on every profile colour.
  thumbs: { label: 'Thumbs', style: thumbs, options: { shapeColor: ['faf9f5', 'ffd5dc', 'ffdfbf', 'd1f4d9', 'fff3b0'] } },
};

const SEED_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function parseAvatar(preset) {
  if (preset === 'initial') return { kind: 'initial' };
  const parts = String(preset).split(':');
  const [kind, a, b] = parts;
  if (kind === 'char' && parts.length === 2 && Object.hasOwn(CHARACTERS, a)) return { kind: 'char', id: a };
  if (kind === 'gen' && parts.length === 3 && Object.hasOwn(GENERATED_STYLES, a) && SEED_RE.test(b)) return { kind: 'gen', style: a, seed: b };
  return null;
}

export function isValidAvatar(preset) {
  return parseAvatar(preset) !== null;
}

export function avatarLabel(preset) {
  const p = parseAvatar(preset);
  if (!p || p.kind === 'initial') return 'Letter';
  if (p.kind === 'char') return CHARACTERS[p.id].label;
  return `${GENERATED_STYLES[p.style].label} face`;
}

/**
 * The picture as an <svg> element placed in a box, for nesting inside a
 * larger SVG. Returns null for 'initial' (the caller draws the letter).
 * `bottom` = the picture is a bust that should sit on the box's bottom edge.
 */
export function pictureSvg(preset, { x, y, size }) {
  const p = parseAvatar(preset);
  if (!p || p.kind === 'initial') return null;
  if (p.kind === 'char') {
    return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 100 100">${CHARACTERS[p.id].svg}</svg>`;
  }
  const { style, options } = GENERATED_STYLES[p.style];
  // Transparent so every style sits on the profile colour (Thumbs paints its own otherwise).
  const svg = createAvatar(style, { seed: p.seed, backgroundColor: ['transparent'], ...options }).toString();
  return svg.replace(/^<\?xml[^>]*>\s*/, '').replace(/^<svg\b/, `<svg x="${x}" y="${y}" width="${size}" height="${size}"`);
}

/** Generated faces are portraits that sit on the bottom edge; characters float centred. */
export function isBust(preset) {
  return parseAvatar(preset)?.kind === 'gen';
}

export function randomSeed() {
  return Math.random().toString(36).slice(2, 10);
}
