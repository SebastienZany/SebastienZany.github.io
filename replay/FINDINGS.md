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
3. **The population declines toward a single-oat equilibrium — and this is the
   game's own behaviour, not a harness artifact.** CORRECTED: an earlier version
   of this note called it "the default preset starves the colony", inferred from
   a `growFast` probe. That probe was invalid — `growFast` hardcodes
   `simulate(t, 1.0)` and never calls `updateOatFoodDecay`, so it measures a food
   regime that does not exist in the real loop.

   Measured properly, with the harness entirely out of the loop (plain boot, live
   clock, one oat, no reset, polled directly): 3703 → 960 → 885 → 771 → 661 → 558.
   The offline render reaches the same equilibrium (~900 with one oat). One oat
   sustains roughly 900–1000 agents at the shipped `default-current` preset
   (`oatSupplyRate 0.14`, rationing on), and the initial 4096-agent seed is well
   above that, so it thins to the carrying capacity. Feeding the colony more oats
   raises it; that is what a player does and what a recorded session should show.

   `original-defaults` does saturate to `AGENT_CAPACITY` (589,824) within 1500
   ticks — its "tends to run away" note is exact, and it should not be used for
   showcase renders.
4. **Progressive agent seeding never reveals.** `revealSlotCount` stays 0
   through `beginInitialAgentSeeding`, so the production seeding path appears not
   to inject agents; only the instant path
   (`resetSimulation({ spawnAgents: true })` → `initAgents`) works. Confirmed on a
   plain `?dev` boot with no harness job running: `getInitialAgentSeedState()`
   reports `revealSlotCount: 0, visibleCount: 0` while the agent counter reads
   3,703 — so the colony arrives by some other path and the reveal is dead code.
   Not harness-specific.

6. **The simulation is frame-rate dependent.** `simulate()` mixes per-`dt`
   metabolism (`updateAgents`, `applyAgentFoodDeltas`) with per-CALL field
   physics: `diffuseField()` applies `params.fieldDecay = 0.991` multiplicatively
   with no `dt` term (main.js:2565). So food remaining after N calls is
   `decay^N`, and the ratio of evaporation to metabolism is set by the frame
   rate rather than by simulated time. Measured live at 32.5 vs 39.7 fps: the
   colony held 4096 for 54s vs 21s. This matters for the 60fps work — raising the
   frame rate changes the population dynamics, not just the smoothness.

7. **The recorder's tick↔dt contract is wrong.** `record-boot.js` records one
   tick per live frame, but replay steps each tick at `dt = 1.0`. A live frame at
   30fps carries `rawDt = 2.0`, so replaying a 30fps session simulates half the
   sim-time the player actually saw. Fix: record per-frame `rawDt` and replay
   with it.
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

---

# 2026-08-16 — passive recorder, live flow, and the text staircase, measured

Everything below is measured on encoded output or a live page, not inferred.
(Sections above predate the recorder and in-page UI and describe an earlier
milestone; where they disagree with this section, this section is current.)

## The live-site regression, and the fix

Making record-boot the default boot called `recorder.start()` at page load,
which ran `resetSimulation({spawnAgents: true})` — colony spawned before the
intro, seeding at the wrong time, story callouts never firing, for every
visitor. The recorder is now PASSIVE: it seeds the RNG and captures its header
in a capture-phase listener on the Begin click and never mutates the world.
`recorder.startFromHere()` is the live path; `recorder.start()` (which resets)
is harness-only.

Gate, run against a plain static server (GitHub Pages semantics),
`replay/ab-live-test.mjs`: **24/24 PASS** — stock arm vs recording arm: seeding
starts 16.3s vs 16.4s after Begin (Δ70 ms), population at t=42s within 1%,
placed oats earn callouts in both, no page errors, and the recording proves
passivity (starts at the Begin click, spawnAgents:false, no reset events).

## End-to-end on static-host semantics

`replay/e2e-live-flow.mjs`: **11/11 PASS** — play under recording → R freezes
the world and opens the panel → Render reloads into `?render&auto=1` →
IndexedDB hand-off (no dev server) → in-browser replay + WebCodecs encode →
MP4 arrives as a download: h264 + aac, requested geometry and fps, duration
matches the report ±1s, zero replay outcome mismatches, story callout present
and composited. Extracted frames show the story text in EB Garamond with the
reveal masks working.

## The text staircase, finally measured honestly

`replay/text-motion-report.mjs` joins INTENDED motion (the page's own per-frame
roll transform + viewport rect, written by render-page.mjs as a trace JSONL)
against MEASURED motion (row-profile cross-correlation on a crop of the encoded
film). A frame counts as frozen only when the page meant the text to move.
Hold frames act as a per-segment control: a crop that "moves" while box and
scroll are both still is measuring the creature bleeding through the box, and
that segment is excluded from the verdict.

Full 3601-frame 2560×1440@60 films of the same recording (mantle.cvr),
control-clean segments:

| build | frozen when should move | staircase jumps |
|---|---|---|
| shipped fix (smoothtext + adoptscroll) | **9/1245 = 0.7%** | 16 (1.3%) |
| raw baseline (RAW_SCROLL=1 SMOOTH_TEXT=0) | **798/1055 = 75.6%** | 221 (20.9%) |

The raw film freezes three of every four frames the text should glide and
discharges in ~1px jumps — the staircase. The shipped fix moves every frame it
should, across the whole film, both callout segments, to the last second.

The earlier "29/29 frozen at t=40s" alarm was the contamination this metric's
control now catches: a fixed crop over the visible creature. The mask-band
freeze at 35.5–37.8s (f2139–2157) was likewise the metric reading the static
reveal-mask edge while single entry-line glyphs slid beneath it — ty glides
0.112 px/frame there, verified by eye.

## Honest limitations, still true

- Replay is visually faithful, not bit-exact (additive float splat blending;
  documented at the top of recorder.js). Structure reproduces; tendril detail
  does not.
- Mid-session parameter changes through the game panel are not recorded.
- The game's own Clear-oats button replays without re-adding the initial oat.
- Pausing via the game panel is not recorded (the R panel's freeze is handled).
- Oat food decay keeps running on the wall clock while the R panel is open, so
  resuming after a long panel visit shifts food slightly vs the replay.
- Mediabunny loads from jsdelivr at render time — an offline machine can play
  and record, but not export.
- In-browser exports draw callout text sharp and smooth, but the box chrome
  (frost/stroke) is an approximation; page renders (render-page.mjs) remain
  the maximum-fidelity path.
