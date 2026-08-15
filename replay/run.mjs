#!/usr/bin/env node
// Drive the replay harness in a real browser window.
//
// Why not the in-app browser pane: it runs the page with
// document.visibilityState === "hidden", which has two consequences that both
// corrupt measurements rather than merely slowing them.
//
//  1. The CSS box collapses to 0, so main.js computes camera.aspect = 0
//     (resizeIfNeeded, main.js:20165). The projection matrix is then degenerate
//     and its inverse singular, so the viewport-centre ray that places the
//     initial oat misses the mesh and main.js silently falls back to a different
//     placement algorithm. The food lands somewhere else, the initial agents are
//     Gaussian-sampled around it, and the colony lives a different life. The
//     tell is "Viewport-center ray missed mesh for initial oat" in the boot log.
//  2. setTimeout is clamped hard in a hidden tab (~1/s, ~1/min after five
//     minutes), which starves the harness's own poll loops — a two-minute
//     measurement took over ten minutes of wall clock and still had not started.
//
// A real window with a real viewport removes both by construction. Uses the
// installed Google Chrome (channel: chrome) rather than bundled Chromium so the
// run gets the actual GPU instead of SwiftShader — this is a WebGL2 simulation
// and software rasterisation is not a useful measurement.
//
//   node replay/run.mjs "live=1&secs=120&every=15"
//   node replay/run.mjs "record=1&ticks=900&player=wide&name=s.cvr"
//   node replay/run.mjs "replay=s.cvr&fps=30&w=1280&h=720&name=out.mp4"

// This project deliberately has no package.json and no build step, so playwright
// is not vendored into the repo. Resolve it from wherever it is installed and
// say plainly what to do if it is not.
//   npm install playwright        (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 is fine —
//                                  we drive the installed Google Chrome)
// Set PLAYWRIGHT_PATH to point at an out-of-tree install.
const pwRoot = process.env.PLAYWRIGHT_PATH ?? 'playwright';
let chromium;
try {
  ({ chromium } = await import(pwRoot));
} catch {
  console.error(
    `[run] cannot load playwright from "${pwRoot}".\n` +
    `      npm install playwright   (or set PLAYWRIGHT_PATH to an existing install)`,
  );
  process.exit(2);
}

const BASE = process.env.REPLAY_BASE ?? 'http://localhost:8140';
const job = process.argv[2] ?? 'live=1&secs=60&every=10';
const headed = process.argv.includes('--headed');
const timeoutMs = Number(process.env.REPLAY_TIMEOUT_MS ?? 30 * 60 * 1000);

const url = `${BASE}/?render&dev&auto=1&${job}`;
console.log(`[run] ${url}`);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !headed,
  args: [
    // Headless Chrome defaults to SwiftShader; these force real GPU use.
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-webgpu',
    // Keep the page on a normal frame budget even if it loses focus.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

page.on('console', (m) => {
  const t = m.text();
  if (/\[replay\]|error|Error|missed mesh|WARN/.test(t)) console.log(`  · ${t.slice(0, 200)}`);
});
page.on('pageerror', (e) => console.log(`  ! pageerror: ${String(e).slice(0, 300)}`));

await page.goto(url, { waitUntil: 'commit', timeout: 120000 });

// Poll the harness's own status object in-page. Deliberately not reading
// replay/out/status.json from disk: that file persists between runs and a stale
// "done" from a previous run reads as this run finishing instantly.
const t0 = Date.now();
let last = '';
let status = null;
for (;;) {
  if (Date.now() - t0 > timeoutMs) { console.error('[run] TIMEOUT'); break; }
  status = await page.evaluate(() => window.__replayStatus ?? null).catch(() => null);
  const phase = status?.phase ?? 'loading';
  const detail = status?.frame != null ? ` ${status.frame}/${status.total ?? '?'}` : '';
  const line = `${phase}${detail}`;
  if (line !== last) { console.log(`[run] ${Math.round((Date.now() - t0) / 1000)}s  ${line}`); last = line; }
  if (phase === 'done' || phase === 'error') break;
  await page.waitForTimeout(2000);
}

// Confirm the initial oat came from the raycast, not the fallback. A run where
// it missed is measuring a different world and its numbers must not be compared
// against one where it hit.
const genesis = await page.evaluate(() => {
  const c = window.__cuttle;
  const o = c?.oats?.[0];
  return {
    oatUv: o?.uv ? [+o.uv.x.toFixed(4), +o.uv.y.toFixed(4)] : null,
    chartId: o?.chartId ?? null,
    rayMissed: /Viewport-center ray missed mesh/.test(document.body.innerText),
    visibility: document.visibilityState,
    canvas: (() => { const e = document.getElementById('sim'); return e ? [e.width, e.height, e.clientWidth, e.clientHeight] : null; })(),
  };
}).catch(() => null);

console.log('\n[run] genesis', JSON.stringify(genesis));
if (genesis?.rayMissed) console.log('[run] WARNING: initial-oat raycast MISSED — fallback placement, results not comparable');
console.log('[run] result\n' + JSON.stringify(status, null, 2));

await browser.close();
process.exit(status?.phase === 'done' ? 0 : 1);
