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

import { installClock, enterOffline, armOffline, exitOffline, step, clock } from './clock.js';
import { createMp4Encoder, bitrateFor, pickAvcCodec } from './encode.js';

installClock();

const qs = new URLSearchParams(location.search);
const log = (...a) => { console.log('[replay]', ...a); };

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
function setRenderSize(width, height) {
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
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  if (camera) { camera.aspect = width / height; camera.updateProjectionMatrix(); }

  return { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight };
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
  try {
    for (let i = 0; i < frames; i++) {
      const t0 = clock.realNow();
      for (let t = 0; t < tpf; t++) {
        const fn = script[clock.tickIndex];
        if (fn) { try { fn(api()); scripted++; } catch (e) { console.warn('[replay] script error', e); } }
        step(dtMs);
      }
      // Capture in the SAME task as the draw that just happened inside step().
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

window.__replay = { renderVideo, benchmarkTick, setRenderSize, growColony, snapshot, probeGrowth, sampleStats, clock, waitFor, api };
log('offline harness ready; waiting for __cuttle');

const postStatus = (status) => {
  window.__replayStatus = status;
  return fetch('/__save?name=status.json', {
    method: 'POST',
    body: JSON.stringify({ at: new Date().toISOString(), ...status }, null, 2),
  }).catch(() => {});
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

    if (qs.get('probe') === '1') {
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
  }
}
