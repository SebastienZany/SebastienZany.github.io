# Replay renderer — overnight results

Everything here was measured on this machine (Apple M5, Chromium 148 via the
Electron browser pane, `ANGLE Metal Renderer`), not inferred from reading code.

## Headline: bit-exact replay does NOT hold, and the error amplifies

The plan's hard gate (M1) was "the simulation must reproduce bit-for-bit on the
same machine". **It does not.** Same seed, same tick count, same machine, cold
page reload between runs, with story boxes / stats readback / population control
all disabled:

| ticks | `fieldSum` run 1 | `fieldSum` run 2 | divergence |
|---|---|---|---|
| 200 | 478.445275 | 478.126338 | **0.067 %** |
| 800 | 135.514847 | 139.787646 | **3.057 %** |

4× the ticks produced ~46× the divergence. That is superlinear — the field is
chaotic and amplifies a tiny numeric difference, exactly the failure mode the
plan worried about.

Critically, the CPU side is now provably clean:

- `rng` (seeded PRNG state) is **identical** across every run — `1783306865`
- `allocFrame` is **identical** — `201` / `801`

So agent seeding and the frame counter reproduce perfectly. The divergence is
**GPU-side and numeric**. The prime suspect is the additive float blending of
~590k point splats in `renderDensity`/`renderDepositDensity`: float addition is
not associative, and while GL defines blending in primitive order, that does not
guarantee the driver produces bit-identical results run to run.

### What this means for the plan

The plan's own stated fallback is now the live path:

> If exact blending still fails, use deterministic integer accumulation or a
> gather path.

Until that is done, a recorded session replayed will visibly diverge within
seconds — and because the player reacted to what they saw, their inputs will
look wrong against a different colony. **Do not build M2/M3/M4 on the current
assumption.** One night of measurement invalidated the premise before weeks went
into the layers above it.

Ranked options:

1. **Make the deposit deterministic.** Replace additive point-splat blending
   with integer accumulation (e.g. `RGBA32UI` + `imageAtomicAdd`-style
   accumulation, or a gather pass where each texel sums the agents affecting it).
   This is the only route to genuine bit-exactness.
2. **Bound the drift instead of eliminating it.** Periodically re-sync the
   replay to recorded state keyframes so error cannot accumulate past a
   checkpoint. Costs file size; the plan estimated ~37 MB per field snapshot at
   `FIELD_SIZE` 1536.
3. **Drop faithful replay.** Keep the offline renderer (which works, see below)
   and accept it as a *rendering* tool driven by authored input rather than a
   reproduction of a specific session.

## M0: capture / encode / mux — PASSES

All verified end to end, producing files validated with `ffprobe`.

| check | result |
|---|---|
| `VideoEncoder` `avc1.640033` (H.264 High 5.1) | supported |
| `AudioEncoder` `mp4a.40.2` (AAC-LC) | supported |
| AAC `decoderConfig.description` | non-empty (2 bytes) — `esds` valid |
| same-task `VideoFrame(canvas)` with `preserveDrawingBuffer:false` | **works** |
| Mediabunny from CDN | imports, all needed exports present |
| full canvas → H.264 + AAC → MP4 | valid: 60 frames, 2.069 s, 48 kHz stereo |

The 2.069 s on a 2.000 s video is the AAC encoder priming delay the plan
predicted and budgeted for. It is real and measurable.

### Correction to the plan: audio tracks cannot be added late

Mediabunny throws `Cannot add track after output has been started`. The plan's
"emit all video, then add the audio track" is **impossible**. The track must be
declared before `output.start()`; only its *samples* can arrive late.
`replay/encode.js` does this via `withAudio: true`.

## M0b: the real cost of a tick

Measured with the full loop (sim + ~6-pass display chain), which is what the
normative tick contains:

- **~127 ms per output frame** at 1280×720, 2 ticks/frame, saturated colony
- A 20 s / 600-frame render took **76 s ≈ 3.8× realtime**

That is slower than the plan's 1.5–3× estimate, because the estimate assumed a
sparser colony. `growFast` cost rose from ~10 s to ~42 s per 1500 ticks as the
population grew — the agent-count cost scaling the plan predicted.

## Bugs found in the existing game (all pre-existing, not caused by this work)

1. **`env.wav` 404s on every run** and silently falls back to
   `env-under-25mb.wav`. Confirmed live in the boot diagnostics. The plan
   flagged this as a hazard; it is real.
2. **`slimeCoveragePercent` is always 0.** Its readback requests `HALF_FLOAT`
   into a `Float32Array`; the driver rejects it with
   `readPixels: type HALF_FLOAT but ArrayBufferView not Uint16Array`. The metric
   has never worked.
3. **The default preset starves the colony.** From a fresh seed the population
   *shrinks* (4096 → 3138) and produces no visible growth.
   `original-defaults` saturates to `AGENT_CAPACITY` (589,824) within 1500
   ticks — the "tends to run away" note is exact. There is no preset between
   "dies" and "saturates" that was tried here.
4. **Progressive agent seeding never reveals.** `revealSlotCount` stays 0
   through `beginInitialAgentSeeding`, so the production seeding path appears not
   to inject agents; only the instant path
   (`resetSimulation({ spawnAgents: true })` → `initAgents`) works. Worth a
   closer look — it may be specific to the offline harness.
5. **A hidden tab never fires rAF**, so boot stalls forever at shader prewarm.
   `replay/clock.js` works around it with a `MessageChannel` pump. This also
   affects any real background render.
6. **`resizeIfNeeded()` drives the canvas to 0×0 in a hidden tab**, because it
   computes the backing store from `canvas.clientWidth`, which is 0 when the
   document is hidden. Renders pure black.

## What was built

| file | role |
|---|---|
| `replay/clock.js` | virtual clock; shims rAF + `performance.now()` before `main.js` evaluates |
| `replay/encode.js` | Mediabunny MP4 encoder wrapper |
| `replay/offline.js` | offline driver: render, benchmark, growth probe, determinism gate |
| `replay/scripts/demo.js` | hand-authored input track (camera orbit + oat placements) |
| `replay/devserver.mjs` | static server + `POST /__save` so renders land on disk |
| `replay/m0-probe.html`, `replay/mux-test.html` | the M0 probes |

`main.js` changes are minimal: a seeded PRNG (`seedSimRng`/`simRandom`)
replacing the 13 simulation `Math.random()` calls in `createAgentInitialData`,
plus `hashSimState()` for the determinism gate. `index.html` gains one branch so
`?render` loads the harness instead of `main.js`. **The normal play path is
untouched.**

## Usage

```
node replay/devserver.mjs 8140
```

```
# render a video
/index.html?render&dev&auto=1&preset=original-defaults&grow=2000&script=demo&w=1280&h=720&fps=30&frames=600&name=replay.mp4

# determinism gate (one run per load; compare hash-<tag>.json across loads)
/index.html?render&dev&auto=1&determinism=1&isolate=1&seed=12345&ticks=800&runs=1&tag=a

# growth characterisation
/index.html?render&dev&auto=1&probe=1&preset=original-defaults&chunk=1500&chunks=6
```

Output lands in `replay/out/` (gitignored). Progress is written to
`replay/out/status.json` throughout, so a long job can be watched from the shell.

## Not built

Session recording (M2), DOM overlay compositing into frames, and offline audio.
The input track is hand-authored, in the same resolved-intent shape a real
recording would replay — but nothing records a live session yet. Given the
determinism result, that is the right place to have stopped.
