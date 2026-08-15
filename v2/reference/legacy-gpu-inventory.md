# Legacy GPU / simulation inventory — `main.js`

> Provenance: generated 2026-08-14 at commit `b113413` by a code-reading agent; spot-checked.
> Line anchors are exact as of that commit (main.js = 20,110 lines) but will drift.
> Purpose: let the v2 (WebGPU) implementer find any legacy semantic without re-reading 20k lines.

## 0. Foundations

- **Everything is three.js** — no raw `gl.createProgram`. Every "pass" is `runFullscreenPass(material, target)` (main.js:1669) through an ortho cam, or `renderer.render(scene, cam)`.
- Renderer: `WebGLRenderer` main.js:1111, `antialias:false`, `alpha:false`, `autoClear=false`, `outputColorSpace = LinearSRGBColorSpace`, pixel ratio cap 1.5 mobile / 2 desktop.
- Hard requirement `EXT_color_buffer_float` (main.js:1163). `EXT_float_blend` / `OES_texture_float_linear` optional — iOS lacks both → RGBA16F fallbacks (`BLENDABLE_FLOAT_TYPE` main.js:1176-1177, display sample view main.js:1728).
- Sizes: `FIELD_SIZE` 1536 desktop / 768 mobile (main.js:117); `AGENT_SIDE = FIELD_SIZE/2`; `AGENT_CAPACITY = AGENT_SIDE²`; candidate stride 3; `AGENT_SCAN_PASS_COUNT = ceil(log2(capacity*3))` → **21 desktop / 19 mobile** (main.js:148-154).
- Step loop: `frame()` main.js:18632 → `simulate()` main.js:18098 × `params.simulationSteps` (default 1, max 8). `dt = min((now-last)/16.667, 2.2)` split across steps.

## 1. Every GPU pass

### 1a. Agent sim passes — `updateAgents()` main.js:17755-17786, once per sim step

| # | Pass | Shader | Output | Size/format | Notes |
|---|---|---|---|---|---|
| A1 | `agentParentUpdateMaterial` (4580) | `agentParentUpdateFragment` 3242 on `agentAllocatorCommonFragment` 3001 | `agentParentNextRT` | AGENT_SIDE² RGBA32F | sense (3 dirs + stay = 4 `scoreAt`), turn, move, uptake/burn |
| A2 | `agentCandidateBuildMaterial` (4618) | 3249 | `agentCandidateRT` | AGENT_SIDE × AGENT_SIDE·3 RGBA32F | seg 0 = parents; segs 1–2 = 2 child proposals, frame-rotated order (`u_allocationOffset`, LCG 17756) |
| A3 | `agentPrefixInitMaterial` (4658) | 3293 | `agentPrefixRT.write` | same | valid flag → 1/0 |
| A4 | `agentPrefixScanMaterial` (4662) | 3307 | ping-pong | same | **Hillis–Steele scan, 21/19 full passes per sim step** (loop 17771-17777) |
| A5 | `agentCompactMaterial` (4668) | 3329 | `agentRT.write` | AGENT_SIDE² RGBA32F | per-slot 21-step binary search over prefix; child debit on accept |
| A6 | `agentSeedInjectMaterial` (4677) | 3397 | `agentRT.write` | | intro reveal only (17443-17469) |

### 1b. Field passes — `simulate()` main.js:18098, in order, per sim step

| # | Fn | Shader | Output | Format | Cadence |
|---|---|---|---|---|---|
| F1 | `renderOats()` 17646 | `oatFragment` 2295 | `oatRT` | FIELD² RGBA32F | **dirty-flagged** (oat change only). 64 Gaussians, cross-chart via `mapSeamReceiverToSourceVirtualUv` |
| F2 | `renderDensity()` 17656 | `particleVertex` 3422 + `densityFragment` 3550 | `densityRT` | FIELD² **RGBA8 Linear** | THREE.Points × capacity, additive; **drawn twice** with seam stitching (`u_splatMode` 0/1 mirror splat) |
| F3 | `updateAgents()` | §1a | | | |
| F4 | `diffuseField()` 17788 | `diffuseFragment` 2532 | `fieldRT` swap | FIELD² RGBA32F | 8-neighbour box blur + decay + clamp; each neighbour through `resolveSampleUvUnified` |
| F5 | `renderDepositDensity()` 17690 | same Points | `depositDensityRT` | RGBA32F / RGBA16F iOS (`makeBlendableFloatRT` 1844) | additive, 1–2 draws |
| F6 | `applyAgentFoodDeltas()` 17806 | `deltaFragment` 3674 | `fieldRT` swap | RGBA32F | uptake `food·(1-exp(-k·exposure))` + deposit |
| F7 | `equalizeField(fieldRT)` 17817 | `seamEqualizeFragment` 3610 | swap | RGBA32F | averages seam-twin texels via weld maps |
| F8 | `clipCanonicalField()` 17831 | 2611 | swap | RGBA32F | zeroes non-authoritative texels |

