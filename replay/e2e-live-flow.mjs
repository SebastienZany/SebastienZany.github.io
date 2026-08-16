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

import { mkdirSync, existsSync } from 'node:fs';
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

const PLACE_FN = `async (count) => {
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
  const placed = [];
  for (let k = 0; k < count; k++) {
    let best = null;
    try { c.renderer.readRenderTargetPixels(rt, x0, y0, win, win, buf); } catch (e) { break; }
    for (let j = 0; j < win; j += 3) for (let i = 0; i < win; i += 3) {
      const val = h2f(buf[(j * win + i) * 4]);
      if (!(val > 0.004)) continue;
      const u = (x0 + i) / size, v = (y0 + j) / size;
      let ok = true;
      for (const o of c.oats) {
        if (!o.uv) continue;
        const du = u - o.uv.x, dv = v - o.uv.y;
        if (du * du + dv * dv < 0.053 * 0.053) { ok = false; break; }
      }
      if (ok && (!best || val > best.val)) best = { u, v, val };
    }
    if (!best) break;
    const before = c.oats.length;
    c.addOat(best.u, best.v);
    placed.push({ u: +best.u.toFixed(4), v: +best.v.toFixed(4), accepted: c.oats.length > before });
  }
  return placed;
}`;

// ---- 1. play a session under ?rec ----
console.log(`[e2e] loading ${BASE}/?rec&seed=${SEED}`);
await page.goto(`${BASE}/?rec&seed=${SEED}`, { waitUntil: 'commit' });
await page.waitForFunction(() => window.__rec && window.__cuttle && document.getElementById('startButton'), null, { timeout: 120000 });
await page.waitForTimeout(3000);
console.log('[e2e] pressing Begin');
await page.click('#startButton');
await page.waitForFunction(() => window.__rec.recording === true, null, { timeout: 5000 });

let firstCalloutAtTick = null;
for (let s = 1; s <= PLAY_SECONDS; s++) {
  await page.waitForTimeout(1000);
  if (s === PLACE_AT) {
    const placed = await page.evaluate(`(${PLACE_FN})(5)`);
    console.log(`[e2e] t=${s}s placed:`, JSON.stringify(placed));
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
}));
if (!sessionInfo.triggered) console.log('[e2e] WARNING: no story callout earned this session — text cannot be verified in the film');

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

// Keep the test cheap: small output, 30fps. (The shipped default is 60.)
await page.selectOption('#rp-res', '854x480');
await page.selectOption('#rp-fps', '30');

// ---- 3. Render: reload into ?render&auto=1, IndexedDB hand-off, download ----
const downloadPromise = page.waitForEvent('download', { timeout: 900000 });
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
const download = await downloadPromise;
const mp4Path = resolve(OUT_DIR, 'e2e-live-flow.mp4');
await download.saveAs(mp4Path);
console.log('[e2e] downloaded to', mp4Path);

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
