#!/usr/bin/env node
// Render a recording by capturing CHROME's own output, frame by frame.
//
// The in-page path (replay/offline.js -> replay/overlays.js) repaints the story
// callout by hand in Canvas2D: emulated backdrop-filter blur+saturate, two
// crossed gradient masks with mask-composite:intersect, feather outset, stroke,
// tail, EB Garamond metrics, and the per-line reveal recomputed arithmetically
// after pausing every WAAPI animation in the layer. Each of those approximates
// something the browser already does exactly, and they were wrong in ways that
// kept surfacing — most visibly the emulated backdrop blur smearing over the
// whole frame, so the entire creature went soft the moment a callout appeared.
//
// Here Chrome draws it instead. The DOM callout composites over the real WebGL
// canvas with real backdrop-filter, real masks and real fonts, and its animations
// run on performance.now() — which IS the virtual clock during an offline render,
// so nothing needs pausing or recomputing. Node advances the simulation one
// output frame at a time and screenshots the composited page.
//
// Cost: a screenshot is ~50-100ms, so this is slower than the in-page encoder.
// For an offline render that is the right trade — it is the difference between
// approximating the piece and capturing it.
//
//   node replay/render-page.mjs story3.cvr out.mp4 [fps] [ss]

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const pwRoot = process.env.PLAYWRIGHT_PATH ?? 'playwright';
let chromium;
try { ({ chromium } = await import(pwRoot)); } catch {
  console.error(`[render] cannot load playwright from "${pwRoot}" — npm install playwright, or set PLAYWRIGHT_PATH`);
  process.exit(2);
}

const BASE = process.env.REPLAY_BASE ?? 'http://localhost:8140';
const source = process.argv[2] ?? 'story3.cvr';
const outName = process.argv[3] ?? 'page-render.mp4';
const fps = Number(process.argv[4] ?? 60);
const ss = Number(process.argv[5] ?? 2);
const CSS_W = Number(process.env.CSS_W ?? 1280);
const CSS_H = Number(process.env.CSS_H ?? 720);
const CRF = process.env.CRF ?? '16';
const DIAG_EVERY = process.env.DIAG_EVERY ? Number(process.env.DIAG_EVERY) : 0;

const outPath = resolve('replay/out', outName);
const wavName = outName.replace(/\.[^.]+$/, '') + '.wav';
const wavPath = resolve('replay/out', wavName);
mkdirSync(dirname(outPath), { recursive: true });

const url = `${BASE}/?render&dev&auto=1&pagerender=1&replay=${encodeURIComponent(source)}`
  + `&w=${CSS_W}&h=${CSS_H}&fps=${fps}&ss=${ss}`;
console.log(`[render] ${url}`);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    // Screenshots must reflect what was just drawn rather than a stale surface.
    '--disable-gpu-vsync',
    '--run-all-compositor-stages-before-draw',
  ],
});

// deviceScaleFactor is what makes the DOM callout crisp: it lays out at CSS size
// while everything rasterises at ss x, so the 230x126 CSS callout box is drawn
// with ss x the pixels instead of being upscaled afterwards.
const page = await browser.newPage({
  viewport: { width: CSS_W, height: CSS_H },
  deviceScaleFactor: ss,
});
page.on('console', (m) => {
  const t = m.text();
  if (/\[replay\]|missed mesh|Error|error/.test(t)) console.log(`  · ${t.slice(0, 180)}`);
});
page.on('pageerror', (e) => console.log(`  ! ${String(e).slice(0, 240)}`));

await page.goto(url, { waitUntil: 'commit', timeout: 120000 });

// Wait for the harness to finish booting and expose the frame controls.
const t0 = Date.now();
let info = null;
for (;;) {
  if (Date.now() - t0 > 20 * 60 * 1000) throw new Error('timed out waiting for __pr');
  info = await page.evaluate(() => (window.__pr ? {
    frames: window.__pr.frames, total: window.__pr.total, fps: window.__pr.fps,
  } : null)).catch(() => null);
  if (info) break;
  const st = await page.evaluate(() => window.__replayStatus?.phase ?? 'loading').catch(() => 'loading');
  process.stdout.write(`\r[render] booting… ${st} ${Math.round((Date.now() - t0) / 1000)}s   `);
  await page.waitForTimeout(1000);
}
console.log(`\n[render] ${info.frames} frames @${fps}fps from ${info.total} ticks`);

const genesis = await page.evaluate(() => ({
  rayMissed: /Viewport-center ray missed mesh/.test(document.body.innerText),
  oatUv: window.__cuttle?.oats?.[0]?.uv ? [+window.__cuttle.oats[0].uv.x.toFixed(4), +window.__cuttle.oats[0].uv.y.toFixed(4)] : null,
}));
console.log('[render] genesis', JSON.stringify(genesis));
if (genesis.rayMissed) console.log('[render] WARNING: initial-oat raycast MISSED');

