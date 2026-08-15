# Replay recording + offline movie export

Record a session as a small file of player intents, then re-render it offline —
slower than real time, at a locked frame rate and arbitrary resolution — and
encode it to MP4 in the browser. Built because the game cannot sustain 60fps, so
screen recording produces choppy video.

**Dev-only.** Nothing here loads on the normal play path. `index.html` gains a
single branch: `?render` loads `replay/offline.js` instead of `main.js`.

## Quick start

```bash
node replay/devserver.mjs 8140
```

Record a session, then turn it into a movie:

```
# 1. record  (a scripted stand-in player; a human at the keyboard works the same)
/index.html?render&dev&auto=1&record=1&preset=original-defaults&ticks=900&seed=48879&player=player&name=session.cvr

# 2. replay that recording to MP4
/index.html?render&dev&auto=1&replay=session.cvr&w=1280&h=720&fps=30&name=movie.mp4
```

Output lands in `replay/out/`. Progress is written to `replay/out/status.json`
throughout, so a long render can be watched from a shell:

```bash
until grep -q '"phase": "done"' replay/out/status.json; do sleep 5; done
```

### Other modes

```
&probe=1&preset=X&chunk=1500&chunks=6   characterise a preset's growth curve
&gpudet=1&ticks=200&runs=6              determinism probe from identical state
&determinism=1&seed=N&ticks=N&tag=a     seed-reproducibility gate (one run per load)
&snap=1&grow=4000                       grow, then save a single still
&script=demo&frames=600                 render from a hand-authored track (no recording)
```

## Fidelity: what a replay does and does not guarantee

**A replay is visually faithful, not bit-exact.** Measured, two replays of the
same recording:

| frame | 1 | 90 | 150 | 300 | 450 |
|---|---|---|---|---|---|
| SSIM | 0.9991 | 0.9770 | 0.9705 | 0.9414 | 0.9056 |

Mean 0.953 over 450 frames (15 s). Divergence grows slowly and monotonically.

What **is** reproduced exactly: the seed, the parameter set, the opening state,
every oat placement at its exact tick and UV, the camera track, the mouse-repel
track, and the timing of everything. Crucially, the **outcomes** reproduce —
across both test replays `mismatches` was empty, including correctly
reproducing an oat placement that the game *rejected*.

What is **not** reproduced: the fine tendril structure. The colony is
recognisably the same organism doing the same thing, not the identical pixels.

### Why

The simulation is not bit-reproducible on this hardware. From bit-identical
restored state, with the clock held offline and the allocation counter pinned,
200 ticks still produce field sums varying ~1–2%. The cause is the additive
float blending of ~590k point splats into the density/deposit targets: float
addition is not associative and the driver does not guarantee a stable fragment
order at that overdraw.

Two red herrings were eliminated along the way, both worth knowing:

- **Harness contamination.** Entering/leaving offline mode per run let live
  frames simulate between the restore and the first controlled tick. The tell
  was `allocFrame` advancing 219/231/238/249/256 across runs that each stepped
  exactly 200 ticks. Offline mode is now held across a whole test.
- **`agentAllocationFrame`.** It seeds `lastAgentAllocationOffset`, a uniform on
  the agent compaction pass, so it decides agent packing and therefore splat
  order. It is now restorable (`get/setAgentAllocationFrame`) and lives in the
  recording header — though pinning it did *not* by itself restore determinism.

To get bit-exactness the deposit splat would have to be replaced with
deterministic integer accumulation or a gather pass. That is a shader rewrite
and deliberately out of scope.

## Recording format

JSON, `formatVersion: 3`. ~50 KB per 15 s (~200 KB/min), uncompressed.

```
header    formatVersion, buildStamp, simHz, dt, env, rngSeed, allocFrame,
          params (full snapshot), initialOats, startPose, totalTicks
camera[]  [tick, x,y,z, tx,ty,tz, fov]        change-gated
repel[]   [tick, active, u, v, chartId]       change-gated, exact float32 UV
events[]  { tick, phase, type, ...payload }
```

Design notes worth preserving:

- **Resolved intents, not raw DOM events.** Pointer coalescing varies run to
  run, OrbitControls carries hidden damping state, and the pick raycast depends
  on camera and aspect. The camera pose the renderer actually used and the
  UV the raycast actually produced are recorded instead.
- **Mouse-repel UV is stored as exact float32**, not quantised. It feeds a
  continuous penalty and strict comparison branches in the agent shader, so
  sub-texel rounding can flip a branch.
- **`addOat` records its outcome** (`accepted`, `oatsLength`), so a drifted
  replay fails loudly instead of silently diverging.
- **`resetSimulation` is recorded as a composite** carrying what its children
  resolved to. It nests `clearAllOats`/`addInitialOat`/`initAgents`; recording
  those separately would double-apply them on replay.

## Performance

Measured at 1280×720, saturated colony, full tick (sim + ~6-pass display chain):

- **~130–160 ms per output frame**
- 15 s of 30fps video renders in ~73 s — roughly **5× realtime**
- `growFast` pre-roll rises from ~10 s to ~42 s per 1500 ticks as the population
  grows toward `AGENT_CAPACITY` (589,824)

Lowering output fps does not help much: the display chain dominates and runs per
tick regardless.

## Files

| file | role |
|---|---|
| `clock.js` | virtual clock; shims rAF + `performance.now()` before `main.js` evaluates |
| `recorder.js` | `createRecorder` / `createPlayer` — capture and apply intents |
| `encode.js` | Mediabunny MP4 wrapper (H.264 + AAC) |
| `offline.js` | driver: record, replay, render, benchmark, probes |
| `devserver.mjs` | static server + `POST /__save` so output lands on disk |
| `scripts/player.js` | stand-in player used to produce a session unattended |
| `scripts/demo.js` | hand-authored track for rendering without a recording |
| `m0-probe.html`, `mux-test.html` | codec / capture / mux probes |

`main.js` additions are small and self-contained: a seeded PRNG for the
simulation stream, `hashSimState()`, `get/setAgentAllocationFrame`, and
`setMouseRepelState`.

## Known gaps

- **DOM overlays are not composited.** Story callouts, the ending fade and the
  countdown are HTML, so they do not appear in the video. The plan's approach —
  read layout from the live DOM, paint with Canvas2D — is not implemented.
- **No audio.** The encoder supports it (`withAudio: true`, verified end to end
  with a real AAC track), but nothing reconstructs the soundtrack yet.
- **No in-game UI.** Recording is driven by URL flags, not an `R`-key panel.
- **Non-1× speed is untested.** `ticksPerFrame` exists but slow-motion and
  time-lapse have not been exercised.