Optional: `renderAgentDensityOverlay()` 17673 → RGBA8, only when `showAgentDots`.
**Default frame ≈ 33 fullscreen passes** (21 of them the scan).

### 1c. Display smoothing chain — `smoothRenderField()` main.js:17952

Gated by `smoothSettleFramesRemaining` (600-frame budget re-pinned by `markRenderFieldChanged()` 8008-8012). Six passes: D1 copy to `fieldSampleViewRT` (RGBA32F Nearest 1689); D2 `smoothFragment` 2823 horizontal → scratch; D3 vertical + **temporal blend** → `renderRT`; D4 clip to authoritative → `renderSampleViewRT` (**RGBA16F Linear** 1728); D5 `padFieldAcrossSeamsSafe` 17872 (redirect halo); D6 equalize.
Taps: `u_smoothingTapCount` 0–14 from `PERFORMANCE_MODES` 301-314 (quality 14 / balanced 7 / fast 3; mobile forced fast 18613-18617). "Smooth field" toggle = Linear-vs-Nearest filter flip only (`applySmoothFieldDisplayFilters` 5569).
Dead/on-demand: `dilateMaterial` 4574, `sampleViewCopySmoothMaterial` 4560, `displayPrefilterMaskMaterial` 4554 (retired prefilter), `clampMaterial` 4494.

### 1d. Mesh render — `renderSceneOnce()` main.js:18721

One `renderer.render(scene, camera)` to the default framebuffer:
- `mesh` + `slimeMaterial` (ShaderMaterial GLSL3, DoubleSide): `slimeVertex` 3979 / `slimeFragment` 4003. Custom `a_renderUv` attr (micro-chart fallback 14378). Reads `renderSampleViewRT.read` (RGBA16F Linear); bump normals from 4 (8 with diagonals) `readFoodSafe` height taps; thin-film + GGX with **32 point lights** (12 icosa verts + 20 face centres 1611-1625, `microfacetSpecular` 4118). No shadows, no IBL for slime.
- `goldWaferBodyMesh` — same geometry, `MeshPhysicalMaterial` patched via `onBeforeCompile` 5165-5269; renderOrder 0; slime renderOrder 2 with One/OneMinusSrcAlpha (5368-5414).
- `oatGroup` additive Sprites; optional `wireframeOverlay` 18620; 12 debug-view material swaps 18675-18707 (materials 15398-15472).

### 1e. Post / glow

**No post chain, no bloom, no tone mapping.** Glow = CPU `CanvasTexture` radial gradients (`makeRadialGlowTexture` 5652; per-pixel loop; `?legacyglow` restores `createRadialGradient` which caused iOS green pox 5674). Oat glow sprite 5789 (additive, renderOrder 4/8); intro sprite renderOrder 20 (6339); fizzle markers 5828.
One-shot env: `goldWaferBodyIcoEnvFragment` 2064 → 512×256 RGBA16F equirect → `PMREMGenerator` once (4403). `maxFoodHistoryFragment` 2972 → running per-texel max food (format probed R16F→RGBA16F→RGBA32F, 1973-1999), 1×/frame when gold body on (18671).

### 1f. Readback / stats

- Observation scoring: `observationTriggerScoreMaterial` 4505/2632 → **MAX_OATS×1 RGBA32F** RT (1742), polled ≤ every 220 ms (7366). Fast path: 1×1 RGBA8 + `ANY_SAMPLES_PASSED` occlusion query = zero readback (7381-7434). Fallback async PBO + fenceSync (7436-7544).
- Agent count: 1×1 read of last prefix texel (`readAgentCountFromPrefix` 19079), throttled 650 ms, skipped under load, **off by default** (`statsReadbackEnabled:false` 542).
- GPU timing: `EXT_disjoint_timer_query_webgl2` + named-pass registry (`getManualPasses` 14830, `createPerfHelpers` 14993), dev only.

### 1g. Load-time passes (once)

`buildUvMask` 15875 (+CPU conservative raster → `surfaceCoverageRT`); `buildChartOwnershipTextures` 14340 → `chartIdRT` RGBA32F + `chartUnsafeRT` RGBA8; `buildSeamData` 15916 rasterizes halo/weld/transition quad batches (4 transition atlases `FIELD·4 × FIELD` RGBA32F each ≈ **600 MB at 1536** — why mobile is pinned at 768, 105-114); `buildPtexAdjacency` 16919; shader prewarm throwaway frame 15489-15494. Memory audit: `estimateRenderTargetMemory` 14896 (32 targets).

## 2. Agent lifecycle

