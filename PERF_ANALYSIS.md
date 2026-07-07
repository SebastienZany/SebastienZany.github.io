# Physarum-17 Performance Analysis — 10× Levers

_Analysis date: 2026-07-07. Method: 7 dimension-expert agents read the live `main.js`; every
finding was adversarially verified against the code (28 verified → 23 survived, 5 rejected) and
cross-checked against a hand-computed per-frame texel-op budget. Line numbers drift as `main.js`
is edited; treat them as approximate anchors._

## TL;DR

- **No single 10× lever exists in the running case on WebGL2.** The frame is spread across many
  passes, and the one part that _should_ be 10× — the agent prefix-scan — is fundamentally capped by
  WebGL2 having no compute / shared memory.
- Three routes to large wins:
  1. **Stack the cheap Tier-1 fixes → ~2–3×** in the running case (mostly display-only redundant work).
  2. **Gate on idle → ~10×** when the piece is static/paused (very relevant for an on-screen art piece).
  3. **Port the agent pipeline to WebGPU compute → the real structural 10×** (this is now in progress in `dev.html`).
- **Biggest surprise:** the heaviest thing in the frame is _not_ the simulation — it is the
  **display smoothing chain**, which is display-only and therefore risk-free to cut.

## Where the frame time actually goes

Per unpaused frame, desktop, `performanceMode: 'quality'`, `simulationSteps: 1`:

| Block | Rough cost (tex-fetches) | Notes |
|---|---:|---|
| **Display smoothing chain** (`smoothRenderField`) | **~680 M** | 6 full 1536² passes **every frame**; 2 blur passes do ~29 taps × the `safeSamplingGlsl` seam cascade. **Display-only.** |
| Agent prefix-scan + compact | ~90 M | 21-pass Hillis-Steele scan (768×2304) + compact does a **21-iteration binary search per pixel** |
| `diffuseField` | ~106 M | The one sim field pass that runs the 8× `resolveSampleUvSafe` seam cascade |
| Scene render (slime mesh shader) | large, fill-bound | Full canvas × DPR 2; per-fragment `safeSamplingGlsl` + 12–32-light PBR loop |
| delta / equalize / clip | ~25 M | 3 more full 1536² passes per step |

Key numbers: `FIELD_SIZE = 1536`, `AGENT_SIDE = FIELD_SIZE/2 = 768`, `AGENT_CAPACITY = 589,824`,
candidate texture `768×2304 = 1.77 M` texels, `AGENT_SCAN_PASS_COUNT = ceil(log2(1.77M)) = 21`.

## Tier 1 — cheap, high-ROI (stack toward ~2–3×)

### 1. The display smoothing chain is massively over-served — **highest ROI, lowest risk**
`smoothRenderField()` runs **6 full 1536² passes every unpaused frame**, gated only by
`smoothSettleFramesRemaining`, which `markRenderFieldChanged()` re-pins to 600 every frame the field
changes. It is **not** gated by the "Smooth field" toggle (`smoothFieldDisplay` only flips a
sampler filter Linear/Nearest). Its two `smoothFragment` blur passes each do a 14-tap two-sided blur
(`smoothingTapCount: 14` in quality mode → `for i=1..14`, 2 reads/iter = 29 reads/texel) **and every
tap runs the full `safeSamplingGlsl` seam cascade** — this alone is plausibly the single largest
GPU consumer in the frame, and it exists only for display polish.

