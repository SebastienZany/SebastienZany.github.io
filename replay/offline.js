// Offline replay renderer. Loaded instead of main.js when ?render is present.
//
//   1. install the virtual clock shim
//   2. boot main.js normally (live mode — boot needs real frames)
//   3. wait for __cuttle
//   4. switch to offline mode and step the loop one fixed tick at a time,
//      capturing each frame into the encoder
//
// main.js is not modified. The whole thing rides on the audit finding that rAF
// and performance.now() are the only wall-clock sources.

import { installClock, enterOffline, armOffline, exitOffline, step, onFrame, clock } from './clock.js';
import { createMp4Encoder, bitrateFor, pickAvcCodec } from './encode.js';
import { createRecorder, createPlayer } from './recorder.js';
import { createAudioRecorder, renderSessionAudio, installAudioProbe, describeAudioEvents } from './audio.js';
import { createOverlayCompositor } from './overlays.js';
import { pinViewportBeforeBoot } from './viewport.js';
import { loadRecording, deliverFile } from './store.js';

const qs = new URLSearchParams(location.search);
const log = (...a) => { console.log('[replay]', ...a); };

installClock({ pumpHidden: true });
// Must precede main.js: the probe tags decoded buffers, and
// scheduleSoundPackPreload decodes the whole pack during boot.
if (qs.get('audio') !== '0') installAudioProbe();

// Must ALSO precede main.js: boot places the initial oat by raycasting through
// the camera, and a collapsed CSS box (hidden tab) gives aspect 0 and a singular
// projection inverse, so the ray misses and the food is placed by a fallback
// somewhere else. See viewport.js.
const pinned = await pinViewportBeforeBoot(
  qs.has('w') ? Number(qs.get('w')) : 1280,
  qs.has('h') ? Number(qs.get('h')) : 720,
);
log('viewport pinned before boot', pinned);

// Boot the game with the shim already in place.
await import('../main.js');

// ---------------------------------------------------------------------------

