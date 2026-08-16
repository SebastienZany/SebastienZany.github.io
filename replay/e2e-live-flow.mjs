#!/usr/bin/env node
// End-to-end proof of the SHIPPED flow, on static-host semantics:
//
//   ?rec → Begin → play (earn a story callout) → R → render panel →
//   Render → reload into ?render&auto=1 → IndexedDB hand-off →
//   in-browser replay + WebCodecs encode → MP4 arrives as a DOWNLOAD.
//
// This is the exact path a visitor on bestiaryofvanishings.com takes; the dev
// server's /__save and /replay/out shortcuts must both be absent, which the
// script asserts up front. The finished MP4 is saved next to this script's out/
// dir and probed: h264 + aac streams, the chosen fps and geometry, and a
// duration that matches what the replay reported.
//
//   node replay/e2e-live-flow.mjs [url] [playSeconds]

import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const pwRoot = process.env.PLAYWRIGHT_PATH ?? 'playwright';
const { chromium } = await import(pwRoot);

const BASE = process.argv[2] ?? 'http://localhost:8141';
const PLAY_SECONDS = Number(process.argv[3] ?? 80);
const PLACE_AT = 45;
const SEED = 31337;
const OUT_DIR = resolve('replay/out');
mkdirSync(OUT_DIR, { recursive: true });

// Refuse to "pass" against the dev server — its POST endpoints would mask the
// static-host delivery path this test exists to prove.
{
  const res = await fetch(`${BASE}/__save?name=probe`, { method: 'POST', body: 'x' }).catch(() => null);
  if (res && res.ok) {
    console.error('ABORT: this looks like the dev server (POST /__save succeeded). Run against a plain static server.');
    process.exit(2);
  }
}

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync'],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, acceptDownloads: true,
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || t.startsWith('[replay]') || t.startsWith('[rec]')) {
    console.log(`  [page:${m.type()}] ${t.slice(0, 220)}`);
  }
});

// Strongest-slime candidates projected to screen; oats are placed with REAL
// mouse clicks. Placing through the console API is exactly the shortcut that
// let a broken recorder pass its tests while real players' clicks vanished.
const CANDS_FN = `(maxCands) => {
  const c = window.__cuttle;
  const h2f = (h) => {
    const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
    if (e === 0) return s * 6.103515625e-5 * (f / 1024);
    if (e === 0x1f) return NaN;
    return s * 2 ** (e - 15) * (1 + f / 1024);
  };
  const rt = c.renderSampleViewRT?.read ?? c.fieldRT.read;
  const size = rt.width, half = 160, win = 2 * half;
  const b = c.oats[0].uv;
  const x0 = Math.max(0, Math.min(size - win, Math.round(b.x * size) - half));
  const y0 = Math.max(0, Math.min(size - win, Math.round(b.y * size) - half));
  const buf = new Uint16Array(win * win * 4);
  try { c.renderer.readRenderTargetPixels(rt, x0, y0, win, win, buf); } catch (e) { return []; }
  const raw = [];
  for (let j = 0; j < win; j += 3) for (let i = 0; i < win; i += 3) {
    const val = h2f(buf[(j * win + i) * 4]);
    if (val > 0.004) raw.push({ u: (x0 + i) / size, v: (y0 + j) / size, val });
  }
  raw.sort((p, q2) => q2.val - p.val);
  const picked = [];
  for (const cand of raw) {
    let ok = true;
    for (const o of c.oats) {
      if (!o.uv) continue;
      const du = cand.u - o.uv.x, dv = cand.v - o.uv.y;
      if (du * du + dv * dv < 0.053 * 0.053) { ok = false; break; }
    }
    for (const p of picked) {
      const du = cand.u - p.u, dv = cand.v - p.v;
      if (du * du + dv * dv < 0.053 * 0.053) { ok = false; break; }
    }
    if (!ok) continue;
    const w = c.uvToWorld({ x: cand.u, y: cand.v });
    if (!w) continue;   // slime glow just off a chart island — not clickable
    const s2 = c.projectWorldToScreen(w);
    if (!s2.inClip) continue;
    picked.push({ u: +cand.u.toFixed(4), v: +cand.v.toFixed(4),
                  sx: Math.round(s2.x), sy: Math.round(s2.y) });
    if (picked.length >= maxCands) break;
  }
  return picked;
}`;

