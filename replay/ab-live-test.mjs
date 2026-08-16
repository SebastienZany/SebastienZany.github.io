#!/usr/bin/env node
// A/B gate for the passive recorder: a ?rec load must be the stock game.
//
// The regression this exists to catch: record-boot once reset the simulation at
// boot, spawning the colony before the intro. Seeding happened at the wrong
// time and story callouts never fired — for every visitor. So before recording
// is ever allowed on by default, this runs the SAME session twice, plain and
// ?rec, and compares the things a player experiences:
//
//   - the intro arms right after Begin
//   - initial seeding starts ~10s after Begin (intro-driven), same in both
//   - the colony reaches population, same order of magnitude in both
//   - placed oats earn story callouts in both
//   - no page errors in either
//
// plus recorder integrity on the ?rec arm: recording starts AT the Begin click
// (not at boot), never mutates the world, and the file it would produce is
// coherent (dt stream, camera keys, our addOat events, spawnAgents:false).
//
//   node replay/ab-live-test.mjs [url] [seconds]
//
// Run it against a PLAIN static server (python3 -m http.server), not the dev
// server, so the arms see exactly what GitHub Pages serves.

const pwRoot = process.env.PLAYWRIGHT_PATH ?? 'playwright';
const { chromium } = await import(pwRoot);

const BASE = process.argv[2] ?? 'http://localhost:8141';
const SECONDS = Number(process.argv[3] ?? 85);
const PLACE_AT = 45;          // seconds after Begin; colony is established by then
const SEED = 424242;          // ?rec arm only; plain arm has no seed control

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync'],
});