function waitFor(pred, { timeoutMs = 120000, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = clock.realNow();
    const tick = () => {
      let ok = false;
      try { ok = pred(); } catch { ok = false; }
      if (ok) return resolve();
      if (clock.realNow() - t0 > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

const api = () => window.__cuttle;

/**
 * Force the canvas to an exact size.
 *
 * main.js's resizeIfNeeded() recomputes the backing store from
 * `canvas.clientWidth * min(devicePixelRatio, MAX_PIXEL_RATIO)` and runs inside
 * renderSceneOnce, so it overwrites anything set directly on the renderer. In a
 * hidden tab the CSS box collapses to 0 and it drives the canvas to 0x0 —
 * which renders pure black.
 *
 * Rather than fight it, drive the input it reads: pin the CSS box to the target
 * size and pixelRatio to 1, so resizeIfNeeded independently arrives at the size
 * we want. Also pins the DOM overlay layer, which lays out in CSS pixels.
 */
function setRenderSize(width, height, ss = 1) {
  const c = document.getElementById('sim');
  const renderer = api().renderer;
  const camera = api().camera;

  for (const el of [c, document.getElementById('annotationLayer')]) {
    if (!el) continue;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.maxWidth = 'none';
    el.style.maxHeight = 'none';
  }
  // ss decouples the LAYOUT size from the OUTPUT size, and that distinction is
  // what makes the story text sharp.
  //
  // The callout is a fixed 230x126 CSS-pixel box, and the overlay compositor
  // paints at scale = outputHeight / canvas.clientHeight. Pinning the CSS box
  // equal to the output size forces that scale to 1, so the text is rasterised
  // at 1x CSS pixels — roughly 13px glyphs — while a Retina display shows the
  // live game at devicePixelRatio 2. The render looked soft next to the real
  // thing for that reason alone, before any encoder involvement.
  //
  // Keeping the layout at width x height while rendering width*ss x height*ss
  // holds the callout at the same fraction of frame and paints it at ss x the
  // resolution. MAX_PIXEL_RATIO is 2 on desktop, which caps useful ss at 2.
  renderer.setPixelRatio(ss);
  renderer.setSize(width, height, false);
  if (camera) { camera.aspect = width / height; camera.updateProjectionMatrix(); }

  return { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight, ss };
}

/**
 * Re-assert the render size if anything has moved it, and report whether it had
 * to act. Called before every capture.
 *
 * resizeIfNeeded() recomputes the backing store from clientWidth * min(dpr, 2)
 * whenever canvasResizeDirty is set, and the ResizeObserver sets that flag for
 * reasons outside our control — a window resize, a tab being closed, a devtools
 * pane opening. Pinning the size once at the start is therefore not enough: a
 * mid-render resize changes canvas.width and the encoder rejects the frame with
 * "Video sample size must remain constant". Cheap to check, so check every frame.
 */
function assertRenderSize(width, height, ss = 1) {
  const c = document.getElementById('sim');
  if (c.width === Math.round(width * ss) && c.height === Math.round(height * ss)) return false;
  setRenderSize(width, height, ss);
  return true;
}

/**
 * Render `frames` output frames, stepping `ticksPerFrame` fixed ticks between
 * captures, and mux to MP4.
 *
 * `script` is a sparse map of tickIndex -> fn(api), which is the hand-authored
 * stand-in for a recorded intent stream. Same shape a real recording replays.
 */
async function renderVideo({
  width = 1280,
  height = 720,
  fps = 60,
  simHz = 60,
  frames = 300,
  ticksPerFrame = null,
  bpp = 0.12,
  script = {},
  name = 'replay.mp4',
  onProgress = null,
} = {}) {
  const canvas = document.getElementById('sim');
  const tpf = ticksPerFrame ?? Math.max(1, Math.round(simHz / fps));
  const dtMs = 1000 / simHz;

  const sized = setRenderSize(width, height);
  log(`render ${width}x${height} @${fps}fps, ${frames} frames, ${tpf} tick(s)/frame, simHz=${simHz}`, sized);
  if (canvas.width !== width || canvas.height !== height) {
    throw new Error(`canvas is ${canvas.width}x${canvas.height}, expected ${width}x${height}`);
  }

  const enc = await createMp4Encoder({ canvas, fps, bpp });
  log(`codec ${enc.videoCodec} @ ${(enc.videoBitrate / 1e6).toFixed(2)} Mbps`);
  await enc.start();

  await armOffline();

  const timings = [];
  let scripted = 0;
  let resizeCorrections = 0;
  try {
    for (let i = 0; i < frames; i++) {
      const t0 = clock.realNow();
      for (let t = 0; t < tpf; t++) {
        const fn = script[clock.tickIndex];
        if (fn) { try { fn(api()); scripted++; } catch (e) { console.warn('[replay] script error', e); } }
        step(dtMs);
      }
      // Capture in the SAME task as the draw that just happened inside step().
      if (assertRenderSize(width, height)) {
        resizeCorrections++;
        step(dtMs);   // redraw at the corrected size before capturing
      }
      await enc.addFrame(i);
      timings.push(clock.realNow() - t0);
      if (onProgress && i % 10 === 0) onProgress(i, frames, timings);
    }
  } finally {
    exitOffline();
  }

  const buf = await enc.finalize();

  const warm = timings.slice(30);
  const mean = warm.length ? warm.reduce((a, b) => a + b, 0) / warm.length : timings[0];
  const stats = {
    frames, width, height, fps, simHz, ticksPerFrame: tpf, scriptedEvents: scripted,
    bytes: buf.byteLength,
    meanMsPerFrame: +mean.toFixed(2),
    firstFrameMs: +timings[0].toFixed(1),
    totalSeconds: +(timings.reduce((a, b) => a + b, 0) / 1000).toFixed(1),
  };
  log('done', stats);

  const save = await fetch(`/__save?name=${encodeURIComponent(name)}`, { method: 'POST', body: buf })
    .then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));

  return { ...stats, save };
}

// Measure the true cost of a complete tick (sim + display chain), which is what
// M0b needs in order to choose simHz honestly.
async function benchmarkTick({ ticks = 240 } = {}) {
  await armOffline();
  const t = [];
  try {
    for (let i = 0; i < ticks; i++) {
      const t0 = clock.realNow();
      step(1000 / 60);
      t.push(clock.realNow() - t0);
    }
  } finally { exitOffline(); }
  const warm = t.slice(60).sort((a, b) => a - b);
  const pct = (p) => +warm[Math.floor(warm.length * p)].toFixed(2);
  return {
    ticks, firstMs: +t[0].toFixed(1),
    p50: pct(0.5), p90: pct(0.9), p99: pct(0.99),
    sustainableHz: +(1000 / pct(0.9)).toFixed(1),
  };
}

/**
 * Grow the colony before capture.
 *
 * Uses __cuttle.growFast, which runs simulate() in a tight loop and skips the
 * ~6-pass display chain — the dominant per-tick cost. That makes the pre-roll
 * an order of magnitude cheaper than stepping the full loop. It is only valid
 * as a pre-roll: it advances sim state, not display history, so the capture
 * itself must still run the complete tick.
 */
async function growColony(ticks) {
  const t0 = clock.realNow();
  api().growFast(ticks);
  return { ticks, seconds: +((clock.realNow() - t0) / 1000).toFixed(1) };
}

/**
 * Growth probe: how does the colony actually develop under a given preset?
 *
 * Uses visibleAgents only. slimeCoveragePercent is unusable — its readback
 * asks for HALF_FLOAT into a Float32Array and the driver rejects it
 * ("readPixels: type HALF_FLOAT but ArrayBufferView not Uint16Array"), so it
 * silently returns 0 regardless of state.
 */
async function probeGrowth({ preset = 'original-defaults', chunk = 1200, chunks = 6, onStep = null } = {}) {
  const c = api();
  if (preset) c.applySimulationPreset(preset);
  c.resetSimulation({ resetOats: true, spawnAgents: true });
  c.params.statsReadbackEnabled = true;

  const log = [];
  for (let k = 0; k < chunks; k++) {
    const t0 = clock.realNow();
    c.growFast(chunk);
    const growMs = clock.realNow() - t0;
    const agents = c.refreshRuntimeReadbackStats().visibleAgents;
    const row = { ticks: (k + 1) * chunk, agents, growMs: Math.round(growMs) };
    log.push(row);
    if (onStep) await onStep(row, log);
    await new Promise((r) => setTimeout(r, 0));
  }
  return { preset, log };
}

/**
 * Is the simulation frame-rate independent?
 *
 * simulate() mixes two kinds of operation:
 *   per-DT   updateAgents(now, dt), applyAgentFoodDeltas(dt)   — metabolism
 *   per-CALL diffuseField() [applies params.fieldDecay], renderOats(),
 *            renderDepositDensity(), equalizeField(), clipCanonicalField()
 *
 * So the ratio of food evaporation to agent metabolism is a function of the
 * TICK RATE, not just of elapsed simulated time. Live play at ~30fps runs half
 * as many calls per dt-unit as an offline render stepping at 60Hz.
 *
 * This sweep holds BOTH total dt-units and total virtual milliseconds constant
 * (so oat decay is identical) and varies only the step size. Any spread in the
 * agent counts is per-call coupling, measured rather than argued.
 */
async function dtSweep({ seed = 0xBEEF, virtualMs = 30000, steps = [16.6667, 33.3333, 50] } = {}) {
  const c = api();
  const out = [];
  for (const dtMs of steps) {
    const n = Math.round(virtualMs / dtMs);
    await armOffline();
    let row;
    try {
      c.seedSimRng(seed);
      c.resetSimulation({ resetOats: true, spawnAgents: true });
      c.params.statsReadbackEnabled = true;
      const start = c.refreshRuntimeReadbackStats().visibleAgents;
      const curve = [];
      for (let i = 0; i < n; i++) {
        step(dtMs);
        if ((i + 1) % Math.round(n / 6) === 0) {
          curve.push(c.refreshRuntimeReadbackStats().visibleAgents);
        }
      }
      row = {
        dtMs: +dtMs.toFixed(3),
        rawDt: +(dtMs / 16.6667).toFixed(3),
        calls: n,
        dtUnits: +(n * (dtMs / 16.6667)).toFixed(0),
        virtualMs: Math.round(n * dtMs),
        start,
        end: c.refreshRuntimeReadbackStats().visibleAgents,
        curve,
      };
    } finally { exitOffline(); }
    out.push(row);
    await new Promise((r) => setTimeout(r, 0));
  }
  return { seed, virtualMs, rows: out };
}

/**
 * Ground truth: what does the UNMODIFIED live game actually do?
 *
 * No armOffline, no resetSimulation, no seeded RNG — main.js has already booted
 * itself exactly as it does for a player (resetOats:true, spawnAgents:false,
 * started=true), and the clock stays in LIVE mode so performance.now() is real
 * wall time and rawDt reflects genuine frame pacing. The only thing done here is
 * what a player does: start the world.
 *
 * Runs on the clock shim's MessageChannel pump, so it works in a hidden tab
 * where rAF never fires.
 */
async function liveRun({ seconds = 90, sampleEvery = 10, skipIntro = true, offlineDt = 0, yieldEvery = 0, jitter = 0, warmMs = 8000 } = {}) {
  const c = api();
  c.params.statsReadbackEnabled = true;

  let frames = 0;
  const unhook = onFrame(() => { frames++; });
  const curve = [];
  const t0 = clock.realNow();
  // Read the food field in a window around the initial oat — where the agents
  // actually are. This distinguishes "the oat is weak" from "the field is not
  // holding the food the oat supplies".
  const FW = 160;
  const fieldBuf = new Float32Array(FW * FW * 4);
  const readFieldNearOat = () => {
    const o = c.oats[0];
    if (!o?.uv) return null;
    const size = c.fieldRT.read.width;
    const x = Math.max(0, Math.min(size - FW, Math.round(o.uv.x * size) - FW / 2));
    const y = Math.max(0, Math.min(size - FW, Math.round(o.uv.y * size) - FW / 2));
    try {
      c.renderer.readRenderTargetPixels(c.fieldRT.read, x, y, FW, FW, fieldBuf);
    } catch { return null; }
    let sum = 0, peak = 0;
    for (let i = 0; i < fieldBuf.length; i += 4) {
      const v = fieldBuf[i];
      if (v > 0) { sum += v; if (v > peak) peak = v; }
    }
    return { sum: +sum.toFixed(1), peak: +peak.toFixed(4) };
  };

  const sample = (elapsed) => {
    const o = c.oats[0] ?? null;
    const f = readFieldNearOat();
    // Mouse repel is sticky: mouseRepelState stays active until a pointerleave
    // or a failed raycast clears it, with no timeout. A cursor left resting over
    // the colony therefore pushes agents off their food for the whole run, and
    // the signature — population falling WHILE field food rises — is exactly the
    // signature of ordinary starvation. Always record it so the two can never be
    // confused again.
    const m = c.getMouseRepelState ? c.getMouseRepelState() : null;
    curve.push({
      t: +elapsed.toFixed(1),
      frames,
      agents: c.refreshRuntimeReadbackStats().visibleAgents,
      oats: c.oats.length,
      // The food source itself, so a starving colony can be traced to its cause
      // rather than guessed at: is the oat weak, or is the field not holding food?
      now: Math.round(performance.now()),
      fieldSum: f?.sum ?? null,
      fieldPeak: f?.peak ?? null,
      repelActive: m ? !!m.active : null,
      repelDistFromOat: (m?.active && m.uv && o?.uv)
        ? +Math.hypot(m.uv.x - o.uv.x, m.uv.y - o.uv.y).toFixed(4) : null,
      // The initial oat is NOT stable across boots: the viewport-centre raycast
      // misses and falls back to updateInitialOatFromCameraRotationCenter, so
      // its UV moves. Recorded here because it makes cross-boot comparisons
      // invalid unless it is checked.
      oatUv: o?.uv ? [+o.uv.x.toFixed(4), +o.uv.y.toFixed(4)] : null,
      oatPower: o ? +Number(o.power).toFixed(4) : null,
      decayStartedAt: o?.foodDecayStartedAt != null ? Math.round(o.foodDecayStartedAt) : null,
      decayElapsedMs: o?.foodDecayStartedAt != null ? Math.round(performance.now() - o.foodDecayStartedAt) : null,
    });
  };

  // Controlled initial condition. Boot leaves the world with the initial oat and
  // NO agents, and how long it then sits before seeding depends on how long boot
  // happened to take — which varied run to run and silently confounded earlier
  // comparisons (one run seeded into an empty field, another into 5s of charge).
  // So the warm-up is now explicit and identical in both modes.
  const warmThenSeed = async () => {
    if (offlineDt > 0) await armOffline();
    if (warmMs > 0) {
      if (offlineDt > 0) {
        for (let i = 0; i < Math.round(warmMs / offlineDt); i++) step(offlineDt);
      } else {
        const until = clock.realNow() + warmMs;
        while (clock.realNow() < until) await new Promise((r) => setTimeout(r, 50));
      }
    }
    sample(0);
    if (skipIntro) {
      c.skipIntroSequence();
      c.replayInitialAgentSeed({ playSound: false });
    }
  };

  try {
    await warmThenSeed();
    if (offlineDt > 0) {
      try {
        const total = Math.round((seconds * 1000) / offlineDt);
        const every = Math.round((sampleEvery * 1000) / offlineDt);
        for (let i = 0; i < total; i++) {
          // jitter perturbs only the REGULARITY of virtual time, not its rate.
          // dt 1.0->3.0 was already shown to barely move the population, so a
          // few percent of jitter is a negligible physics change — but it fully
          // decorrelates hash(n) = fract(sin(n*127.1 + u_time*41.7)*K), which a
          // perfectly uniform dt samples on a ~5-frame cycle.
          step(jitter > 0 ? offlineDt * (1 + (Math.random() - 0.5) * 2 * jitter) : offlineDt);
          // Draining to a macrotask each step makes the GPU pipeline behave as
          // it does live (fences complete, readbacks settle) while time stays
          // virtual — separating "tight synchronous loop" from "virtual clock".
          if (yieldEvery > 0 && i % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
          if (i % every === 0) sample((i * offlineDt) / 1000);
        }
      } finally { exitOffline(); }
    } else {
      const seedAt = clock.realNow();
      let nextAt = sampleEvery;
      while ((clock.realNow() - seedAt) / 1000 < seconds) {
        await new Promise((r) => setTimeout(r, 100));
        const elapsed = (clock.realNow() - seedAt) / 1000;
        if (elapsed >= nextAt) { nextAt += sampleEvery; sample(elapsed); }
      }
    }
  } finally { unhook?.(); }

  const wallSec = (clock.realNow() - t0) / 1000;
  return {
    mode: offlineDt > 0 ? `offline dt=${offlineDt}ms` : 'live',
    seconds,
    frames,
    measuredFps: +(frames / wallSec).toFixed(1),
    impliedRawDt: offlineDt > 0 ? +(offlineDt / 16.6667).toFixed(2)
      : +Math.min(2.2, (wallSec * 1000) / frames / 16.6667).toFixed(2),
    params: { oatSupplyRate: c.params.oatSupplyRate, useOatRationing: c.params.useOatRationing, fieldDecay: c.params.fieldDecay },
    curve,
  };
}

/**
 * Hold the LIVE game on a visible story callout, so Chrome's own rendering of it
 * can be screenshotted as the reference the Canvas2D compositor must match.
 *
 * Deliberately never enters offline mode and never constructs the overlay
 * compositor. The compositor pauses every animation in the annotation layer so
 * it can recompute them from virtual time, which means a screenshot taken during
 * a render shows a frozen, half-built callout — useless as a reference. Live, the
 * DOM animations run normally and the callout is the genuine article: real
 * backdrop-filter, real mask-composite, real font metrics.
 */
async function liveCallout({ growTicks = 2600, seed = 48879, timeoutMs = 180000 } = {}) {
  const c = api();
  c.params.statsReadbackEnabled = true;
  c.seedSimRng(seed);
  c.resetSimulation({ resetOats: true, spawnAgents: true });
  c.skipIntroSequence();

  // Build a colony fast. growFast skips updateOatFoodDecay, which is wrong for
  // measuring population but fine for producing slime to look at.
  c.growFast(growTicks);

  const placed = [];
  const half = 160;
  const buf = new Uint16Array(2 * half * 2 * half * 4);
  const h2f = (h) => {
    const s2 = (h & 0x8000) ? -1 : 1;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0) return s2 * 6.103515625e-5 * (f / 1024);
    if (e === 0x1f) return NaN;
    return s2 * 2 ** (e - 15) * (1 + f / 1024);
  };
  const rt = c.renderSampleViewRT?.read ?? c.fieldRT.read;
  const size = rt.width;
  const win = 2 * half;
  const b = c.oats[0].uv;
  const x0 = Math.max(0, Math.min(size - win, Math.round(b.x * size) - half));
  const y0 = Math.max(0, Math.min(size - win, Math.round(b.y * size) - half));
  for (let k = 0; k < 4; k++) {
    let best = null;
    try { c.renderer.readRenderTargetPixels(rt, x0, y0, win, win, buf); } catch { break; }
    for (let j = 0; j < win; j += 3) {
      for (let i = 0; i < win; i += 3) {
        const val = h2f(buf[(j * win + i) * 4]);
        if (!(val > 0.004)) continue;
        const u = (x0 + i) / size;
        const v = (y0 + j) / size;
        let ok = true;
        for (const o of c.oats) {
          if (!o.uv) continue;
          const du = u - o.uv.x; const dv = v - o.uv.y;
          if (du * du + dv * dv < 0.053 * 0.053) { ok = false; break; }
        }
        if (ok && (!best || val > best.val)) best = { u, v, val };
      }
    }
    if (!best) break;
    const before = c.oats.length;
    c.addOat(best.u, best.v);
    placed.push({ ...best, accepted: c.oats.length > before });
  }

  // Wait for a callout to trigger AND actually become visible in the DOM.
  const t0 = clock.realNow();
  while (clock.realNow() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
    const el = [...document.querySelectorAll('.observation-callout')]
      .find((n) => Number(getComputedStyle(n).opacity) > 0.6);
    if (el) {
      const r = el.getBoundingClientRect();
      return {
        placed,
        visible: true,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        triggered: c.oats.filter((o) => o.observation?.triggered).length,
        waitedMs: Math.round(clock.realNow() - t0),
      };
    }
  }
  return { placed, visible: false, triggered: c.oats.filter((o) => o.observation?.triggered).length };
}

/**
 * Cold start vs charged field.
 *
 * Real boot is resetSimulation({resetOats:true, spawnAgents:FALSE}) — the world
 * starts with the initial oat and ZERO agents, and stays that way through the
 * whole intro (INTRO_OAT_SEQUENCE_MS = 10s) while the oat pumps food into
 * fieldRT. Agents are only seeded afterwards, into an already-rich field.
 *
 * The recorder instead spawned 4096 agents at tick 0 into the field that
 * resetSimulation had just cleared. Rationing scales uptake by local density,
 * and 4096 agents in one Gaussian blob of sigma=0.45*oatRadius is the densest
 * the field ever gets — so they ration each other down to nothing before the
 * oat has deposited anything to eat.
 *
 * Sweeps the charge time to show the effect size.
 */
async function chargeSweep({ seed = 0xBEEF, warmMs = [0, 2500, 5000, 10000], runMs = 30000 } = {}) {
  const c = api();
  const dtMs = 1000 / 60;
  const out = [];
  for (const warm of warmMs) {
    await armOffline();
    let row;
    try {
      c.seedSimRng(seed);
      // Boot exactly as main.js does: oat present, no agents.
      c.resetSimulation({ resetOats: true, spawnAgents: false });
      c.params.statsReadbackEnabled = true;
      for (let i = 0; i < Math.round(warm / dtMs); i++) step(dtMs);
      // Seed exactly as the intro does: progressive reveal over
      // INITIAL_AGENT_SEED_DURATION_MS, driven by updateInitialAgentSeeding(now)
      // inside the frame loop — not an instant initAgents() dump.
      c.replayInitialAgentSeed({ playSound: false });
      const seeded = c.refreshRuntimeReadbackStats().visibleAgents;
      const n = Math.round(runMs / dtMs);
      const curve = [];
      for (let i = 0; i < n; i++) {
        step(dtMs);
        if ((i + 1) % Math.round(n / 6) === 0) curve.push(c.refreshRuntimeReadbackStats().visibleAgents);
      }
      row = {
        warmMs: warm,
        seeded,
        end: c.refreshRuntimeReadbackStats().visibleAgents,
        curve,
      };
    } finally { exitOffline(); }
    out.push(row);
    await new Promise((r) => setTimeout(r, 0));
  }
  return { seed, runMs, rows: out };
}

/**
 * M1 determinism gate.
 *
 * Seed, reset, grow N ticks, hash. Twice. Identical hashes mean the simulation
 * is a pure function of (seed, tick count) on this machine; a mismatch means
 * something is still reading wall time or unseeded randomness.
 *
 * This is the in-process form, which the plan notes is the WEAKER of the two —
 * it shares warmed module state and so cannot catch initialisation-order bugs.
 * A cold-reload comparison is the real gate; this one is the fast smoke test.
 */
async function determinismTest({
  seed = 12345, ticks = 400, runs = 2, virtualClock = true, clockOrigin = 100000,
  isolate = false, onRun = null,
} = {}) {
  const c = api();
  const results = [];

  // Isolate the couplings the plan flagged as sim-affecting-but-not-obvious.
  // storyBoxes gates triggerOatObservation, whose async GPU readback decides
  // which frame decay starts on -> oatRT -> the field. The two controller flags
  // let measured frame rate write sim params.
  if (isolate) {
    c.params.storyBoxesEnabled = false;
    c.params.statsReadbackEnabled = false;
    c.params.usePopulationControl = false;
  }

  for (let r = 0; r < runs; r++) {
    c.seedSimRng(seed);
    c.resetSimulation({ resetOats: true, spawnAgents: true });

    if (virtualClock) {
      // Step through the shimmed clock with a FIXED origin, so u_time —
      // and therefore the GPU agent hash at main.js:3042 — replays identically.
      // growFast() cannot do this: it seeds its own `t` from performance.now(),
      // which is real time in live mode and differs every run.
      await armOffline({ startMs: clockOrigin });
      try {
        for (let i = 0; i < ticks; i++) step(1000 / 60);
      } finally { exitOffline(); }
    } else {
      c.growFast(ticks);
    }

    const h = c.hashSimState();
    results.push(h);
    if (onRun) await onRun(r, h);
    await new Promise((res) => setTimeout(res, 0));
  }
  const first = results[0];
  const identical = results.every(
    (h) => h.field === first.field && h.agents === first.agents && h.rng === first.rng,
  );
  return {
    seed, ticks, runs, identical, results,
    virtualClock, isolate,
    verdict: identical ? 'DETERMINISTIC (in-process)' : 'DIVERGED',
  };
}

/**
 * Isolate GPU nondeterminism from CPU-side state contamination.
 *
 * Last night's gate compared runs that each went through resetSimulation +
 * re-seeding, so a mismatch could have come from either the GPU or from state
 * resetSimulation does not restore. This test removes that ambiguity: snapshot
 * the exact float buffers once, then repeatedly restore THAT SAME state and run
 * N ticks. Every run starts from bit-identical input, so any difference in the
 * output is the GPU alone.
 *
 * If this comes back identical, the simulation is reproducible given exact
 * initial state, and the replay design is viable — the problem was never the
 * GPU, only how faithfully the starting state is reconstructed.
 */
async function gpuDeterminismTest({ ticks = 200, runs = 3, growFirst = 600, onRun = null } = {}) {
  const c = api();
  c.params.storyBoxesEnabled = false;
  c.params.statsReadbackEnabled = false;
  c.params.usePopulationControl = false;

  c.seedSimRng(12345);
  c.resetSimulation({ resetOats: true, spawnAgents: true });
  if (growFirst > 0) c.growFast(growFirst);
  await c.saveState('gpuprobe');
  const allocAtSnapshot = c.getAgentAllocationFrame();

  const results = [];

  // Enter offline mode ONCE and hold it for the whole test.
  //
  // Doing it per-run is a trap: exitOffline() resumes the live loop, and both
  // the async loadState (IndexedDB) and armOffline's own polling then let an
  // arbitrary number of LIVE sim ticks execute after the restore but before
  // controlled stepping begins. That is nondeterministic by construction and
  // looks exactly like GPU nondeterminism. The tell was allocFrame advancing by
  // 219/231/238/249/256 between runs that each stepped exactly 200 ticks.
  //
  // While offline, rAF callbacks are captured rather than scheduled, so nothing
  // simulates except step().
  await armOffline({ startMs: 100000 });
  try {
    for (let r = 0; r < runs; r++) {
      const loaded = await c.loadState('gpuprobe');
      if (loaded?.error) throw new Error(`loadState failed: ${loaded.error}`);
      // Restore the allocation counter too. loadState only uploads fieldRT and
      // agentRT; this counter decides agent slot packing and therefore splat
      // blend order, so leaving it advancing changes the result from identical
      // input.
      c.setAgentAllocationFrame(allocAtSnapshot);
      const restored = c.hashSimState();

      for (let i = 0; i < ticks; i++) step(1000 / 60);

      const after = c.hashSimState();
      const row = { run: r, restored, after };
      results.push(row);
      if (onRun) await onRun(row);
    }
  } finally { exitOffline(); }

  const restoreIdentical = results.every(
    (x) => x.restored.field === results[0].restored.field && x.restored.agents === results[0].restored.agents,
  );
  const afterIdentical = results.every(
    (x) => x.after.field === results[0].after.field && x.after.agents === results[0].after.agents,
  );
  const sums = results.map((x) => x.after.fieldSum);
  const spread = Math.max(...sums) - Math.min(...sums);

  return {
    ticks, runs, growFirst,
    restoreIdentical,      // did loadState actually give us the same starting point?
    afterIdentical,        // is the GPU deterministic from identical input?
    fieldSums: sums,
    spreadPercent: +((spread / Math.max(...sums)) * 100).toFixed(5),
    verdict: !restoreIdentical
      ? 'INCONCLUSIVE — restore is not bit-identical'
      : afterIdentical
        ? 'GPU IS DETERMINISTIC from identical state'
        : 'GPU IS NONDETERMINISTIC from identical state',
    results,
  };
}

/**
 * Record a session.
 *
 * `player` is a fn(tick, api) that stands in for a human: it drives the camera
 * and places oats. Whatever it does is captured as resolved intents, so replay
 * consumes the recording alone and never re-runs the player.
 */
/**
 * Press Begin on the virtual clock and wait until the intro is actually armed.
 *
 * requestIntroStart() is async: it awaits the intro clip's decode (bounded by a
 * 4s setTimeout race) before stamping startScreenUiState.clickedAt and
 * introSequenceState.requestedAt. Those stamps are taken with performance.now(),
 * which is virtual once armed — so the click has to happen AFTER armOffline, or
 * the intro's whole timeline is anchored to a real timestamp the session will
 * never reach.
 *
 * The await also means the click cannot simply be fired and stepped past: in a
 * synchronous tick loop the continuation would not run until the loop yielded,
 * and the intro would begin hundreds of ticks late. So resolve it here first.
 */
async function pressBegin({ timeoutMs = 30000 } = {}) {
  const c = api();
  const btn = document.getElementById('startButton');
  if (!btn) throw new Error('start button not found — cannot record from Begin');

  // Boot requests the intro by itself, anchored to the performance.now() of that
  // moment. The virtual clock starts far later, so without rewinding first the
  // sequence reads as long finished: requestIntroStart() returns immediately,
  // nothing is captured, and — because the recording starts with no agents on
  // purpose — the intro never seeds the colony either, leaving a session with
  // zero agents throughout. (Measured: 7 oats placed, 0 story triggers, every
  // slime score 0.) Rewinding re-anchors the sequence onto the virtual clock.
  c.resetIntroSequenceToStartScreen?.(performance.now());

  btn.disabled = false;
  btn.hidden = false;
  btn.click();

  const t0 = clock.realNow();
  while (clock.realNow() - t0 < timeoutMs) {
    const intro = c.getIntroSequenceState?.() ?? {};
    if (intro.requested && Number.isFinite(intro.requestedAt) && intro.requestedAt > 0) {
      return { requestedAt: Math.round(intro.requestedAt), waitedMs: Math.round(clock.realNow() - t0) };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('intro never armed after clicking Begin');
}

async function recordSession({
  ticks = 900, seed = 0xC0FFEE, player = null, name = 'session.cvr',
  // Capture the piece as a viewer sees it: from the Begin click, through the
  // starting sequence and the progressive initial seeding, rather than starting
  // mid-life with 4096 agents already on the mesh.
  fromBegin = false,
} = {}) {
  const rec = createRecorder({ api, clock, buildStamp: document.querySelector('meta[name=build]')?.content ?? null });

  // Arm the virtual clock BEFORE rec.start(), and let it continue from real
  // time rather than jumping to an arbitrary origin.
  //
  // rec.start() calls resetSimulation -> addInitialOat -> startOatFoodDecay,
  // which stamps oat.foodDecayStartedAt with performance.now(). If that stamp
  // is taken on the real clock and the session then runs on a virtual clock
  // starting somewhere else, updateOatFoodDecay measures a bogus elapsed.
  //
  // Measured with the old ordering (stamp at real 12088, clock jumped to
  // 100000): the initial oat read as ~88s into its 90s decay from tick 0, so it
  // sat at the 1/3 floor multiplier for the whole recording and the colony
  // starved — 4096 agents down to 647. Arming first makes elapsed start at 0,
  // which is what a player sees.
  await armOffline();

  const header = rec.start({ seed, spawnAgents: !fromBegin });
  let begin = null;
  if (fromBegin) {
    begin = await pressBegin();
    log('Begin pressed', begin);
  }
  log('recording started', header.rngSeed, fromBegin ? '(from Begin click)' : '');
  try {
    for (let t = 0; t < ticks; t++) {
      if (player) player(t, api());
      rec.sample();               // capture resolved state for THIS tick
      step(1000 / 60);
      // The intro's own continuations (audio decode, sprite scheduling) are
      // async. Draining to a macrotask periodically lets them land at roughly
      // the right tick instead of all at once when the loop finally yields.
      if (fromBegin && t % 30 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  } finally { exitOffline(); }

  const recording = rec.stop();
  const json = JSON.stringify(recording);
  const save = await deliverFile(name, json, 'application/json');

  return {
    name, save,
    totalTicks: recording.totalTicks,
    bytes: json.length,
    kbPerMinute: +((json.length / 1024) / (recording.totalTicks / 60 / 60)).toFixed(1),
    fromBegin, begin,
    // Whether the footage will actually contain story callouts. A box is earned
    // by the colony growing over an oat until its slime score clears the trigger
    // threshold, so this cannot be assumed from the number of oats placed.
    story: describeObservations(),
    ...rec.stats(),
  };
}

/** How many oats have actually produced a story callout, and which. */
function describeObservations() {
  const c = api();
  const oats = c.oats ?? [];
  const rows = oats.map((o, i) => ({
    i,
    initial: !!o.initial,
    suppressed: !!o.suppressObservation,
    triggered: !!o.observation?.triggered,
    score: o.observation?.slimeTriggerScore != null
      ? +Number(o.observation.slimeTriggerScore).toFixed(4) : null,
    hasText: !!o.storyText || !!o.observation?.textLines?.length,
  }));
  const eligible = rows.filter((r) => !r.initial && !r.suppressed);
  return {
    threshold: c.params?.observationSlimeTriggerThreshold ?? null,
    storyBoxesEnabled: c.params?.storyBoxesEnabled !== false,
    oats: oats.length,
    eligible: eligible.length,
    triggered: eligible.filter((r) => r.triggered).length,
    rows,
  };
}

/**
 * Page-render mode: let CHROME draw the overlays, and capture its output.
 *
 * replay/overlays.js repaints the story callout by hand in Canvas2D — emulating
 * backdrop-filter blur+saturate, two crossed gradient masks with
 * mask-composite:intersect, the feather outset, the stroke, the tail, EB Garamond
 * metrics, and the per-line reveal (after pausing every WAAPI animation so it can
 * recompute them from virtual time). Every one of those is an approximation of
 * something the browser already does exactly, and they went wrong repeatedly:
 * most visibly, the emulated backdrop blur smeared across the whole frame, so the
 * entire creature went soft the instant a callout appeared.
 *
 * Driving through Playwright makes the painter unnecessary. Chrome renders the
 * real DOM over the real canvas, with real backdrop-filter and real fonts, and
 * its animations already run on performance.now() — which IS the virtual clock
 * during an offline render, so nothing needs pausing or recomputing. Node steps
 * the simulation one frame at a time and screenshots the composited page.
 *
 * This function only prepares and exposes the controls; Node owns the loop.
 */
async function preparePageRender({
  file = 'session.cvr', width = 1280, height = 720, fps = 60, speed = 1, ss = 2,
} = {}) {
  const recording = await loadRecording(file);
  const player = createPlayer({ api, recording });
  const total = recording.totalTicks;

  // Wall-time axis, exactly as replayToVideo: the film runs at the pace the
  // session was lived, and main.js re-derives (and re-clamps) sim dt from the
  // virtual clock steps.
  const UNIT = 10;                                // integer units per wall ms
  const cumT = new Float64Array(total + 1);
  {
    let cumFloat = 0;   // prefix-rounded — see replayToVideo's schedule note
    for (let i = 0; i < total; i++) {
      cumFloat += player.wallMsAt(i);
      cumT[i + 1] = Math.round(cumFloat * UNIT);
    }
  }
  const totalUnits = cumT[total];
  const wallDurationMs = totalUnits / UNIT;
  const simDurationMs = wallDurationMs; // reported duration IS the lived duration now
  const frames = Math.max(1, Math.round((wallDurationMs / speed / 1000) * fps));
  const targetT = (i) => Math.min(totalUnits, Math.round((i * 1000 * UNIT * speed) / fps));

  const sized = setRenderSize(width, height, ss);
  log('page-render', { width, height, ss, fps, frames, sized });

  await armOffline();
  player.begin();
  if (qs.get('nomesh') === '1' && api().mesh) api().mesh.visible = false;

  // Defeat Chrome's vertical glyph snapping.
  //
  // Chrome snaps glyph origins to whole RASTER pixels vertically. The story
  // scroll glides at 0.1118 css px/frame, so at ss=2 the text can only move once
  // every ~4.5 frames — a ~13 Hz staircase, independent of output frame rate,
  // encoder or downscale.
  //
  // Isolated micro-benchmark (replay/snap-probe.mjs), 24 frames at the artwork's
  // own glide rate, counting frames where the rasterised text did not move:
  //
  //             ss=2    ss=4    ss=8   raster step
  //   translateY 18/23  13/23   2/23     1.01 px
  //   translate3d 18/23 13/23   2/23     1.01 px
  //   will-change 18/23 13/23   2/23     1.01 px
  //   filter layer 18/23 13/23  2/23     1.01 px
  //   top          20/23 20/23 20/23     up to 6 px
  //   rotate 0.02deg 0/23  0/23  0/23     0.27 px
  //
  // A tiny rotation makes the layer non-axis-aligned, and Chrome cannot pixel
  // snap content it has to resample — so the text moves every single frame. The
  // rotation has to sit on an ANCESTOR because the artwork's own animation owns
  // the roll's transform; measured on the ancestor it is just as effective
  // (0/23 at ss=2/4/8). 0.006deg is NOT enough (17/23 frozen) — the layer has to
  // be meaningfully off-axis. At 0.02deg the skew across the 230px callout is
  // 230*tan(0.02deg) = 0.08 px, i.e. invisible.
  if (qs.get('smoothtext') !== '0') {
    const st = document.createElement('style');
    // The scrolling text's viewport is .observation-text-viewport (main.js:7196),
    // NOT .observation-text — an earlier attempt used the latter, matched
    // nothing, and measured as "rotation does not help".
    //
    // will-change:transform is set on the roll by the stylesheet itself
    // (styles.css:369-371), so it is permanently its own composited layer and
    // snaps independently of any ancestor. It has to be overridden, the
    // animation has to be cancelled (?adoptscroll), and only then does the
    // ancestor rotation force resampling instead of snapping.
    st.textContent =
      '.observation-text-roll{will-change:auto!important;}'
      + '.observation-text-viewport{transform:rotate(0.02deg);}';
    document.head.append(st);
  }

  const arec = createAudioRecorder({ api, simHz: recording.simHz });
  arec.hook();
  if (player.fromBegin) log('page-render pressed Begin', await pressBegin());

  // The story callout's per-line reveal and vertical scroll are Web Animations
  // (main.js:6851, 6920) running on document.timeline — WALL CLOCK. Offline that
  // is disastrous in a way that reads as "the text never appears": the render
  // advances a few output frames per real second, so an animation created at
  // virtual 33s lives out its whole ~20s lifetime in 20 REAL seconds — under two
  // seconds of finished video, then gone.
  //
  // The old compositor solved this by pausing them and re-deriving the mask and
  // scroll arithmetically, which is how it ended up reimplementing the whole
  // callout. Pin them to the virtual clock instead and let Chrome render the
  // result natively: pause on first sight, then drive currentTime directly. An
  // animation is first seen within one tick of its creation, so treating that
  // moment as its origin is exact to a frame.
  const animOrigin = new WeakMap();

  // The scroll animation must be taken off the compositor.
  //
  // main.js animates .observation-text-roll with translate3d (main.js:6884),
  // which promotes it to its own compositing layer — and Chrome snaps a
  // composited layer's position to WHOLE DEVICE PIXELS. The scroll advances
  // 0.1118 css px/frame at 60fps, i.e. 0.22 device px at ss=2, so the layer sits
  // still for four frames and then jumps a pixel. Measured in the page, the
  // animated value is flawless (ty stepping exactly -0.1118 every frame,
  // currentTime exactly +16.67ms); it is the RASTER that quantises, so the text
  // crawls at ~15fps inside a 60fps film.
  //
  // Fix: cancel the animation, and drive the same value ourselves as a plain 2D
  // translate in an inline style. A 2D transform on an unpromoted element is
  // rasterised into its parent at sub-pixel precision. The keyframes are read
  // straight off the effect and the easing is linear at both levels, so the
  // piecewise lerp reproduces the artwork's own curve exactly — this replaces
  // the animation's DRIVER, not its design, and Chrome still paints everything.
  const scrollDrivers = new Map();
  const parseTranslateY = (t) => {
    if (!t) return null;
    let m = /translate3d\(\s*[^,]+,\s*(-?[\d.eE+-]+)px/.exec(t);
    if (m) return Number.parseFloat(m[1]);
    m = /translateY\(\s*(-?[\d.eE+-]+)px/.exec(t);
    if (m) return Number.parseFloat(m[1]);
    m = /matrix\((?:[^,]+,){5}\s*(-?[\d.eE+-]+)\)/.exec(t);
    return m ? Number.parseFloat(m[1]) : null;
  };

  // Diagnostics: ?rawscroll=1 leaves the scroll on its original composited
  // translate3d so the two paths can be A/B'd in one build, and ?nomesh=1 hides
  // the creature so the text can be measured on black with nothing else moving
  // in frame. Measuring the text over the animated mesh is what let earlier
  // "improvements" look real when they were not.
  const RAW_SCROLL = qs.get('rawscroll') === '1';

  function adoptScrollAnimation(anim) {
    if (RAW_SCROLL) return false;
    let target = null;
    try { target = anim.effect?.target ?? null; } catch { return false; }
    if (!target?.classList?.contains('observation-text-roll')) return false;
    let kfs = [];
    let duration = 0;
    try {
      kfs = anim.effect.getKeyframes() ?? [];
      duration = Number(anim.effect.getTiming()?.duration) || 0;
    } catch { return false; }
    const points = kfs
      .map((k) => ({ o: Number(k.computedOffset ?? k.offset ?? 0), y: parseTranslateY(k.transform) }))
      .filter((pt) => Number.isFinite(pt.o) && Number.isFinite(pt.y));
    if (points.length < 2 || duration <= 0) return false;
    try { anim.cancel(); } catch { /* already gone */ }
    scrollDrivers.set(anim, { el: target, points, duration });
    return true;
  }

  function driveScroll(virtualMs) {
    for (const [anim, d] of scrollDrivers) {
      const origin = animOrigin.get(anim);
      if (origin == null) continue;
      const p = Math.max(0, Math.min(1, (virtualMs - origin) / d.duration));
      const pts = d.points;
      let y = pts[pts.length - 1].y;
      for (let i = 1; i < pts.length; i++) {
        if (p <= pts[i].o) {
          const a = pts[i - 1];
          const b = pts[i];
          const span = b.o - a.o;
          const t = span > 1e-9 ? (p - a.o) / span : 0;
          y = a.y + (b.y - a.y) * t;
          break;
        }
      }
      // 2D, deliberately: translate3d would put it back on the compositor.
      d.el.style.transform = `translateY(${y.toFixed(3)}px)`;
    }
  }

  function syncDomAnimations(virtualMs) {
    let docAnims;
    try { docAnims = document.getAnimations(); } catch { return 0; }
    let n = 0;
    for (const anim of docAnims) {
      if (!animOrigin.has(anim)) {
        animOrigin.set(anim, virtualMs);
        // adoptScroll alone WAS a no-op (24/35 vs 25/35 frozen — Chrome snaps
        // vertical text on any composited layer, whatever drives the value).
        // It became load-bearing once ?smoothtext added the two missing pieces:
        // will-change:auto on the roll and rotate(0.02deg) on the viewport.
        // Rotation forces Chrome to RESAMPLE instead of snap — but only if the
        // roll is not its own layer, and an active WAAPI transform animation
        // promotes it regardless of will-change. So the animation must be
        // cancelled (this driver) AND the ancestor rotated; either alone
        // measured as a no-op. render-page.mjs passes both by default.
        if (qs.get('adoptscroll') === '1' && adoptScrollAnimation(anim)) continue;
        try { anim.pause(); } catch { /* a finished animation rejects pause */ }
      }
      if (scrollDrivers.has(anim)) continue;
      try {
        anim.currentTime = Math.max(0, virtualMs - animOrigin.get(anim));
        n++;
      } catch { /* read-only once finished */ }
    }
    // Setting currentTime only marks the animation dirty. Chrome resolves
    // animated values on its own rendering lifecycle, so without forcing a style
    // recalculation here the captured frame can show a STALE animated value:
    // measured on a 60fps render, the text held position for three frames then
    // jumped ~0.7 device px — the scroll running at ~15fps inside a 60fps film.
    // Reading a layout property flushes style and animation resolution.
    driveScroll(virtualMs);
    if (n) { try { void document.body.offsetHeight; } catch { /* ignore */ } }
    return n + scrollDrivers.size;
  }

  let cursor = 0;
  let lastAnimCount = 0;
  const ctl = {
    frames,
    total,
    fps,
    simDurationMs,
    /** Advance the simulation to output frame f and leave it drawn. */
    advance(f) {
      const cutoff = targetT(f + 1);
      while (cursor < total && cumT[cursor + 1] <= cutoff) {
        player.applyTick(cursor);
        arec.sample(cursor);
        step(player.wallMsAt(cursor));
        cursor++;
      }
      // After the draw, so animations created during this tick are caught and
      // pinned before the page is photographed.
      lastAnimCount = syncDomAnimations(clock.virtualMs);
      return cursor;
    },
    get domAnimations() { return lastAnimCount; },
    /** Render the soundtrack and save it as a WAV for ffmpeg to mux. */
    async finishAudio(name = 'audio.wav') {
      exitOffline();
      arec.unhook();
      const buffer = await renderSessionAudio({
        api,
        events: arec.events,
        spatial: arec.spatial,
        totalTicks: cursor,
        simHz: recording.simHz,
        speed,
        tickToSec: (tick) => cumT[Math.min(Math.max(0, tick), total)] / UNIT / 1000,
        sampleRate: 48000,
        durationSeconds: frames / fps,
      });
      const wav = audioBufferToWav(buffer);
      const save = await fetch(`/__save?name=${encodeURIComponent(name)}`, { method: 'POST', body: wav })
        .then((r) => r.json());
      return { save, seconds: +buffer.duration.toFixed(3), ...arec.stats(), ...(buffer.replayReport ?? {}) };
    },
    stats: () => ({ frames, simulatedTicks: cursor, recordedTicks: total, domAnimations: lastAnimCount, mismatches: player.mismatches }),
  };
  window.__pr = ctl;
  return { frames, total, simDurationMs: +simDurationMs.toFixed(1) };
}

/** Minimal PCM16 WAV writer — ffmpeg muxes this alongside the frame stream. */
function audioBufferToWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const len = buffer.length;
  const rate = buffer.sampleRate;
  const bytes = 44 + len * numCh * 2;
  const ab = new ArrayBuffer(bytes);
  const view = new DataView(ab);
  const str = (off, s2) => { for (let i = 0; i < s2.length; i++) view.setUint8(off + i, s2.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * numCh * 2, true); view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, len * numCh * 2, true);
  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return ab;
}

/** Load a recording and render it to MP4. */
/**
 * Replay a recording to MP4.
 *
 * `speed` is playback rate: 1 = realtime, 0.5 = half-speed (slow motion, twice
 * as many frames), 2 = double speed (time-lapse).
 *
 * The tick->frame mapping is a cumulative RATIONAL schedule, not a loop count.
 * ticksPerFrame is frequently fractional — 60Hz to 24fps is 2.5, and slow motion
 * makes it less than 1, meaning some frames must consume ZERO ticks. So output
 * frame i targets tick floor(i * p / q) and the driver advances to that tick,
 * applying every intervening tick's intents. Frame count uses a half-open
 * interval, F = ceil(T * q / p) with frames 0..F-1; the intuitive "greatest i
 * whose target tick <= T" is off by one and would desync audio.
 */
async function replayToVideo({
  file = 'session.cvr', width = 1280, height = 720, fps = 30, speed = 1,
  name = 'replay.mp4', bpp = 0.12, onProgress = null,
  // Diagnostic tap: called once per output frame, after compositing and
  // before the encoder snapshots, with (f, {glCanvas, outCanvas}). This is
  // how the frost flicker was localised; costs nothing when unset.
  onFrame = null,
  // Layout stays width x height; the frame is rendered ss times larger. See
  // setRenderSize — this is what keeps the story text from looking soft.
  ss = 2,
} = {}) {
  const recording = await loadRecording(file);
  const player = createPlayer({ api, recording });

  const total = recording.totalTicks;

  // Schedule on the session's WALL TIME — the pace the player lived.
  //
  // The previous axis was accumulated sim-dt, and sim dt is CLAMPED at
  // FRAME_DT_CLAMP: on a 22fps machine each frame advances the sim 2.2 units
  // while ~2.7 units of real time pass, so a film built on that axis played
  // 1.16x faster than the session felt (measured on a real recording; the
  // player noticed before the numbers did). Advancing the virtual clock by the
  // recorded wall delta instead makes main.js re-derive — and re-clamp — the
  // sim dt exactly as it did live: identical simulation, film at lived speed,
  // and every wall-anchored subsystem (intro pacing, decay, reveals, audio
  // scheduling) at the pace the player actually experienced.
  //
  // Accumulate in INTEGER tenth-milliseconds. The recorder quantises wall
  // deltas to 0.1ms, so the running total is exact to 2^53, and the per-frame
  // cutoff is a deterministically ROUNDED PRODUCT rather than a float
  // accumulation — the old float-sum-vs-product schedule drifted by ~1e-9,
  // enough to land frames on the wrong side of the comparison, and 1074 of
  // 3603 frames came out byte-identical duplicates (an effective ~42fps film
  // whose irregular cadence read as choppy text).
  const TICK_MS = 1000 / 60;                      // one sim-dt unit, in ms
  const UNIT = 10;                                // integer units per wall ms
  const cumT = new Float64Array(total + 1);       // integer 0.1ms units before tick i
  let simUnitsTotal = 0;
  {
    // Round the RUNNING PREFIX, not each tick: per-tick rounding of a legacy
    // 16.6667ms reconstruction drifts +0.033ms/tick (+7 duplicate frames per
    // hour of ticks); prefix rounding bounds the error at half a unit total.
    let cumFloat = 0;
    for (let i = 0; i < total; i++) {
      cumFloat += player.wallMsAt(i);
      cumT[i + 1] = Math.round(cumFloat * UNIT);
      simUnitsTotal += player.dtAt(i);
    }
  }
  const totalUnits = cumT[total];
  const wallDurationMs = totalUnits / UNIT;
  const simDurationMs = simUnitsTotal * TICK_MS;
  const outDurationMs = wallDurationMs / speed;
  const frames = Math.max(1, Math.round((outDurationMs / 1000) * fps));
  // Cutoff for output frame i, in the same integer 0.1ms domain.
  const targetT = (i) => Math.min(totalUnits, Math.round((i * 1000 * UNIT * speed) / fps));
  log(
    `schedule: ${total} ticks = ${(wallDurationMs / 1000).toFixed(2)}s lived ` +
    `(${(simDurationMs / 1000).toFixed(2)}s simulated, mean dt ${(simUnitsTotal / Math.max(1, total)).toFixed(3)}), ` +
    `${frames} frames @${fps}fps` +
    `${player.hasWallStream ? '' : ' — legacy file: wall axis reconstructed by uniform stretch'}`,
  );

  const canvas = document.getElementById('sim');
  const outW = Math.round(width * ss);
  const outH = Math.round(height * ss);
  setRenderSize(width, height, ss);
  if (canvas.width !== outW || canvas.height !== outH) {
    throw new Error(`canvas is ${canvas.width}x${canvas.height}, expected ${outW}x${outH}`);
  }
  log(`layout ${width}x${height} css, output ${outW}x${outH} (ss=${ss})`);

  // Arm before begin() for the same reason recordSession does: begin() resets
  // the simulation, which stamps oat food decay off performance.now().
  await armOffline();
  player.begin();

  // The audio track must be DECLARED before output.start() — Mediabunny refuses
  // to add a track afterwards — even though its samples arrive last.
  const withAudio = qs.get('audio') !== '0';

  // Hook audio BEFORE pressing Begin. requestIntroStart() plays the intro clip
  // itself, synchronously, as part of the click — so with the recorder hooked
  // afterwards that cue was emitted into a void and the finished film had no
  // intro music at all, while every later cue (which happens inside the tick
  // loop) came through fine.
  const arec = withAudio ? createAudioRecorder({ api, simHz: recording.simHz }) : null;
  arec?.hook();

  // A session recorded from the Begin click opened with NO agents and let the
  // intro seed the colony. The replay has to open the same way, or it starts
  // mid-life with the colony already present and the whole starting sequence —
  // the descending oat sprite, the progressive reveal — is simply absent from
  // the render even though the recording captured it.
  if (player.fromBegin) {
    const begun = await pressBegin();
    log('replay pressed Begin', begun);
  }

  // Composite the DOM overlays (story callouts, ending fade, countdown) into
  // each frame. They live in the DOM, so a raw canvas capture omits them
  // entirely — and for this piece the story text is the work.
  const withOverlays = qs.get('overlays') !== '0';
  const overlays = withOverlays
    ? await createOverlayCompositor({ api, width: outW, height: outH })
    : null;

  const enc = await createMp4Encoder({
    canvas: overlays ? overlays.canvas : canvas,
    fps, bpp, withAudio,
  });
  await enc.start();

  const timings = [];
  let resizeCorrections = 0;
  let cursor = 0;   // ticks already simulated
  try {
    for (let f = 0; f < frames; f++) {
      const t0 = clock.realNow();
      // Advance until this frame's simulated-time cutoff, applying EVERY
      // intervening tick at the dt it was recorded with. May consume zero ticks
      // (slow motion) or several (time-lapse, or a stretch of slow live frames).
      const cutoff = targetT(f + 1);
      while (cursor < total && cumT[cursor + 1] <= cutoff) {
        player.applyTick(cursor);
        arec?.sample(cursor);      // absolute tick, not an index within the frame
        step(player.wallMsAt(cursor));
        cursor++;
      }
      if (assertRenderSize(width, height, ss)) {
        resizeCorrections++;
        // Redraw at the corrected size WITHOUT advancing the field. A plain
        // extra step would run another simulate(), and diffuseField() applies
        // params.fieldDecay once per call regardless of dt — so the old
        // full-tick redraw silently evaporated food every time the canvas moved.
        const c = api();
        const wasEnabled = c.getSimulateEnabled ? c.getSimulateEnabled() : true;
        c.setSimulateEnabled?.(false);
        try { step(0); } finally { c.setSimulateEnabled?.(wasEnabled); }
      }
      // Same JS task as the draw, for the reason encode.js documents.
      overlays?.composite(canvas, clock.virtualMs);
      if (onFrame) await onFrame(f, { glCanvas: canvas, outCanvas: overlays ? overlays.canvas : canvas });
      await enc.addFrame(f);
      timings.push(clock.realNow() - t0);
      if (onProgress && f % 10 === 0) await onProgress(f, frames);
    }
  } finally { exitOffline(); arec?.unhook(); }

  const overlayStats = overlays?.stats() ?? null;
  overlays?.dispose();

  let audio = null;
  if (arec) {
    try {
      const audioBuffer = await renderSessionAudio({
        api,
        events: arec.events,
        spatial: arec.spatial,   // per-tick camera-derived pan/tone automation
        totalTicks: cursor,
        simHz: recording.simHz,
        speed,                            // cues must follow the same schedule as frames
        // Ticks are not uniform in time — each carries the dt of the live frame
        // it came from — so a cue's media time is its cumulative simulated time,
        // not tick/simHz. Same schedule the video frames use.
        tickToSec: (tick) => cumT[Math.min(Math.max(0, tick), total)] / UNIT / 1000,
        sampleRate: 48000,
        durationSeconds: frames / fps,   // match the video exactly
      });
      await enc.addAudio(audioBuffer);
      audio = {
        ...arec.stats(),
        // counts of what actually made it into the mix, incl. which env file
        // resolved and whether any clip was dropped
        ...(audioBuffer.replayReport ?? {}),
        summary: describeAudioEvents(arec.events, recording.simHz),
      };
    } catch (e) {
      // A silent track is better than a failed render; report it loudly.
      audio = { error: String(e), ...(arec.stats?.() ?? {}) };
      console.error('[replay] audio reconstruction failed', e);
    }
  }

  const buf = await enc.finalize();
  const save = await deliverFile(name, buf, 'video/mp4');

  const warm = timings.slice(20);
  return {
    source: file, frames, width: outW, height: outH, cssWidth: width, cssHeight: height, ss, fps, speed,
    recordedTicks: total, simulatedTicks: cursor,
    // What the session actually simulated, vs what a flat-1.0 replay would have.
    livedSeconds: +(wallDurationMs / 1000).toFixed(2),
    simulatedSeconds: +(simDurationMs / 1000).toFixed(2),
    meanRawDt: +(simUnitsTotal / Math.max(1, total)).toFixed(3),
    usedDtStream: player.hasDtStream,
    bytes: buf.byteLength,
    meanMsPerFrame: +(warm.reduce((a, b) => a + b, 0) / Math.max(1, warm.length)).toFixed(2),
    totalSeconds: +(timings.reduce((a, b) => a + b, 0) / 1000).toFixed(1),
    // Non-empty means the replay's world drifted enough to change an outcome —
    // the loud-failure signal the plan asked for.
    mismatches: player.mismatches,
    resizeCorrections,
    overlays: overlayStats,
    audio,
    save,
  };
}

/** Coarse read of how much slime actually exists, so growth is measurable. */
function sampleStats() {
  const c = api();
  return {
    oats: Array.isArray(c.oats) ? c.oats.length : null,
    agentCountEl: document.getElementById('agentCount')?.textContent ?? null,
    virtualMs: Math.round(clock.virtualMs),
  };
}

/** Step one tick, grab the canvas, save a PNG. For fast visual iteration. */
async function snapshot(name = 'snapshot.png', { width = 640, height = 360 } = {}) {
  setRenderSize(width, height);
  const canvas = document.getElementById('sim');
  await armOffline();
  step(1000 / 60);
  const bitmap = await createImageBitmap(canvas);
  const oc = new OffscreenCanvas(width, height);
  oc.getContext('2d').drawImage(bitmap, 0, 0);
  exitOffline();
  const blob = await oc.convertToBlob({ type: 'image/png' });
  const save = await fetch(`/__save?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob })
    .then(r => r.json());
  return save;
}

window.__replay = { renderVideo, preparePageRender, benchmarkTick, setRenderSize, growColony, snapshot, probeGrowth, dtSweep, chargeSweep, liveRun, determinismTest, gpuDeterminismTest, recordSession, replayToVideo, sampleStats, clock, waitFor, api };
log('offline harness ready; waiting for __cuttle');

let statusPostDead = false;
const postStatus = (status) => {
  window.__replayStatus = status;
  // The POST target only exists on the dev server. On a static host every try
  // would 4xx/501 into the console — once is diagnosis, hundreds is noise — so
  // the first failure turns the reporting in-page-only (__replayStatus).
  if (statusPostDead) return Promise.resolve();
  return fetch('/__save?name=status.json', {
    method: 'POST',
    body: JSON.stringify({ at: new Date().toISOString(), ...status }, null, 2),
  }).then((r) => { if (!r.ok) statusPostDead = true; })
    .catch(() => { statusPostDead = true; });
};

await postStatus({ phase: 'booting' });
await waitFor(() => window.__cuttle && document.getElementById('sim'), { label: '__cuttle' });
window.__replayReady = true;
log('ready');

// Self-driving mode. Boot takes ~45s, longer than a tool-call timeout, so the
// harness runs the job itself from URL params and reports to replay/out/status.json.
//   ?render&auto=1&w=1280&h=720&fps=30&frames=300&grow=600&script=demo
if (qs.get('auto') === '1') {
  const num = (k, d) => (qs.has(k) ? Number(qs.get(k)) : d);
  const W = num('w', 1280);
  const H = num('h', 720);

  try {
    await postStatus({ phase: 'ready' });

    if (qs.get('record') === '1') {
      const preset = qs.get('preset');
      if (preset) api().applySimulationPreset(preset);
      const mod = qs.get('player') ? await import(`./scripts/${qs.get('player')}.js`) : null;
      const player = mod ? mod.default(api, { W, H }) : null;
      const result = await recordSession({
        ticks: num('ticks', 900),
        seed: num('seed', 0xC0FFEE),
        player,
        name: qs.get('name') || 'session.cvr',
        fromBegin: qs.get('frombegin') === '1',
      });
      await postStatus({ phase: 'done', result });

    } else if (qs.get('pagerender') === '1') {
      // MUST be tested before `replay`: a page-render URL also carries
      // replay=<file>, so the in-page branch would otherwise swallow it and
      // silently render through the old hand-painted overlay path.

      // Prepare only; Node drives the loop through window.__pr.
      const info = await preparePageRender({
        file: qs.get('replay') || 'session.cvr',
        width: W, height: H, fps: num('fps', 60), speed: num('speed', 1), ss: num('ss', 2),
      });
      await postStatus({ phase: 'ready-to-drive', ...info });
    } else if (qs.get('replay')) {
      const result = await replayToVideo({
        file: qs.get('replay'),
        width: W, height: H,
        fps: num('fps', 30),
        speed: num('speed', 1),
        bpp: num('bpp', 0.12),
        ss: num('ss', 2),
        name: qs.get('name') || 'replay.mp4',
        onProgress: (frame, total) => postStatus({ phase: 'replaying', frame, total }),
      });
      await postStatus({ phase: 'done', result });

    } else if (qs.get('gpudet') === '1') {
      const result = await gpuDeterminismTest({
        ticks: num('ticks', 200),
        runs: num('runs', 3),
        growFirst: num('grow', 600),
        onRun: (row) => postStatus({ phase: 'gpudet', row }),
      });
      await postStatus({ phase: 'done', result });

    } else if (qs.get('determinism') === '1') {
      const result = await determinismTest({
        seed: num('seed', 12345),
        ticks: num('ticks', 400),
        runs: num('runs', 2),
        virtualClock: qs.get('vclock') !== '0',
        isolate: qs.get('isolate') === '1',
        onRun: (r, h) => postStatus({ phase: 'determinism', run: r, hash: h }),
      });
      // Cold-reload comparison: one run per page load, hash written to its own
      // file. This is the REAL gate — an in-process repeat shares warmed module
      // state (agentSeedRT, sequence timestamps, counters resetSimulation does
      // not restore) and so cannot distinguish contamination from true
      // nondeterminism.
      const tag = qs.get('tag');
      if (tag) {
        await fetch(`/__save?name=hash-${encodeURIComponent(tag)}.json`, {
          method: 'POST',
          body: JSON.stringify({ tag, seed: num('seed', 12345), ticks: num('ticks', 400), hash: result.results[0] }, null, 2),
        });
      }
      await postStatus({ phase: 'done', result });

    } else if (qs.get('livecallout') === '1') {
      const result = await liveCallout({ growTicks: num('grow', 2600), seed: num('seed', 48879) });
      await postStatus({ phase: 'done', result });

    } else if (qs.get('live') === '1') {
      const result = await liveRun({
        seconds: num('secs', 90),
        sampleEvery: num('every', 10),
        skipIntro: qs.get('intro') !== '1',
        offlineDt: num('odt', 0),
        yieldEvery: num('yield', 0),
        jitter: num('jitter', 0),
        warmMs: num('warm', 8000),
      });
      await postStatus({ phase: 'done', result });

    } else if (qs.get('charge') === '1') {
      const result = await chargeSweep({
        seed: num('seed', 0xBEEF),
        warmMs: (qs.get('warm') || '0,2500,5000,10000').split(',').map(Number),
        runMs: num('runms', 30000),
      });
      await postStatus({ phase: 'done', result });

    } else if (qs.get('dtsweep') === '1') {
      const result = await dtSweep({
        seed: num('seed', 0xBEEF),
        virtualMs: num('vms', 30000),
        steps: (qs.get('steps') || '16.6667,33.3333,50').split(',').map(Number),
      });
      await postStatus({ phase: 'done', result });

    } else if (qs.get('probe') === '1') {
      // Growth probe: characterise a preset, then leave a still to eyeball.
      const result = await probeGrowth({
        preset: qs.get('preset') || 'original-defaults',
        chunk: num('chunk', 1200),
        chunks: num('chunks', 6),
        onStep: (row, rows) => postStatus({ phase: 'probing', row, rows }),
      });
      result.snapshot = await snapshot('probe.png', { width: W, height: H });
      result.stats = sampleStats();
      await postStatus({ phase: 'done', result });

    } else {
      // Render path. Optional preset + reset so the run starts from a known
      // state, then an optional cheap pre-roll, then the capture.
      const preset = qs.get('preset');
      if (preset) {
        api().applySimulationPreset(preset);
        api().resetSimulation({ resetOats: true, spawnAgents: true });
        await postStatus({ phase: 'preset', preset });
      }

      const grow = num('grow', 0);
      let growStats = null;
      if (grow > 0) {
        await postStatus({ phase: 'growing', ticks: grow });
        growStats = await growColony(grow);
        await postStatus({ phase: 'grown', ...growStats });
      }

      if (qs.get('snap') === '1') {
        const snap = await snapshot('preview.png', { width: W, height: H });
        await postStatus({ phase: 'done', result: { snapshot: snap, grow: growStats, stats: sampleStats() } });
      } else {
        const scriptName = qs.get('script');
        const script = scriptName
          ? (await import(`./scripts/${scriptName}.js`)).default(api, { W, H })
          : {};

        await postStatus({ phase: 'rendering' });
        const result = await renderVideo({
          width: W, height: H,
          fps: num('fps', 30), simHz: num('simHz', 60),
          frames: num('frames', 300),
          bpp: num('bpp', 0.12),
          name: qs.get('name') || 'replay.mp4',
          script,
          onProgress: (frame, total) => postStatus({ phase: 'rendering', frame, total }),
        });
        result.grow = growStats;
        result.stats = sampleStats();
        await postStatus({ phase: 'done', result });
      }
    }
  } catch (e) {
    console.error('[replay] auto job failed', e);
    await postStatus({ phase: 'error', error: String((e && e.stack) || e) });
  } finally {
    // Park the simulation.
    //
    // exitOffline() hands the frame callback back to the live loop, which then
    // keeps simulating forever — in a hidden tab the MessageChannel pump runs
    // at ~90fps, so a finished render leaves the machine grinding through a
    // 1536^2 float simulation indefinitely. Entering offline mode and never
    // stepping parks it: rAF callbacks are captured instead of scheduled, so
    // nothing advances until something explicitly calls step().
    enterOffline();
    log('parked — simulation idle');
  }
}
