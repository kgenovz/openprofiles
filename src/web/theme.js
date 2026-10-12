// The owner's accent colour as a small stylesheet (/theme.css), loaded after
// app.css. The page's CSP allows no inline <style>, so it is served like a file.
// Text colours are derived from the accent so links and button labels stay
// readable (WCAG 4.5:1) on both the light and the dark page.

const LIGHT_SURFACES = ['#ffffff', '#f4f4f7'];
const DARK_SURFACES = ['#1c1c22', '#121216'];

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const mix = (hex, toward, t) => {
  const a = rgb(hex);
  const b = rgb(toward);
  return toHex(a.map((v, i) => v + (b[i] - v) * t));
};

/** The accent moved toward black (or white) just far enough to read on every surface given. */
function readableOn(hex, surfaces, toward) {
  for (let t = 0; t <= 1; t += 0.05) {
    const c = mix(hex, toward, t);
    if (surfaces.every((s) => contrast(c, s) >= 4.5)) return c;
  }
  return toward;
}

/** White or near-black label, whichever reads better on the accent. */
export const textOn = (hex) => (contrast(hex, '#ffffff') >= contrast(hex, '#1b1b1f') ? '#ffffff' : '#1b1b1f');

/**
 * Button colours for an accent. A mid-tone accent (most picks) keeps white
 * labels and is darkened just enough for them to read; a light one (yellow,
 * say) keeps its colour and gets a dark label.
 */
export function buttonColours(hex) {
  if (contrast(hex, '#ffffff') < 3) return { background: hex, text: '#1b1b1f' };
  return { background: readableOn(hex, ['#ffffff'], '#000000'), text: '#ffffff' };
}

/** CSS for a custom accent, or '' to keep the designed colours. */
export function themeCss({ accent } = {}) {
  if (!accent || !/^#[0-9a-f]{6}$/i.test(accent)) return '';
  const a = accent.toLowerCase();
  const button = buttonColours(a);
  const shared = `--accent: ${button.background}; --accent-text: ${button.text};`;
  const light = `${shared} --link: ${readableOn(a, LIGHT_SURFACES, '#000000')};`;
  const dark = `${shared} --link: ${readableOn(a, DARK_SURFACES, '#ffffff')};`;
  return [
    `:root { ${light} --brand: ${a}; --brand-text: ${textOn(a)}; }`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark} } }`,
    `:root[data-theme="dark"] { ${dark} }`,
    '',
  ].join('\n');
}
