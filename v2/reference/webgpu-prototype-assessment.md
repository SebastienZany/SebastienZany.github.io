# Assessment of the existing WebGPU prototype (`webgpu/` + `dev.html`)

> Provenance: generated 2026-08-14 at commit `b113413` by a code-reading agent that read all four
> modules in full. Verdict feeds the v2 plan: **adopt `sim.js`'s core as the skeleton (with the
> surgical fixes below), treat `seam.js` as a technique reference only, discard `mesh3d.js`
> (keep its `renderTestFrame` pattern), keep `render2d.js` as the debug view.**
>
> ⚠️ **Corrections (adversarial review #1, see `../reviews/adversarial-review-1-triage.md`):**
> this doc's "child-reserve ×0.25 matches main.js:3285, but the shared-counter admission does NOT match legacy at capacity (a child can displace a surviving parent; M3 fix 3b, two-phase) — original text claimed a full match to main.js semantics" framing was too generous. Verified divergences the M3
> brief now fixes explicitly: (a) at capacity the allocator can drop a *surviving parent*
> (children take slots through the same counter — legacy guarantees parents always win; the
> "correct fail-safe / matches deferred-debit" claim below is wrong at the boundary); (b) the
> economy lacks exposure-based uptake/field depletion entirely; (c) `reproCrowdCap` is invented
> behavior with no legacy counterpart; (d) oat Gaussians are summed into the persistent field
> (legacy keeps a separate, max-combined, rationed oat field); (e) density persistence
> `max(cur, prev·0.9)` ghost-trails (legacy clears per step). The adopt-the-skeleton verdict
> stands; the semantic gap list is longer than first assessed.

Provenance detail: all of `webgpu/*` + `dev.html` + `PERF_ANALYSIS.md` landed in one commit
(`43509fe`, 2026-07-07) and were never touched again. The WebGL mainline then migrated to a
*different* (affine/ptex) seam resolver, and `cd7dd1d` deleted the WebGPU↔main.js bridge. So this
is a one-shot prototype the mainline has diverged from.

## What is implemented

### `webgpu/sim.js` (617 lines) — the substantive artifact

Exports: `WORLD_LINEAR_SCALE`=4.0 (:18), `DEFAULT_PARAMS` (:21), `DEFAULT_OATS` (:47), `WGSL_SHARED` (:61), `createPhysarumSim` (:329).
Constants: `WG`=64 agent workgroup (:55), `FIELD_WG`=8/axis (:56), `DEPOSIT_FP`=4096 fixed-point scale (:57), `MAX_OATS`=8 (:58).
Params UBO: 256 B `Float32Array(64)` — eight vec4 + `array<vec4,8> oats`; packed by `uploadParams` (:444-458). Quirks: densityMass hardcoded 0.032 (:451); `v7.y`/`v7.z` both get the same seam flag (:452).

Two compute pipelines, both `layout:'auto'`, created once (:397-398):

| | `moveMain` (:150) | `resolveMain` (:271) |
|---|---|---|
| workgroup | 64 | 8×8 |
| dispatch | ceil(capacity/64) | ceil(fieldSize/8)² |
| group(0) | params UBO; agentsIn (ro storage); agentsOut (rw); countIn `{n:u32}` (ro); countOut `atomic<u32>` (rw); fieldRead tex; densityRead tex; depositBuf + densityBuf `array<atomic<i32>>` (:83-91) | params; field/density read tex; deposit/density bufs (ro `array<i32>`); fieldWrite + densityWrite `texture_storage_2d<r32float,write>` (:246-252) |
| group(1) | 9 seam atlas textures (seam mode only) | same |

Resources (:351-371): `agentBuf[2]` capacity×16 B (`Agent{vec2 pos, f32 heading, f32 reserve}`); `countBuf[2]` 4 B; deposit/density bufs fieldSize²×4 (i32 fixed-point); 256 B params; 4 B count readback; 256-aligned field readback. `fieldTex[2]`/`densTex[2]` all **r32float** with TEXTURE|STORAGE|COPY — the right call (r32float is the core-guaranteed write-only storage float format).
`step()` (:493-521): 3 clearBuffers, move pass, resolve pass, one submit, flip parity. Separate passes = implicit barrier — correct.

Covers: agent sim, field diffuse (3×3 box :286-290) + decay + oat gaussians (:298-303), crowd density with 0.9 persistence (:310-313), seam resolution *against a superseded format with no data source*, two toy renderers.
Missing for the real game: GLB geometry; slime PBR parity; display smoothing; delta/equalize/clip semantics; agent sprite rendering; the seam bake; the ptex affine resolver; oats/markers/UI/camera/audio/save-load; mobile tiering.

### The agent pipeline — atomic-append confirmed, with caveats

- Append: `let slot = atomicAdd(&countOut, 1u); if (slot < capacity) { agentsOut[slot] = ... }` (:235-238). Count buffer ping-pongs; zeroed each step (:499).
- Death = append nothing (entry guard :156, post-economy :210). No tombstones or compaction needed.
- Division (:217-233): gated on `reserve > reproThreshold && density(nextPos) < reproCrowdCap`; ≤2 children at ±reproAngle+jitter; child written **and parent debited only if the slot is under capacity** (:226-229) — matches main.js's deferred-debit allocator (child reserve ×0.25, main.js:3285).
- Deposits: `atomicAdd(&depositBuf[idx], i32(amt*4096))` (:142-148), read back as float in resolve (:293,:310).

**Caveats for v2 (the fix designs live in the M3 brief, which supersedes any prescription
here — notably: ids are 64-bit, the allocator is TWO-PHASE survivors-then-children, and the
one-pass append below is NOT correct at capacity):**
1. **Dispatch is over capacity, not live count** (:467,:508) — ~10× wasted thread launch at low populations. Fix: `dispatchWorkgroupsIndirect` fed by a tiny kernel dividing countBuf by WG.
2. Counter overshoots capacity when writes drop (CPU clamps at :532); raw counter ≠ population — M3's admission idiom (add/compensating-sub + finalize dispatch) fixes this.
3. `i32(x*4096)` truncates toward zero — silent −2.2% deposit bias at defaults; sub-1/4096 deposits vanish. Fix: round.
4. Population controller (:538-544): CPU integral controller on reproThreshold inside `liveCount()`; suppress-only, can't cause extinction. ⚠️ Correction: NOT the legacy controller — main.js:19166 merely stores a base threshold; legacy's live controller primarily actuates **log-domain `oatSupplyRate` under forced rationing** (near main.js:19359). v2 replaces, not ports, this one (triage finding 15).

### `webgpu/render2d.js` (85 lines)
Fullscreen-triangle field viewer; two bind groups pre-built, selected by parity; navy→teal→white colormap `pow(x,0.55)`. Minor: compiles the same WGSL into two modules (:51-52); no renderTestFrame.

### `webgpu/mesh3d.js` (243 lines)
Hand-rolled mat4; procedural UV sphere; pipeline arrayStride 32 (pos3/nrm3/uv2), back-cull, depth24plus. Fragment is a **labeled stand-in** (:60-64): 4-tap gradient bump, cosine-triplet iridescence, 3 hardcoded lights, Blinn-Phong. `fieldAt` (:80) is raw clamped textureLoad — **no seam resolution**. `renderTestFrame(size,timeMs)` (:219-240) renders offscreen, 256-aligned readback, returns `{nonBackgroundFrac, maxLum, size}` — the only automated oracle in the prototype; keep the pattern.

### `dev.html` (145 lines)
`?field` (1024) `?cap` (500000) `?seed` (60000) `?seam=1` `?target=N` `?mesh=1`; rAF loop; 9 HUD sliders mutate `sim.params`; `window.__dev = {sim, renderer, simStep, seed, count, getParity, renderTestFrame}` for headless driving; `uncapturederror` listener; `pushErrorScope` around seam setup → `sim.seamSetupError`.

## seam.js — right technique, wrong target, no data

- **Parses nothing.** Declares a 9-texture bind-group-1 contract (`SEAM_TEXTURE_KEYS` :25-29) the host must satisfy; the only producer (`buildSeamTexturesForWebGPU`) was deleted in `cd7dd1d`. Every seam run falls back to 4×4 identity stubs (sim.js:379-389) — **the seam path has never executed against a real atlas.**
- It ports the *legacy* atlas resolver (`safeSamplingGlsl`), faithfully: authoritative gate; fast path on same chart; 4-slot transition-candidate loop with alignment/depth gates and nearest-seam winner; redirect fallback; conservative fail. Heading rotation applied on movement only, mirroring `resolveMoveUvSafe` vs `resolveSampleUvSafe`.
- The mainline then moved to the ptex affine resolver — smaller (one boundary fetch + one frame fetch + 2×2 affine vs 16+ fetches) and derivative-correct. **v2 uses the affine design; port seam semantics from main.js's `ptexResolverGlsl`/`agentMoveResolverGlsl`, not from seam.js.**
- Worth preserving from seam.js: the GLSL→WGSL translation notes (:11-14) — Nearest `texture()` → `textureLoad` at texel from `textureDimensions`, because rgba32float is unfilterable in WebGPU; constants string-interpolated from exported JS consts (:44-47).

## Verification & determinism

- No assertions, no self-tests, no goldens, no parity harness. "Verified" meant a human read console numbers.
- **Nondeterministic by construction, not patchable in place**: `seedRandom` uses `Math.random()` (:473-478); in-shader `hash(f32(i)*0.618 + frameSeed)` keys the RNG on the agent's **slot index**, which is reassigned by atomicAdd completion order every frame. Two runs from the same state diverge. Fix (v2 M3): persistent **64-bit id** (u32 collides at planned populations) + counter RNG keyed (id64, step, stream); child ids = hash64(parentId64, step, k). (M3 is the operative spec.)

## Quality judgment

**Strengths (idiomatic WebGPU):** pipelines/bind groups created exactly once; step() allocates only an encoder; ping-pong bind groups keyed by parity everywhere; deliberate formats (r32float scalar field — PERF Tier-3 item 7 satisfied from birth; storage-buffer agents; depth24plus; 256-aligned readbacks); non-blocking readbacks with busy flags; DOM-free sim module with an exported shared Params struct; comments explain *why* (auto-layout pruning traps, identity-atlas memory).

**Weaknesses driving the verdict:**
- `layout:'auto'` everywhere — silently prunes unreferenced bindings (already worked around twice: seam.js:22-24, sim.js:308-311); blocks bind-group sharing. v2: explicit `GPUBindGroupLayout`s.
- Capacity-sized dispatch (above).
- Seam layer aimed at the superseded design, never fed real data.
- 3D renderer is a placeholder; the hard part (replacing three.js's renderer, camera sync) untouched.
- No parity instrument for "does it grow the same organism?"
- Minor: duplicate module compile (render2d :51-52); per-call view allocation (:607); hardcoded densityMass; collapsed seam flags; truncation bias.

**Why adopt rather than rewrite the sim core:** the ~380 lines of WGSL are the hard-won part — the atomic-append allocator with correct child admission/debit ordering, fixed-point atomic scatter, param packing, ping-pong topology, alignment-correct readbacks. They are clean and match main.js semantics. The needed fixes are surgical: explicit layouts, indirect dispatch, `id`+PCG RNG, rounding, param cleanup. Everything downstream of the field texture is placeholder or wrong-target; don't copy it.
