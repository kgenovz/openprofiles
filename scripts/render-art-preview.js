// Writes sample posters and backgrounds to ./art-preview/ for a visual check.
import fs from 'node:fs';
import path from 'node:path';
import { renderBackground, renderPoster } from '../src/addon/art.js';

const out = path.resolve(process.argv[2] || 'art-preview');
fs.mkdirSync(out, { recursive: true });
const samples = [
  { name: 'Original', colour: '#0a7fe0', active: true },
  { name: 'Kids', colour: '#d6409f', active: false },
  { name: 'Saturday cartoons with Grandma', colour: '#8e4ec6', active: false },
  { name: 'Łukasz', colour: '#b7790b', active: false },
  { name: '映画', colour: '#3b8f4b', active: false },
];
for (const [i, s] of samples.entries()) {
  fs.writeFileSync(path.join(out, `poster-${i}.png`), await renderPoster(s));
}
fs.writeFileSync(path.join(out, 'background.png'), await renderBackground(samples[1]));
console.log(`Wrote previews to ${out}`);