async function placeByRealClicks(want) {
  const cands = await page.evaluate(`(${CANDS_FN})(24)`);
  const placed = [];
  for (const cand of cands) {
    if (placed.length >= want) break;
    const before = await page.evaluate(() => window.__cuttle.oats.length);
    await page.mouse.click(cand.sx, cand.sy);
    await page.waitForTimeout(180);
    const after = await page.evaluate(() => window.__cuttle.oats.length);
    if (after > before) placed.push({ ...cand, accepted: true });
  }
  return placed;
}

// ---- 1. play a session under ?rec ----
console.log(`[e2e] loading ${BASE}/?rec&seed=${SEED}`);
await page.goto(`${BASE}/?rec&seed=${SEED}`, { waitUntil: 'commit' });
await page.waitForFunction(() => window.__rec && window.__cuttle && document.getElementById('startButton'), null, { timeout: 120000 });
await page.waitForTimeout(3000);
console.log('[e2e] pressing Begin');
await page.click('#startButton');
await page.waitForFunction(() => window.__rec.recording === true, null, { timeout: 5000 });

// Both deliveries are downloads now: the .cvr banked the moment R is pressed,
// then the finished .mp4. Collect everything.
const downloads = [];
page.on('download', (d) => downloads.push(d));

let firstCalloutAtTick = null;
let placed = [];
for (let s = 1; s <= PLAY_SECONDS; s++) {
  await page.waitForTimeout(1000);
  if (s === PLACE_AT) {
    placed = await placeByRealClicks(4);
    console.log(`[e2e] t=${s}s placed by real clicks:`, JSON.stringify(placed));
  }
  if (s % 15 === 0 || s === PLAY_SECONDS) {
    const st = await page.evaluate(() => ({
      tick: window.__rec.tick,
      oats: window.__cuttle.oats.length,
      triggered: window.__cuttle.oats.filter((o) => o.observation?.triggered).length,
      callout: [...document.querySelectorAll('.observation-callout')]
        .some((n) => Number(getComputedStyle(n).opacity) > 0.6),
    }));
    console.log(`[e2e] t=${s}s`, JSON.stringify(st));
    if (st.callout && firstCalloutAtTick == null) firstCalloutAtTick = st.tick;
  }
}
const sessionInfo = await page.evaluate(() => ({
  tick: window.__rec.tick,
  triggered: window.__cuttle.oats.filter((o) => o.observation?.triggered).length,
  // The trap this suite exists for: real clicks MUST be in the event log.
  addOatEvents: window.__rec.toJSON().events.filter((e) => e.type === 'addOat'),
}));
if (!sessionInfo.triggered) console.log('[e2e] WARNING: no story callout earned this session — text cannot be verified in the film');
if (placed.length && sessionInfo.addOatEvents.length < placed.length) {
  console.error(`FAIL EARLY: ${placed.length} real-click placements but only `
    + `${sessionInfo.addOatEvents.length} addOat events in the recording — the recorder is `
    + 'missing real player input again. Aborting before wasting a render.');
  process.exit(1);
}

// ---- 2. R opens the panel and freezes the world ----
await page.keyboard.press('r');
await page.waitForSelector('.replay-panel', { timeout: 5000 });
const frozen = await page.evaluate(() => ({
  simulateEnabled: window.__cuttle.getSimulateEnabled?.(),
  paused: window.__replayPaused === true,
  note: document.querySelector('.replay-panel__note')?.textContent?.slice(0, 120) ?? null,
}));
console.log('[e2e] panel open:', JSON.stringify(frozen));
if (frozen.simulateEnabled !== false || !frozen.paused) {
  console.error('FAIL: panel did not freeze the world');
  process.exit(1);
}