**Storage**: one vec4/agent in `agentRT` RGBA32F: `.xy` UV pos, `.z` heading rad, `.w` reserve (≤0 dead). `pixel = (i % AGENT_SIDE, i / AGENT_SIDE)` (`fetchAgent` 3043).
**Sense/move** (`advanceAgent` 3170): 3 sensors at `angle, angle±u_sensorAngle`, distance `u_sensorDistance` (0.008 UV ≈ 12.3 texels at 1536!) + a "stay" score. `scoreAt` 3138 = `foodWeight·(1-exp(-1.2·food))·appetite + crowdWeight·crowdPreference − mouseRepelPenalty`; food = dynamicField + rationedOat; crowd from `densityRT`. Move `stepSize·dt·moveScale`, `moveScale = max(minMoveScale, smoothstep(0,0.08,best−stay))`. Cross-seam via `resolveMoveUvUnified`; on failure **hold position + reverse turn** (never teleport). Heading rotated by frame (sinT,cosT) when `u_useHeadingRotation` (`rotateHeading` 3082).
**Metabolism**: `reserve += (uptake·food − deposit − burn)·dt`, clamp `u_maxReserve`; ≤0 ⇒ dead (3218-3222).
**Deposit**: agents splat into `depositDensityRT` (additive points); `deltaFragment` 3674 converts: `deposited = depositRate·exposure`, `uptake = food·(1-exp(-uptakeRate·exposure))`.
**Division**: reserve > reproThreshold ⇒ 2 child proposals (`makeChildCandidate` 3225) at ±reproAngle + jitter, offset `u_childStep`, `childReserve = 0.25·parent.w`; parent debited 0.25·w per **accepted** child (`acceptedChildDebit` 3355).
**Scan+compact**: exists only because WebGL2 can't scatter/append. 22 passes over `AGENT_SIDE × 3·AGENT_SIDE` + binary-search compaction per sim step. **This is the structural cost WebGPU's atomic append deletes.**

## 3. Seam handling

### 3a. Legacy bake `seam-bake-<N>.bin`

Gzipped (`DecompressionStream` 15199-15211). Layout (`parseSeamBake` 15172 / `exportSeamBake` 15214, LE): magic `'SBK1'`, version 1, fieldSize, slots=4, seamEdgeCount, recordCount, diagLen, JSON diag, then records `{u32 texelIndex; u8 count|0x80 overflow; u32 seamId[count]}`. **Holds only packing decisions** — which directional seam edge won each of 4 candidate slots per texel. All geometry recomputed at load (`walkBakedCandidateRecords` 16676 → `makeTransitionCandidateFrame`/`candidateAtTexel` 16891). Mismatch ⇒ live rebuild (tens of seconds). Applied one atlas at a time to cap CPU spike (16642-16668).
Consumed by `resolveZeroGutterTransitionUv` 2457 inside `safeSamplingGlsl` 2345: 4 slots × 4 fetches = 16 dependent fetches per resolve; fallback 1-texel `seamRedirect` halo; else no-flux wall. Agent variant `resolveMoveUvSafe` 3087.

### 3b. `?ptex` unified affine resolver — **the semantic reference for v2**

- Build `buildPtexAdjacency()` 16919: per-tri UV→world Jacobian (`triJacobian` 16934); `M = pinv(J_dst)·J_src` (`computeSeamAffine` 16953) — carries scale+shear the isometric atlas dropped. Boundary claim by seam-band quad raster, nearest wins (`claimFrame` 16985).
- Storage: `PTEX_FRAME_FLOATS = 24`/frame in `ptexFrameTex` RGBA32F width 2048 (1908-1912, 17033-17041); `ptexBoundaryTex` R32UI FIELD², 0 = no seam (17043-17050). Packed (`packFrame` 16968): t0 = (srcRefU,srcRefV,dstRefU,dstRefV); t1 = M as mat2(m00,m10,m01,m11); t2 = (srcChart,dstChart,sinT,cosT); t3–5 unused.
- Resolve `ptexResolverGlsl` 2192: `destUv = M·(sampleUv − srcRef) + dstRef`, guarded by outside-atlas / unsafe / chart-match; **~4 fetches vs 16+**. Agent variant `agentMoveResolverGlsl` 2250 returns (sinT,cosT).
- Compile-time gating 139-146, 2239-2248: stub aliases unified→Safe when off (register pressure alone cost 41→33 fps).
- Migrated: display smooth + slime bump (43509fe), diffusion (b561b4b), agent sense+move (c49385b). **Not migrated**: density splat (`trySplatTransitionCandidate` 3472), `oatFragment` (2093), equalize, padding.
- Runtime gate quirk: only `ptexDisplayActive` is consulted (17747, 17798, 17966); `?ptexsim=1` alone only forces compilation.
- Known gap: **corners** (single-winner boundary index; >1 seam meeting a texel). v2 should carry a small per-texel frame *list* at corners.
- ⚠️ `verifyPtexAdjacency` 15799-15855 + comment 1901-1907 read the **old** frame layout — the verifier reads garbage offsets; its match-rate is meaningless.