// ffmpeg consumes the PNG stream on stdin. -crf rather than a bitrate target:
// the frame is mostly black, and a VBR bitrate target gets spent on nothing while
// the fine text motion — the part that matters — is quantised away.
const ff = spawn('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', CRF,
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  outPath,
]);
ff.stderr.on('data', (d) => process.stderr.write(`  ffmpeg: ${d}`));
const ffDone = new Promise((res, rej) => {
  ff.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`))));
});

const write = (buf) => new Promise((res) => {
  if (ff.stdin.write(buf)) res();
  else ff.stdin.once('drain', res);
});

const started = Date.now();
for (let f = 0; f < info.frames; f++) {
  await page.evaluate((i) => window.__pr.advance(i), f);
  // NOT animations:'disabled'. That option finishes every CSS animation, CSS
  // transition and Web Animation before each shot, which fast-forwards the
  // callout's own reveal AND its exit — so the box is gone by the time the pixel
  // data is read. The DOM reported opacity 1 at [507,252,230,126] while every
  // screenshot came back without it. Animations are already pinned to the
  // virtual clock by syncDomAnimations; Playwright must not touch them.
  const png = await page.screenshot({ type: 'png', caret: 'hide' });
  await write(png);
  if (DIAG_EVERY && f % DIAG_EVERY === 0) {
    const dom = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.observation-callout')];
      const layer = document.getElementById('annotationLayer');
      return {
        callouts: nodes.length,
        layer: layer ? {
          display: getComputedStyle(layer).display,
          opacity: getComputedStyle(layer).opacity,
          w: layer.clientWidth, h: layer.clientHeight,
        } : null,
        items: nodes.slice(0, 3).map((n) => {
          const r = n.getBoundingClientRect();
          const cs = getComputedStyle(n);
          const content = n.querySelector('.observation-content');
          const lines = n.querySelectorAll('.observation-line');
          return {
            op: +Number(cs.opacity).toFixed(3),
            // The shell being visible means nothing on its own — a callout can be
            // present at opacity 1 with contentOpacity 0 and no lines built.
            contentOp: content ? +Number(getComputedStyle(content).opacity).toFixed(3) : null,
            lines: lines.length,
            firstLine: lines[0]?.textContent?.slice(0, 20) ?? null,
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          };
        }),
        oats: window.__cuttle?.oats?.length ?? null,
        triggered: (window.__cuttle?.oats ?? []).filter((o) => o.observation?.triggered).length,
      };
    }).catch((e) => ({ err: String(e).slice(0, 120) }));
    console.error(`[diag] f=${f} ${JSON.stringify(dom)}`);
  }
  if (f % 30 === 0 || f === info.frames - 1) {
    const el = (Date.now() - started) / 1000;
    const rate = (f + 1) / Math.max(el, 0.001);
    const eta = (info.frames - f - 1) / Math.max(rate, 0.001);
    process.stdout.write(
      `\r[render] frame ${f + 1}/${info.frames}  ${rate.toFixed(1)} fps  eta ${Math.round(eta)}s      `,
    );
  }
}
ff.stdin.end();
console.log('\n[render] frames done, waiting on ffmpeg…');
await ffDone;

const audio = await page.evaluate((n) => window.__pr.finishAudio(n), wavName)
  .catch((e) => ({ error: String(e) }));
console.log('[render] audio', JSON.stringify(audio).slice(0, 300));

const stats = await page.evaluate(() => window.__pr.stats());
console.log('[render] stats', JSON.stringify(stats));
await browser.close();

// Mux the soundtrack in, if it rendered.
if (existsSync(wavPath) && statSync(wavPath).size > 1000) {
  const muxed = outPath.replace(/\.mp4$/, '.muxed.mp4');
  await new Promise((res, rej) => {
    const m = spawn('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', outPath, '-i', wavPath,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
      '-movflags', '+faststart', muxed,
    ]);
    m.stderr.on('data', (d) => process.stderr.write(`  mux: ${d}`));
    m.on('close', (c) => (c === 0 ? res() : rej(new Error(`mux exited ${c}`))));
  });
  const { renameSync } = await import('node:fs');
  renameSync(muxed, outPath);
  console.log('[render] muxed audio');
} else {
  console.log('[render] no audio track (wav missing or empty)');
}

console.log(`[render] wrote ${outPath} (${(statSync(outPath).size / 1e6).toFixed(1)} MB)`);