// Strongest-slime candidates from liveCallout's readback, each projected to
// SCREEN coordinates. The oats are then placed with REAL mouse clicks on the
// canvas — the recorder once hooked only the console API, so tests that placed
// oats through window.__cuttle.addOat passed while every real player's clicks
// went unrecorded. Real input only, in every gate, forever.
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
    picked.push({ u: +cand.u.toFixed(4), v: +cand.v.toFixed(4), val: +cand.val.toFixed(4),
                  sx: Math.round(s2.x), sy: Math.round(s2.y) });
    if (picked.length >= maxCands) break;
  }
  return picked;
}`;

// Click through the candidates like a player would, until `want` land.
async function placeByRealClicks(page, want) {
  const cands = await page.evaluate(`(${CANDS_FN})(24)`);
  const placed = [];
  for (const cand of cands) {
    if (placed.length >= want) break;
    const before = await page.evaluate(() => window.__cuttle.oats.length);
    await page.mouse.click(cand.sx, cand.sy);
    await page.waitForTimeout(180);
    const after = await page.evaluate(() => window.__cuttle.oats.length);
    placed.push({ ...cand, accepted: after > before });
    if (after <= before) placed.pop();   // occluded or rejected — try the next
  }
  return placed;
}

async function runArm(name, path) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  const pageErrors = [];
  const consoleErrors = [];
  const recorderDeaths = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') consoleErrors.push(t.slice(0, 200));
    // The recorder degrades to the stock game on an internal failure — which
    // is right for a visitor and catastrophic for this gate to miss: the game
    // then passes every play assertion while the recording is dead. (Exactly
    // how an uninitialised stream shipped: recTick froze at 1 and only one
    // fps-shaped assertion caught it, by luck.)
    if (/sampling failed|failed to arm|failed to start recording|mutation observer failed/.test(t)) {
      recorderDeaths.push(t.slice(0, 250));
    }
  });

  await page.goto(BASE + path, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__cuttle && document.getElementById('startButton'), null, { timeout: 120000 });
  // Let boot settle (shader prewarm etc.) so both arms click from a quiet page.
  await page.waitForTimeout(3000);

  const preBegin = await page.evaluate(() => ({
    rec: !!window.__rec,
    recording: window.__rec ? window.__rec.recording : null,
    tick: window.__rec ? window.__rec.tick : null,
    oats: window.__cuttle.oats.length,
    seedState: window.__cuttle.getInitialAgentSeedState?.() ?? null,
  }));

  const t0 = await page.evaluate(() => (window.__cuttle.params.statsReadbackEnabled = true, performance.now()));
  await page.click('#startButton');

  const timeline = [];
  let placed = null;
  for (let s = 1; s <= SECONDS; s++) {
    await page.waitForTimeout(1000);
    const row = await page.evaluate(() => {
      const c = window.__cuttle;
      const seed = c.getInitialAgentSeedState?.() ?? {};
      const stats = c.refreshRuntimeReadbackStats?.() ?? {};
      const callout = [...document.querySelectorAll('.observation-callout')]
        .some((n) => Number(getComputedStyle(n).opacity) > 0.6);
      return {
        introRequested: !!(c.getIntroSequenceState?.().requested),
        seedStartedAt: seed.startedAt ?? 0,
        seedVisible: seed.visibleCount ?? 0,
        agents: stats.visibleAgents ?? null,
        oats: c.oats.length,
        triggered: c.oats.filter((o) => o.observation?.triggered).length,
        calloutVisible: callout,
        recTick: window.__rec ? window.__rec.tick : null,
        recRecording: window.__rec ? window.__rec.recording : null,
      };
    });
    timeline.push({ s, ...row });
    if (s === PLACE_AT) {
      placed = await placeByRealClicks(page, 4);
      console.log(`  [${name}] t=${s}s placed by real clicks:`, JSON.stringify(placed));
    }
    if (s % 15 === 0) {
      console.log(`  [${name}] t=${s}s agents=${row.agents} oats=${row.oats} triggered=${row.triggered} callout=${row.calloutVisible} recTick=${row.recTick}`);
    }
  }

  const recFinal = await page.evaluate(() => {
    if (!window.__rec) return null;
    const j = window.__rec.toJSON();
    return {
      stats: window.__rec.stats(),
      spawnAgents: j.spawnAgents,
      rngSeed: j.rngSeed,
      dtRows: j.dtStream.length,
      wallRows: (j.wallDtStream ?? []).length,
      camRows: j.camera.length,
      events: j.events.map((e) => ({ tick: e.tick, type: e.type, accepted: e.accepted, worldPos: e.worldPos ?? null })),
      initialOats: j.initialOats,
      bytes: JSON.stringify(j).length,
    };
  });

  const seedStartedAt = timeline.find((r) => r.seedStartedAt > 0)?.seedStartedAt ?? null;
  const out = {
    name, preBegin, timeline, placed, recFinal,
    seedDelayMs: seedStartedAt ? Math.round(seedStartedAt - t0) : null,
    firstVisibleSeedS: timeline.find((r) => r.seedVisible > 0)?.s ?? null,
    firstCalloutS: timeline.find((r) => r.calloutVisible)?.s ?? null,
    finalAgents: timeline.at(-1).agents,
    finalTriggered: timeline.at(-1).triggered,
    pageErrors, consoleErrors, recorderDeaths,
  };
  await page.close();
  return out;
}

console.log(`A/B live test against ${BASE} — ${SECONDS}s per arm`);
// Stock arm boots through the ?norec escape hatch now that recording is the
// default; the recording arm takes the default path a visitor gets.
const plain = await runArm('plain', '/?norec');
const rec = await runArm('rec', `/?rec&seed=${SEED}`);
await browser.close();

// ---- assertions ----
const checks = [];
const ok = (label, pass, detail) => { checks.push({ label, pass, detail }); };

ok('plain arm has no recorder', !plain.preBegin.rec, JSON.stringify(plain.preBegin));
ok('rec arm: recorder armed but NOT recording before Begin',
  rec.preBegin.rec && rec.preBegin.recording === false && rec.preBegin.tick === 0,
  JSON.stringify(rec.preBegin));
ok('rec arm: recording after Begin', rec.timeline[2]?.recRecording === true,
  JSON.stringify(rec.timeline[2]));
for (const arm of [plain, rec]) {
  ok(`${arm.name}: intro armed after Begin`, arm.timeline[2]?.introRequested === true,
    JSON.stringify(arm.timeline[2]));
  // Absolute windows are calibrated to MEASURED stock behaviour on this
  // machine (headless, GPU-throttled): seeding stamps ~16.3s after Begin,
  // population ~2100 at t=42. The tight gates are the cross-arm deltas below.
  ok(`${arm.name}: seeding began 8-20s after Begin (intro-driven, not at boot)`,
    arm.seedDelayMs != null && arm.seedDelayMs >= 8000 && arm.seedDelayMs <= 20000,
    `seedDelayMs=${arm.seedDelayMs} firstVisibleSeedS=${arm.firstVisibleSeedS}`);
  ok(`${arm.name}: colony populated by t=42s`,
    (arm.timeline.find((r) => r.s === 42)?.agents ?? 0) > 1500,
    `agents@42=${arm.timeline.find((r) => r.s === 42)?.agents}`);
  ok(`${arm.name}: >=1 oat accepted`, !!arm.placed?.some((p) => p.accepted), JSON.stringify(arm.placed));
  ok(`${arm.name}: >=1 story callout triggered`, arm.finalTriggered >= 1,
    `triggered=${arm.finalTriggered} firstCalloutS=${arm.firstCalloutS}`);
  ok(`${arm.name}: callout visible in DOM`, arm.firstCalloutS != null, `firstCalloutS=${arm.firstCalloutS}`);
  ok(`${arm.name}: no page errors`, arm.pageErrors.length === 0, JSON.stringify(arm.pageErrors));
}
ok('seeding delay matches across arms (<2s apart)',
  plain.seedDelayMs != null && rec.seedDelayMs != null && Math.abs(plain.seedDelayMs - rec.seedDelayMs) < 2000,
  `plain=${plain.seedDelayMs} rec=${rec.seedDelayMs}`);
{
  const a = plain.finalAgents ?? 0; const b = rec.finalAgents ?? 0;
  ok('final population same order across arms (within 40%)',
    a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) < 0.4, `plain=${a} rec=${b}`);
}
ok('recorder never self-disabled (no death warnings)', rec.recorderDeaths.length === 0,
  JSON.stringify(rec.recorderDeaths));
if (rec.recFinal) {
  ok('rec file: spawnAgents=false (from-Begin capture)', rec.recFinal.spawnAgents === false,
    `spawnAgents=${rec.recFinal.spawnAgents}`);
  ok('rec file: dt stream present', rec.recFinal.dtRows > 0, `dtRows=${rec.recFinal.dtRows}`);
  ok('rec file: WALL stream present (lived-speed time axis)',
    (rec.recFinal.wallRows ?? 0) > 0, `wallRows=${rec.recFinal.wallRows}`);
  // THE regression this suite exists for: oats placed with real canvas
  // clicks (not the console API) must land in the event log, with the
  // raycast's resolved worldPos captured.
  const recAdds = rec.recFinal.events.filter((e) => e.type === 'addOat');
  ok('rec file: REAL-CLICK oat placements were recorded',
    recAdds.length >= (rec.placed?.length ?? 99) && (rec.placed?.length ?? 0) > 0,
    JSON.stringify(rec.recFinal.events));
  ok('rec file: recorded placements carry resolved worldPos',
    recAdds.length > 0 && recAdds.every((e) => Array.isArray(e.worldPos) && e.worldPos.length === 3),
    JSON.stringify(recAdds.map((e) => e.worldPos)));
  ok('rec file: recorder never reset the world (no tick-0 reset event)',
    !rec.recFinal.events.some((e) => e.type === 'resetSimulation'),
    JSON.stringify(rec.recFinal.events.filter((e) => e.type === 'resetSimulation')));
  ok('rec file: ticks tracked live frames (>30fps equivalent)',
    rec.recFinal.stats.tick > SECONDS * 30, `ticks=${rec.recFinal.stats.tick} over ~${SECONDS}s`);
}

let failed = 0;
console.log('\n---- RESULTS ----');
for (const chk of checks) {
  if (!chk.pass) failed++;
  console.log(`${chk.pass ? 'PASS' : 'FAIL'}  ${chk.label}${chk.pass ? '' : `\n      ${chk.detail}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
console.log('console errors (plain):', JSON.stringify(plain.consoleErrors.slice(0, 5)));
console.log('console errors (rec):  ', JSON.stringify(rec.consoleErrors.slice(0, 5)));
process.exit(failed ? 1 : 0);