Three compounding fixes:
- Apply the **interior-mask fast path you already built** (`displayPrefilterMaskFragment`, `.g` = "3×3
  ring stays in-chart") to the blur passes → ~4–6× on the ~88% interior majority.
- Run the chain at **reduced cadence** (temporal convergence does not need 6 fresh passes/frame).
- Cut the default tap count (14 taps at `spatialSmoothing: 1` is overkill; a proper Gaussian at
  radius 1 needs ~3–5 taps).
- ⚠️ **First confirm the chain's output (`renderRT`) is even consumed** when smoothing is toggled off —
  if the slime shader reads `fieldSampleViewRT` directly, some or all 6 passes are pure waste.

_Verdict: CONFIRMED (×3 facets). Effort: M. Risk: near-zero (display-only)._

### 2. Global render-scale / DPR cap — near-free whole-frame multiplier
No render-scale exists; desktop renders at `MAX_PIXEL_RATIO = 2`. A `0.75` render scale (or DPR 2→1.5)
is ~1.78× fewer fragments on the fill-bound slime scene render. One slider.
_Verdict: CONFIRMED, conf 0.9. Effort: S._

### 3. Diffuse interior fast-path
`diffuseFragment` is the one **simulation** field pass paying the 8-neighbour seam cascade; apply the
same interior mask → ~2–4× on diffuse. Verifier confirmed the fast path is **bit-identical** for
interior texels (the cascade's cheap branch returns `sampleUv` unchanged, `valid = 1`).
_Verdict: CONFIRMED. Effort: M._

## Tier 2 — structural, bigger effort, bigger wins

### 4. Drop `FIELD_SIZE` 1536 → 1024 on desktop
Because `AGENT_SIDE = FIELD_SIZE/2`, this shrinks **every field pass, the entire scan/compact array,
and memory by ~2.25×**. The display smoothing chain is designed to hide the lower field resolution.
Single biggest sim-side lever. Whole-frame < 2.25× because the scene render doesn't shrink.
_Verdict: CONFIRMED, conf 0.7. Effort: M._

### 5. Slime surface shader
Two verified sub-costs: it compiles `safeSamplingGlsl` per-fragment (~40 wasted chart fetches in
interiors) and runs a 12–32-light PBR loop with 2 `microfacetSpecular` calls each. Interior fast-path
+ baking the static-light response → meaningful cut on the render pass. (Whole-frame corrected down
to ~5–15%; the light loop is ALU, the field taps are the bandwidth cost.)
_Verdict: PLAUSIBLE. Effort: M–L._

### 6. Decouple simulation Hz from render Hz
Free ~2× of the sim on 120/144 Hz displays; a motion-rate tradeoff at 60 Hz.
_Verdict: CONFIRMED, conf 0.7. Effort: M._

## Tier 3 — memory (directly serves the iOS crashes)

### 7. Scalar field stored in RGBA32F but only uses `.r`
Every write is `vec4(food,0,0,1)`; nothing reads `.g/.b/.a`. → `R32F` (4×) or `R16F` (8×)
memory/bandwidth cut, **~150 MB freed on desktop**, plus downgrades the still-fp32 mobile field/oat
targets. **Hard constraint:** `agentRT` / `agentPrefixRT` must stay fp32 — the prefix count reaches
1.77 M, past fp16's 2048 exact-integer limit.
_Verdict: CONFIRMED (memory axis), conf 0.68–0.82. Effort: S–M._

## Idle case → the practical 10×
Nothing gates on convergence or camera-idle: `simulate()`, the 6-pass smoothing, and the full scene
render all re-run every frame even when the field has settled, the sim is paused, and the camera is
still. For a piece that sits on screen, an epsilon-delta skip + camera-idle render gate is a genuine
~10× idle-power win.
_Verdict: CONFIRMED (×3). Effort: S–M._

## Status of the WebGPU port (`dev.html`)
Prototyped and **functionally verified** (2026-07-07). Standalone self-contained page; does not touch
`index.html` / `main.js`. The entire WebGL agent pipeline (`parentUpdate + candidateBuild + prefixInit
+ 21×scan + compact`) is replaced by **one atomic-append compute dispatch**. Verified by driving the
sim headlessly and reading back the live count: seed 60k → grows via reproduction → saturates cleanly
at the 500k hard cap and holds stable, zero runtime errors across 1000+ steps. Births (atomic-append
children), deaths (starved agents dropped), the food economy, deposits, field diffuse/decay, and oat
sources all confirmed working. Renders a flat field (no cuttlefish mesh yet). Live param sliders +
pause/reset. Open it in a real (foreground) browser tab on the M5 to see it and benchmark — the
headless preview runs on a virtualized GPU and its ms/step is not representative.

Migration progress (strangler-fig, one subsystem at a time, all flag-gated):
- **Step 1a — DONE/verified:** sim extracted to `webgpu/sim.js` (DOM-free) + `webgpu/render2d.js`; `dev.html` is the harness. `readFieldInto()` is the bridge API.
- **Step 1b — DONE/verified:** bridge into `main.js` behind `?webgpu=1` (WebGPU sim → readback → slime `u_food`). Readback tax at `window.__webgpuBridge.readbackMs`. Verified structurally; run foreground to see it + get the number.
- **Step 2 (seams) — DONE/verified headlessly:** `resolveSampleUvSafe` ported to WGSL (`webgpu/seam.js`). The WHOLE non-mesh pipeline is seam-aware in `?seam=1`: agent **sensing**, field **diffusion**, and agent **movement** (with `rotateHeading` across seams). `?webgpu=1&seam=1` feeds the app's real baked atlases (`buildSeamTexturesForWebGPU`). Verified compile + no-regression vs flat via `dev.html?seam=1` (identity atlases). **Real-data parity needs the foreground field-diff.**
- **Population controller — DONE/verified (documented limit):** opt-in `populationTarget` (`?target=N`); integral controller on reproThreshold, stable + never-extinct. Can't target *below* the economy's death-free equilibrium (flat `foodClamp` → no carrying-capacity gradient); needs a crowd-competition economy (follow-on).

- **Phase B — DONE/verified (render stack):** `webgpu/mesh3d.js` — a raw-WebGPU 3D renderer that samples the sim's field texture **directly on a mesh, no readback** (sim → field texture → mesh render, one WebGPU context). Orbit camera + depth + a real WGSL **slime surface shader** (field-gradient bump + thin-film iridescence + 3-light specular). Accepts custom geometry (cuttlefish GLB plugs in). `dev.html?mesh=1`; verified via `__dev.renderTestFrame()` (offscreen readback: mesh renders, shading varies with view angle, zero validation errors).

**The entire WebGPU stack — Phase A (sim) and Phase B (render) — is built and verified headlessly.** What remains is inherently foreground: (1) exact visual match to the existing slime + seam continuity (tuning); (2) the **main.js render replacement**, which hits the wall that WebGL and WebGPU can't share one canvas — so it's a large architectural change (replace the three.js `WebGLRenderer`, or dual-canvas composite the oats/markers/UI) + camera sync; (3) seam-parity field-diff, child-placement seams, crowd-competition economy. None have a headless oracle. Note: the transition atlases duplicated into WebGPU are ~600MB at 1536 — a memory item for the all-WebGPU endpoint.

## The real structural 10× — WebGPU compute (prototyped in `dev.html`)
The 21-pass Hillis-Steele scan + per-pixel 21-iteration binary-search compaction exist _only_ because
WebGL2 fragment shaders cannot scatter or do an efficient scan. WebGPU compute gives:
- A **single atomic-append compute dispatch** that replaces the entire `parentUpdate + candidateBuild
  + prefixInit + 21×scan + compact` chain: live agents (and their children) append themselves to a
  dense output buffer via `atomicAdd(&liveCount, n)`; dead agents append nothing. O(n) work, one pass.
- **Atomic scatter deposits** into the field (no density-splat pass, no scan-driven compaction).
- **Storage-buffer agents** (no texture ping-pong, no 3× candidate over-allocation).

This is the honest order-of-magnitude path for the sim half. It is being prototyped standalone (flat
field, no cuttlefish mesh) in `dev.html` so it can deploy without touching `index.html` / `main.js`.
**Interop note:** WebGL2 and WebGPU are separate GPU contexts and cannot share textures/buffers, so a
"port just the agents, keep the field in WebGL" hybrid is not viable per-frame — the whole simulation
must live in one context. Mesh integration (via three.js `WebGPURenderer`, or field read-back) is a
follow-on decision.

## Rejected — do not chase
- ❌ **Block-scan replacement for the 21-pass scan (staying in WebGL2).** No workgroup shared memory in
  fragment shaders; realistic ceiling is ~2–4 passes shaved, and it's bandwidth-bound. (The _real_ fix
  is WebGPU, above.)
- ❌ **Candidate-sparsity / skip-compaction-on-no-births.** Not implementable without building a new GPU
  allocator; the "parents are already dense" decomposition isn't sound as written.
- ❌ **Per-frame CPU (raycasts, annotations, alleged double-splat).** < 1% of frame; the claimed
  double-splat doesn't exist.