// Pressing R must immediately bank the session: a recognizably-named .cvr
// download, before the user chooses anything in the panel.
let cvrDownload = null;
for (let i = 0; i < 40 && !cvrDownload; i++) {
  cvrDownload = downloads.find((d) => d.suggestedFilename().endsWith('.cvr')) ?? null;
  if (!cvrDownload) await page.waitForTimeout(250);
}
const cvrName = cvrDownload?.suggestedFilename() ?? null;
console.log('[e2e] banked .cvr:', cvrName);
if (cvrDownload) await cvrDownload.saveAs(resolve(OUT_DIR, 'e2e-banked.cvr'));

// Keep the test cheap: small output, 30fps. (The shipped default is 60.)
await page.selectOption('#rp-res', '854x480');
await page.selectOption('#rp-fps', '30');

// ---- 3. Render: reload into ?render&auto=1, IndexedDB hand-off, download ----
await page.click('#rp-go');
await page.waitForURL(/render/, { timeout: 30000 });
console.log('[e2e] reloaded into render mode:', page.url());

// Progress: poll the in-page status the auto job maintains.
let lastPhase = '';
const renderStart = Date.now();
while (true) {
  await page.waitForTimeout(2000);
  const st = await page.evaluate(() => window.__replayStatus ?? null).catch(() => null);
  const phase = st?.phase ?? '?';
  if (phase !== lastPhase || phase === 'replaying') {
    const extra = phase === 'replaying' ? ` ${st.frame}/${st.total}` : '';
    console.log(`[e2e] render phase: ${phase}${extra} (+${Math.round((Date.now() - renderStart) / 1000)}s)`);
    lastPhase = phase;
  }
  if (phase === 'done' || phase === 'error') break;
  if (Date.now() - renderStart > 880000) { console.error('FAIL: render timed out'); process.exit(1); }
}
const status = await page.evaluate(() => window.__replayStatus);
if (status.phase === 'error') {
  console.error('FAIL: render errored:', status.error);
  process.exit(1);
}
const result = status.result;
console.log('[e2e] render result:', JSON.stringify({
  frames: result.frames, fps: result.fps, w: result.width, h: result.height,
  simulatedTicks: result.simulatedTicks, recordedTicks: result.recordedTicks,
  mismatches: result.mismatches, overlays: result.overlays,
  audio: result.audio && { error: result.audio.error ?? null, cues: result.audio.cues ?? result.audio.events ?? null },
  save: result.save,
}, null, 1));

// ---- 4. the download is the delivery on a static host ----
let mp4Download = null;
for (let i = 0; i < 240 && !mp4Download; i++) {
  mp4Download = downloads.find((d) => d.suggestedFilename().endsWith('.mp4')) ?? null;
  if (!mp4Download) await page.waitForTimeout(500);
}
if (!mp4Download) { console.error('FAIL: no .mp4 download arrived'); process.exit(1); }
const mp4Name = mp4Download.suggestedFilename();
const mp4Path = resolve(OUT_DIR, 'e2e-live-flow.mp4');
await mp4Download.saveAs(mp4Path);
console.log('[e2e] downloaded', mp4Name, '->', mp4Path);

await browser.close();

// ---- 5. probe the file ----
const probe = JSON.parse(execFileSync('ffprobe', [
  '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', mp4Path,
]).toString());
const v = probe.streams.find((s) => s.codec_type === 'video');
const a = probe.streams.find((s) => s.codec_type === 'audio');
const dur = Number(probe.format.duration);
const fpsOf = (r) => { const [n, d] = r.split('/').map(Number); return n / (d || 1); };

const checks = [];
const ok = (label, pass, detail) => checks.push({ label, pass, detail });
ok('delivered via download (static host path)', result.save?.via === 'download', JSON.stringify(result.save));
ok('video stream is h264', v?.codec_name === 'h264', v?.codec_name);
ok('audio stream is aac', a?.codec_name === 'aac', a?.codec_name ?? 'MISSING');
ok('geometry matches request (854x480 @ ss2 = 1708x960)', v?.width === 1708 && v?.height === 960, `${v?.width}x${v?.height}`);
ok('fps as chosen (30)', Math.abs(fpsOf(v?.avg_frame_rate ?? '0/1') - 30) < 0.5, v?.avg_frame_rate);
ok('duration matches replay report (±1s)', Math.abs(dur - result.frames / result.fps) < 1,
  `file=${dur}s report=${(result.frames / result.fps).toFixed(1)}s`);
