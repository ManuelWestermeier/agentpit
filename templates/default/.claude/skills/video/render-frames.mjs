#!/usr/bin/env node
// Renders an HTML scene frame by frame and pipes the frames into ffmpeg.
// The page must define window.renderFrame(tSeconds) (may return a Promise).
//
//   node render-frames.mjs <scene.html> <out.mp4> [--duration 10] [--fps 30] [--size 1920x1080]
//                          [--crf 18] [--browser chrome|msedge] [--quality 92]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const [scene, out] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!scene || !out) {
  console.error('Aufruf: node render-frames.mjs <scene.html> <out.mp4> [--duration 10] [--fps 30] [--size 1920x1080]');
  process.exit(2);
}
const duration = Number(opt('duration', '10'));
const fps = Number(opt('fps', '30'));
const [width, height] = opt('size', '1920x1080').split('x').map(Number);
const crf = opt('crf', '18');
const quality = Number(opt('quality', '92'));
if (!(duration > 0 && fps > 0 && width > 0 && height > 0)) { console.error('Ungültige Parameter'); process.exit(2); }

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('playwright-core fehlt. Im Projektordner ausführen: npm i -D playwright-core');
  process.exit(3);
}

const channels = [opt('browser', process.env.BROWSER_CHANNEL || ''), 'chrome', 'msedge'].filter(Boolean);
let browser;
for (const channel of channels) {
  try { browser = await chromium.launch({ channel }); break; } catch { /* try next */ }
}
if (!browser) { console.error('Weder Chrome noch Edge gefunden.'); process.exit(4); }

const tmp = `${out}.tmp.mp4`;
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
const ff = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', crf, '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', tmp],
{ stdio: ['pipe', 'inherit', 'inherit'] });
const ffDone = new Promise((resolve) => ff.on('close', resolve));

try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.resolve(scene)).href);
  await page.waitForFunction(() => typeof window.renderFrame === 'function', null, { timeout: 15_000 });
  await page.evaluate(() => document.fonts?.ready);
  const frames = Math.round(duration * fps);
  const started = Date.now();
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.renderFrame(t), i / fps);
    const buf = await page.screenshot({ type: 'jpeg', quality });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % fps === 0) process.stdout.write(`\rFrame ${i + 1}/${frames} (${Math.round(((i + 1) / ((Date.now() - started) / 1000)) * 10) / 10} fps)`);
  }
  process.stdout.write('\n');
} finally {
  ff.stdin.end();
  await browser.close();
}
const code = await ffDone;
if (code !== 0) { console.error(`ffmpeg beendet mit Code ${code}`); process.exit(code || 1); }
fs.renameSync(tmp, out);
console.log(`Fertig: ${out}`);
