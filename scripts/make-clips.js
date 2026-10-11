// Regenerates assets/clips/*.mp4 from the clip frames in src/addon/art.js.
// Needs the ffmpeg-static dev dependency. The clips are committed, so this
// only runs when their design changes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';
import { renderClipFrame } from '../src/addon/art.js';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'clips');
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'op-clips-'));

for (const [kind, file] of [['switching', 'switching.mp4'], ['error', 'switch-error.mp4']]) {
  const frame = path.join(tmp, `${kind}.png`);
  fs.writeFileSync(frame, await renderClipFrame({ kind }));
  execFileSync(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-loop', '1', '-framerate', '25', '-i', frame,
    '-t', '4',
    '-vf', 'fade=t=in:st=0:d=0.4,format=yuv420p',
    '-c:v', 'libx264', '-tune', 'stillimage', '-preset', 'veryslow', '-crf', '28',
    '-movflags', '+faststart', '-an',
    path.join(outDir, file),
  ]);
  console.log(`${file}: ${fs.statSync(path.join(outDir, file)).size} bytes`);
}
fs.rmSync(tmp, { recursive: true, force: true });