## 4. Mesh + gold material

- GLB via `GLTFLoader`, `luyvwj-fwgyww.glb` (15.7 MB, raw attributes, no extensions; embedded texture **unused** — material replaced at 15379). onLoad 15294: force index+normals, **bake normalization into geometry** (translate to origin; scale longest bbox extent to `SURFACE_WORLD_SIZE = 9.6`), build `MeshBVH` + `acceleratedRaycast`, `frustumCulled=false`.
- Gold tensor JSON `[10 angles × 600 thickness × RGB] uint8`; angles `[0,10,…,80,85]°`, thickness 10→610 nm log-ish; strict validation 4959.
- LUTs: exact 600×10 RGBA8 Nearest (`buildGoldWaferLookupTexture` 4995; shader Catmull-Rom in thickness × 4-tap Hermite in cosθ = 16 taps, `goldWaferFilmColor` 4220). **Fast path used in game**: `buildGoldWaferFastLookupTexture` 5073 pre-evaluates angle Hermite on CPU → **600×256 RGBA8 Linear** rows uniform in cosθ → one bilinear fetch (4948-4952). `GOLD_BODY_FAST_LOOKUP = true` (190).
- Gold body: MeshPhysicalMaterial (metalness 1, DoubleSide) with 5 injection points (color/roughness/metalness/lights_fragment_end); driven by `uGoldBodyMaxFood` **running max** (the gold "remembers" where slime has been). `customProgramCacheKey` 5268.
- Env: procedural equirect from the 32 icosa light dirs (`pow(align,42)·1.25 + pow(align,360)·22`, 2064) → PMREM once. Slime loops the 32 lights directly.

## 5. Flags & dev hooks

| Flag | Where | Effect |
|---|---|---|
| `?dev` | 130 | skip start+intro, seed now; forces `PTEX_COMPILED` |
| `?dev&state` | 15865 | restore IndexedDB snapshot |
| `?safe=1` | index.html:854 | diagnostics only, main.js never injected |
| `?diag` | index.html:195 | force diag overlay |
| `?rafshim` | index.html:20 | setTimeout rAF (headless) |
| `?ptex=1` | 138 | affine resolver for display (only runtime gate that matters) |
| `?ptexsim=1` | 139 | compile-only in practice |
| `?mobile=0/1` | 98 | force/defeat phone profile |
| `?field=N` | 116 | FIELD_SIZE override (needs matching bake or live rebuild) |
| `?smoothfield=0` | 123 | Nearest display filter |
| `?legacyglow` | 126 | Canvas2D gradient glows |
| `?bakeExport` | 149 | record bake winners |
| `?nofloatblend` `?nolinearfloat` | 1141-1144 | simulate iOS on desktop |

`window.__diag` (index.html:198-217): ring log → localStorage every 250 ms, load counter, 20 s watchdog, `BUILD_VERSION` cross-check (`'2026-07-07-ptex-unify-agents'` main.js:10 / index.html:27).
`window.__cuttle` 15507-15856: `runOnce(pass)`, `profilePassesOnce/Average`, `estimateRenderTargetMemory`, `growFast(steps)` 15758 (synchronous; under-grows — no oat decay/reveal timing), `frameMesh`, `seedNow`, `saveState/loadState` (IndexedDB `cuttle-dev-state`, raw Float32 of fieldRT+agentRT, 18012/18029), `setPtex/setPtexDebug` (debug renders bump normal as RGB 4288), `paintSurfaceField(freq)` 18063 (world-continuous synthetic field — blind to artifact #3), `exportSeamBake`, camera pose get/set.

## 6. Libraries

Import map (index.html:218-226, unpkg): `three@0.170.0`, addons (only `GLTFLoader`, `OrbitControls`), `three-mesh-bvh@0.8.3` (`MeshBVH`, `acceleratedRaycast`). Everything else hand-rolled. Guard: `HTMLScriptElement.supports('importmap')` (needs iOS 16.4+).

## 7. CPU per-frame work

Intro/camera easing every frame; `updateOatFoodDecay` 17221 (250 ms tick; power → ⅓ over 90 s; sets `oatDirty`); `updateOatGlowMarkers` 6692 (facing dot + BVH occlusion, staggered); `updateObservationSlimeTriggers` 7689 (≤4 oats/pass, ≥220 ms); pointer repel raycast (45 ms throttle, BVH → UV + chart, 18127); unthrottled raycast on pointerup for oat drop 18211; spatial-audio sync ~15 Hz delta-gated 8663; DOM annotation layout 7822 (`setTextIfChanged` idiom 74-96); `controls.update()`; dirty-flagged resize 20079; stats 19043.