ok('replay had zero outcome mismatches', (result.mismatches ?? []).length === 0, JSON.stringify(result.mismatches));
ok('audio reconstruction did not error', !result.audio?.error, String(result.audio?.error ?? ''));
ok('session earned a story callout', sessionInfo.triggered >= 1, `triggered=${sessionInfo.triggered}`);
ok('overlay compositor painted callout frames',
  !!result.overlays && JSON.stringify(result.overlays) !== '{}', JSON.stringify(result.overlays));
ok('no page errors across the whole flow', pageErrors.length === 0, JSON.stringify(pageErrors));
ok('real-click placements recorded as addOat events',
  placed.length > 0 && sessionInfo.addOatEvents.length >= placed.length,
  `placed=${placed.length} events=${sessionInfo.addOatEvents.length}`);
ok('R banked a recognizably-named .cvr immediately',
  !!cvrName && /^bestiary-\d{4}-\d{2}-\d{2}-\d{4}-\d+t\.cvr$/.test(cvrName), String(cvrName));
ok('rendered mp4 carries the same recognizable name (identical stem)',
  !!cvrName && mp4Name === cvrName.replace(/\.cvr$/, '.mp4'), `${cvrName} vs ${mp4Name}`);

// The film must run at the pace the session was LIVED. The old axis was the
// clamped sim dt, which played a 22fps session 1.16x fast — the player felt it
// before any metric did.
{
  const banked = JSON.parse(readFileSync(resolve(OUT_DIR, 'e2e-banked.cvr'), 'utf8'));
  const livedSec = (banked.wallMs ?? 0) / 1000;
  ok('film duration matches LIVED session time (±2.5s)',
    livedSec > 10 && Math.abs(dur - livedSec) < 2.5,
    `film=${dur.toFixed(1)}s lived=${livedSec.toFixed(1)}s`);
}

// Temporal stability: no single-frame brightness dropouts in the callout era.
// A preserveDrawingBuffer:false readback lottery once dropped the GL frame
// ~5 times per 2000 frames in Chrome (one-frame frost flicker) and every
// other frame in Firefox (a 30Hz strobe). Frames whose text/frost region dips
// >18% against BOTH neighbours are the signature.
{
  const gray = execFileSync('ffmpeg', ['-v', 'quiet', '-ss', String(Math.max(0, dur - 25)),
    '-i', mp4Path, '-vf', 'crop=540:430:680:40,format=gray', '-f', 'rawvideo', 'pipe:1'],
  { maxBuffer: 1 << 30 });
  const FRAME = 540 * 430;
  const n = Math.floor(gray.length / FRAME);
  const vals = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * FRAME;
    for (let j = 0; j < FRAME; j += 7) s += gray[base + j];
    vals[i] = s;
  }
  let dips = 0;
  for (let i = 1; i < n - 1; i++) {
    if (vals[i] < vals[i - 1] * 0.82 && vals[i] < vals[i + 1] * 0.82 && vals[i - 1] > FRAME / 7 * 8) dips++;
  }
  ok('no single-frame brightness dropouts in the last 25s', dips === 0, `dips=${dips} over ${n} frames`);
}

let failed = 0;
console.log('\n---- E2E RESULTS ----');
for (const c of checks) {
  if (!c.pass) failed++;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.label}${c.pass ? '' : `\n      ${c.detail}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed — ${mp4Path}`);

// Frames for eyeballing: intro, seeding, mid-growth, callout-era.
const grabAt = [2, 12, 30, Math.max(48, Math.min(dur - 2, (firstCalloutAtTick ?? 3300) / 60 + 6))];
for (const t of grabAt) {
  const png = resolve(OUT_DIR, `e2e-frame-${String(t).replace('.', '_')}s.png`);
  try {
    execFileSync('ffmpeg', ['-y', '-v', 'quiet', '-ss', String(t), '-i', mp4Path, '-frames:v', '1', png]);
    console.log('frame:', png);
  } catch { /* short film */ }
}
process.exit(failed ? 1 : 0);
