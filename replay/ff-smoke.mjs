#!/usr/bin/env node
// Firefox smoke for the record → R → render flow.
//
// A real user rendered in Firefox and got a 30Hz strobe: with
// preserveDrawingBuffer:false, Firefox returned an EMPTY WebGL buffer on
// alternate drawImage reads, so half the film's frames lost the creature.
// Chrome lost the same lottery only ~5 frames per 2000 (the one-frame frost
// flicker). The ?render boot now creates the context with
// preserveDrawingBuffer:true, which makes the read defined in every engine —
// this smoke proves the flow end-to-end on the second engine and measures the
// strobe signature directly on the encoded film.
//
//   node replay/ff-smoke.mjs [url] [playSeconds]

import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const pwRoot = process.env.PLAYWRIGHT_PATH ?? 'playwright';
const { firefox } = await import(pwRoot);

const BASE = process.argv[2] ?? 'http://localhost:8141';
const PLAY_SECONDS = Number(process.argv[3] ?? 35);
const OUT_DIR = resolve('replay/out');
mkdirSync(OUT_DIR, { recursive: true });

const browser = await firefox.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, acceptDownloads: true,
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || t.startsWith('[replay]') || t.startsWith('[rec]')) {
    console.log(`  [ff:${m.type()}] ${t.slice(0, 200)}`);
  }
});
const downloads = [];
page.on('download', (d) => downloads.push(d));

console.log(`[ff] loading ${BASE}/?rec&seed=777`);
await page.goto(`${BASE}/?rec&seed=777`, { waitUntil: 'commit' });
await page.waitForFunction(() => window.__rec && window.__cuttle && document.getElementById('startButton'), null, { timeout: 180000 });
await page.waitForTimeout(3000);
await page.click('#startButton');
await page.waitForFunction(() => window.__rec.recording === true, null, { timeout: 8000 });
console.log('[ff] recording; playing', PLAY_SECONDS, 's');
await page.waitForTimeout(PLAY_SECONDS * 1000);

// one real click near the initial oat's screen position; try a few offsets —
// a uv just off a chart island maps to no world point (uvToWorld null)
const cand = await page.evaluate(() => {
  const c = window.__cuttle;
  const b = c.oats[0].uv;
  for (const [du, dv] of [[0.06, 0.02], [-0.06, 0.02], [0.02, 0.06], [0.06, -0.03], [-0.05, -0.05]]) {
    const w = c.uvToWorld({ x: b.x + du, y: b.y + dv });
    if (!w) continue;
    const s2 = c.projectWorldToScreen(w);
    if (s2.inClip) return { sx: Math.round(s2.x), sy: Math.round(s2.y) };
  }
  return null;
});
if (cand) { await page.mouse.click(cand.sx, cand.sy); await page.waitForTimeout(300); }
const events = await page.evaluate(() => window.__rec.toJSON().events.length);

await page.keyboard.press('r');
await page.waitForSelector('.replay-panel', { timeout: 5000 });
let cvr = null;
for (let i = 0; i < 40 && !cvr; i++) {
  cvr = downloads.find((d) => d.suggestedFilename().endsWith('.cvr')) ?? null;
  if (!cvr) await page.waitForTimeout(250);
}
console.log('[ff] banked:', cvr?.suggestedFilename() ?? 'NONE');

await page.selectOption('#rp-res', '854x480');
await page.selectOption('#rp-fps', '30');
await page.click('#rp-go');
await page.waitForURL(/render/, { timeout: 30000 });
console.log('[ff] rendering…');
const t0 = Date.now();
let phase = '';
for (;;) {
  await page.waitForTimeout(2000);
  const st = await page.evaluate(() => window.__replayStatus ?? null).catch(() => null);
  if ((st?.phase ?? '') !== phase) { phase = st?.phase ?? '?'; console.log('[ff] phase:', phase); }
  if (phase === 'done' || phase === 'error') break;
  if (Date.now() - t0 > 600000) { console.error('FF FAIL: render timeout'); process.exit(1); }
}
const status = await page.evaluate(() => window.__replayStatus);
if (status.phase === 'error') {
  console.error('FF RENDER UNAVAILABLE:', String(status.error).slice(0, 300));
  console.error('(the game/record/bank path above still passed; encode support is engine-dependent)');
  process.exit(3);
}

let mp4 = null;
for (let i = 0; i < 120 && !mp4; i++) {
  mp4 = downloads.find((d) => d.suggestedFilename().endsWith('.mp4')) ?? null;
  if (!mp4) await page.waitForTimeout(500);
}
if (!mp4) { console.error('FF FAIL: no mp4 download'); process.exit(1); }
const mp4Path = resolve(OUT_DIR, 'ff-smoke.mp4');
await mp4.saveAs(mp4Path);
await browser.close();

// Strobe metric: fraction of frames whose whole-frame luminance changes >12%
// against the previous frame. The broken Firefox film measured 53 such swings
// including runs at EVERY OTHER frame; a healthy film has ~0.
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', mp4Path]).toString());
const v = probe.streams.find((s) => s.codec_type === 'video');
const gray = execFileSync('ffmpeg', ['-v', 'quiet', '-i', mp4Path, '-vf', 'scale=320:180,format=gray', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 30 });
const FRAME = 320 * 180;
const n = Math.floor(gray.length / FRAME);
const vals = [];
for (let i = 0; i < n; i++) {
  let s = 0;
  for (let j = 0; j < FRAME; j += 5) s += gray[i * FRAME + j];
  vals.push(s);
}
let swings = 0;
for (let i = 1; i < n; i++) {
  if (vals[i - 1] > FRAME && Math.abs(vals[i] - vals[i - 1]) / vals[i - 1] > 0.12) swings++;
}
const dur = Number(probe.format.duration);
console.log(`[ff] film: ${v.codec_name} ${v.width}x${v.height} ${dur.toFixed(1)}s, ${n} frames, luminance swings >12%: ${swings}`);
const pass = v.codec_name === 'h264' && swings <= 2 && pageErrors.length === 0 && events >= 1 && !!cvr;
console.log(pass ? 'FF SMOKE PASS' : `FF SMOKE FAIL (swings=${swings} errors=${JSON.stringify(pageErrors.slice(0, 3))} events=${events} cvr=${!!cvr})`);
process.exit(pass ? 0 : 1);
