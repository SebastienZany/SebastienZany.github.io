# Physarum-17 — Seam Bug: Complete Knowledge Dump

**Repo:** physarum-17 (bestiaryofvanishings.com, static GitHub Pages)
**State at writing:** `main` = `c49385b` (deployed). Branch `ptex-delete-atlases` = `a556984` (parked, not merged).
**Line numbers below are approximate, as of `c49385b`.**

---

## 0. TL;DR

There are **three distinct seam artifacts, not one**. They have different causes.
A per-edge affine resolver ("ptex") was built and shipped; it fixes artifact #1
only. **Artifact #3 is what you actually see when zoomed in, and it is still
unfixed.** Do not conflate them.

---

## 1. The substrate

The simulation field **is** the mesh's UV atlas. Mesh is a Tripo AI auto-unwrap:

- 501,428 triangles, 281,981 verts
- 1,233 UV charts, 60,068 boundary segments
- 44 sub-texel/micro charts; ~188 charts quarantined at field 768
- Charts adjacent in 3D are arbitrarily far apart in the atlas, with <1 texel
  gutters. **The packer reserved no clearance.** This is the root difficulty.

```
FIELD_SIZE = ?field= override || (IS_MOBILE_DEVICE ? 768 : 1536)
MOBILE_FIELD_SIZE = 768   (1024 was tried and reverted for iOS jetsam)
Desktop = 1536
```

⚠️ Validate at **1536** — bugs differ from 768.

---

## 2. The three artifacts

### Artifact #1 — jagged/staircase bright facets (bump lighting)

**Status: FIXED by ptex** (verified on synthetic field).

Bump normal = 4–8 finite-difference taps at radius ~1.65–2.33 texels, each
routed through `resolveSampleUvSafe`, which reads **Nearest**-sampled
chartId/unsafe textures. Per-tap validity flips in texel-quantized steps, and
taps overrun the 1-texel real-data halo (`SEAM_REDIRECT_HALO_TEXELS=1`) into the
zeroed gutter → large spurious gradient → lit facets. The redirect atlas is
Nearest → piecewise-constant → staircase.

Why it *appeared* after the RGBA16F+Linear smoothing work: smoothing made chart
**interiors** continuous, so the still-Nearest seams stopped being camouflaged.
They were always there.

### Artifact #2 — missing black triangles

**Status: NOT FIXED.**

`food = isAuthoritativeChartTexel(v_uv) ? ... : 0.0`. A mesh triangle straddling
a 3D seam has its interpolated UV sweep through gutter/unsafe texels → food=0 →
black. ~152 unsafe texels involved.

`a_renderUv` (`buildRenderUvFallbackAttribute`) only remaps **quarantined
micro-charts**, not ordinary two-healthy-chart seam-straddling triangles, so it
never fixes these.

### Artifact #3 — blocky staircase field edges ← **WHAT THE USER SEES**

**Status: NOT FIXED. ptex does not address this.**

The low-res food field has **hard edges where atlas charts end**. Bilinear
filtering smooths the *inside* of each chart but cannot smooth *across* a hard
chart boundary — beyond the 1-texel halo the field cliffs to zero. Zoomed in,
those boundaries read as hard blocky steps at the edges of bright food regions.

**Evidence:** on real grown slime at 1536, zoomed in, ptex ON and ptex OFF are
nearly identical and the blocky staircase is present in **both**.

**Why it was missed:** ptex was validated against `paintSurfaceField()`, a
*smooth synthetic* test field with no sharp bright edges. Real slime has sharp
food edges that collide with chart boundaries. Synthetic validation cannot catch
this. **Always validate on real grown slime, zoomed in.**

---

## 3. Why the old mitigation stack can never be seamless (structural)

chartId/unsafe ownership textures + seamRedirect atlas + 4-candidate
seamTransition atlases + 1-texel weld/pad halos + zero-gutter transitions +
`a_renderUv` + equalizeField **together** reconstruct the lost 3D adjacency as a:

> 1-texel-wide, value-only, per-texel-quantized, ≤4-candidate, single-winner,
> nearest-rotation approximation.

That is narrower than the sampling kernel, coarser than the seam, and blind to
the derivative. It can only ever be *less-visibly-seamed*, never seamless.

Already tried and reverted: out-resolving it (1024→768), smoothing over it
(bicubic prefilter — overran the 1-texel halo).

**Do not add another mitigation layer.**

---

## 4. The invariant any correct fix must satisfy

> Every rendered fragment maps to an authoritative texel whose **full** bump-tap
> + bilinear footprint reads same-surface real data with a **continuous value**
> and a **consistently-rotated gradient** across seams.

---

## 5. The key mathematical insight (the valuable part)

The per-edge cross-seam map **must** be the full metric affine:

```
M = pinv(J_dst) * J_src        where J = [dP/dU | dP/dV]
                              (per-triangle UV→world Jacobian)
```

It must **not** be the atlas's isometric along/depth decomposition.

**Why:** this Tripo atlas stretches the two sides of each seam *differently* (it
is non-isometric). The old isometric map leaves the cross-seam field
**derivative** discontinuous. The film **value** is C0 (continuous) but not C1.
That is exactly why turning the bump OFF hides the seams while the bump exposes
them — the bump *is* a derivative. The full affine makes it C1 → facets gone.

Neither the old atlas nor any prior mitigation ever did this.

---

## 6. What was built and shipped (`main`, `c49385b`, live)

**`buildPtexAdjacency()`** — ~16935, called from ~16601

Computes **purely from mesh geometry**: `seamEdges`, `uvAttr`, `pos`, `T`/`B`
tangent frames, `chartOwnership`. Reads **none** of the legacy atlas arrays/RTs —
so it is cleanly separable from them.

Produces:

| Symbol | Type | Purpose |
|---|---|---|
| `ptexFrameData` | Float32Array | per-edge affine frames |
| `ptexBoundaryFrameId` | Uint32Array | **single-winner** boundary index per texel |
| `ptexFrameTex` | RGBA32F DataTexture | Nearest, ClampToEdge |
| `ptexBoundaryTex` | R32UI DataTexture | `usampler2D`, Nearest |

~60,068 frames, ~8MB total vs ~144MB for the atlases it replaces.
`PTEX_FRAME_FLOATS = 24`, `PTEX_FRAME_TEX_WIDTH = 2048`.

**Frame packing layout** (`p = seamId * PTEX_FRAME_FLOATS`):

```
p+0,  p+1     uvARef   (source reference UV)
p+2,  p+3     dstARef  (destination reference UV)
p+4 .. p+7    m00, m10, m01, m11   (M as mat2 columns)
p+8           sourceChart
p+9           destinationChart
p+10, p+11    sinT, cosT   (tangent-frame heading rotation, for agents)
```

**GLSL** (both compile-time gated):

- `ptexResolverGlsl` ~2198 → `resolveSampleUvSeam()`, `resolveSampleUvUnified()`
- `agentMoveResolverGlsl` ~2265 → `resolveMoveUvSeam()`, `resolveMoveUvUnified()`

Core resolve: `destUv = M * (sampleUv - uvARef) + dstARef`
Guards: `isAuthoritativeChartTexel(base)`, chart match on both ends,
`isOutsideAtlas`, `isOwnershipUnsafe`. Fails **conservative** (`valid=0` → caller
falls back; agents hold their chart, never fly off).

**Flags** ~150–159:

```js
PTEX_DISPLAY  = ?ptex    === '1'   // default OFF on main
PTEX_SIM      = ?ptexsim === '1'   // default OFF on main
PTEX_COMPILED = PTEX_DISPLAY || PTEX_SIM || DEV_MODE
ptexDisplayActive                  // mutable, live A/B via __cuttle.setPtex
```

### ⚠️ Critical perf lesson — compile-time gating

The resolver's extra samplers cost register pressure at **shader compile time**,
regardless of the runtime `u_usePtex` branch. A runtime flag does **not** avoid
it. (Precedent: baking `safeSamplingGlsl` into a hot fullscreen pass cost
41→33 fps *even when the branch never executed*.)

So when `PTEX_COMPILED` is false, shaders include a **zero-sampler stub** that
aliases `resolveSampleUvUnified` straight to `resolveSampleUvSafe`.
Measured: shaderPrewarm **2592ms** (ptex compiled) vs **1525ms** (stub).
Production pays nothing.

**Migrated onto the unified resolver:**

- slime bump (`slimeFragment` `readFoodSafe`)
- display field smoothing (`smoothMaterial` / `smoothRenderField` ~17873)
- sim field diffusion (`diffuseMaterial` / `diffuseField` ~17719)
- agent sensing (food/oat/density) + agent movement (parent step + child spawn)

---

## 7. Validation results — be precise about what was and wasn't proven

**PASSED** (synthetic surface-continuous field via `paintSurfaceField`):

- Bump normal-map bands continuous across seams with ptex ON; visibly broken
  with ptex OFF. (`setPtexDebug` renders normal as RGB for A/B.)
- Film renders clean, no black triangles, no facets.

**PASSED** (sim integrity, 1500 steps at 768):

- nonAuthoritative energy = 0, unsafe energy = 0, totals finite (no mass leak
  into gutter/unsafe texels, no agent fly-off, no NaN).
- Affine agents grow statistically identical to legacy:
  **215.6 energy / 24,364 texels** vs **227.2 / 23,101** (~5%, stochastic).

**FAILED / NOT PROVEN** (real slime at 1536, zoomed in):

- ptex ON vs OFF nearly indistinguishable; blocky staircase (artifact #3)
  present in both. **This is the open bug.**

**NEVER TESTED:** on-device iPhone, real slime, real memory pressure.

### `verifyPtexAdjacency()` caveat — do NOT "fix" this

It reports **~0% match** against the legacy atlas. That is **expected and
correct**. The full affine *intentionally* diverges from the atlas's wrong
isometric map — that divergence **is** the fix. Atlas-match was only a meaningful
metric during the early isometric build phase.

---

## 8. The atlas deletion attempt (`ptex-delete-atlases`, `a556984`, NOT merged)

Deleted the four transition candidate atlases + their build/bake/GLSL machinery
(−1164 net lines). RT memory **306 MiB → 180 MiB** (~126MB freed — this is what
would unlock a 1024 field). Kept redirect/weld atlases, chart ownership, and all
ptex code. Compiles clean, renders correctly, no field corruption.

### 🔑 Key finding: the transition atlases were NOT purely redundant

Beyond seam-crossing (which the affine replaces), they powered **cross-seam oat
and cross-seam density feeding** via `mapSeamReceiverToSourceVirtualUv()`'s
**arbitrary-chart, 4-candidate** lookup. The ptex boundary index is
**single-winner** (exactly one nearest-seam neighbor per texel), so it
structurally cannot replicate an arbitrary-chart query.

Measured impact (controlled same-session A/B, 1500 steps):

| Config | Energy | Texels |
|---|---|---|
| `main` (atlases intact) | 287.8 | 29,972 |
| after deletion | ~95 | ~14,000 (~3× growth loss) |
| after oat restore | 200.1 | 22,979 (~70% of baseline) |

Restore used `ptexCrossToNeighbor()` in `oatFragment` — maps the fragment across
its nearest seam via the affine, contributes if that neighbor is the oat's chart.
Residual gap = still-dropped cross-seam **density** splat (`particleVertex` splat
mode 1, currently culled) + oats on non-nearest neighbors.

**Why it is not merged:** ~~`main.js` feeds seam atlases to the WebGPU port via
`buildSeamTexturesForWebGPU()`~~ — **this blocker is GONE as of `cd7dd1d`**
("Remove WebGPU bridge from main.js; keep WebGPU work confined to dev.html +
webgpu/"). `buildSeamTexturesForWebGPU`, `WEBGPU_SIM`, and `WEBGPU_SEAM` no
longer exist in `main.js`, so the deletion can no longer break `?webgpu=1&seam=1`.

**The one remaining blocker is the growth regression** (§8 table above:
~70% of baseline after the oat restore, with the cross-seam density splat still
dropped). Resolve that — restore cross-seam density splatting via the affine,
and validate on *real* frame-driven growth, not `growFast` — and the branch is
mergeable for a ~126MB win. Note the branch predates `cd7dd1d`/`9c38913` and
will need a rebase onto current `main`.

---

## 9. Hard constraints (learned the painful way)

### iOS Safari

- **NO** `OES_texture_float_linear` → any linear-filtered texture must be RGBA16F
- **NO** `EXT_float_blend` → additively-blended claim masks must be RGBA16F
- ~300MB per-tab RT budget; 306 MiB at 768 sits right at the jetsam edge
- 1024 field was reverted for jetsam
- **iOS GPU/canvas artifacts CANNOT be reproduced in the desktop preview.**
  (Precedent: the green "pox" was iOS Canvas2D gradient dithering + Display-P3;
  a whole session was wasted A/B-ing it on desktop, which was always clean.)
  Bisect with deployed URL flags on the actual phone.

### Perf

- Never compile seam GLSL into a hot fullscreen pass without a compile-time gate
  (41→33 fps register pressure).
- Per-fragment bicubic (4×4 footprint) reverted: exceeds the 1-texel halo →
  glitchy color bands along seams. Bilinear's 2×2 is the current ceiling.
- `SEAM_REDIRECT_HALO_TEXELS=1` is entangled with baked seam data and padding
  budgets. **Do not widen casually.**
- GPU timer queries (`perf.timePass`) unreliable in headless preview (idle
  downclock inflates 3–5×). Use the fps readout.

### Test-harness gotchas

- `measureFieldDomainEnergy()` is **throttled** (~100ms) and silently returns a
  **stale cached result**. Space measurements ~3s apart or you will compare a
  number against itself. (This produced one bogus `retained=1.0000` reading.)
- `growFast()` **under-grows**: the sim needs the full `frame()` update (oat food
  decay, seed reveal timing) and `frame()` self-schedules via rAF. Real growth
  takes minutes of wall time. growFast numbers are directional only.
- Headless preview: tab reports hidden and rAF freezes → need `?rafshim=1`.
- Shader prewarm ~40s per reload (driver compile) is unavoidable.

---

## 10. Key code anchors (verified @ `3a74674`, main.js = 20,110 lines)

| Line | Symbol |
|---|---|
| 138 | `PTEX_DISPLAY` / `PTEX_SIM` / `PTEX_COMPILED` flags |
| ~1800 | `chartIdRT` / `chartUnsafeRT` (both **Nearest**) |
| 2192 | `ptexResolverGlsl` |
| 2257 | `agentMoveResolverGlsl` |
| 2345 | `safeSamplingGlsl` (legacy resolver block) |
| 2488 | `resolveSampleUvSafe` |
| 13976 | `rasterizeUvOwnershipMaps` |
| 14378 | `buildRenderUvFallbackAttribute` (`a_renderUv`) |
| 15916 | `buildSeamData` |
| 16516 | `buildAndUploadTransitionCandidateMaps` |
| 16847 | `makeTransitionCandidateFrame` — shared by legacy AND ptex, **keep** |
| 16892 | `candidateAtTexel` — shared by legacy AND ptex, **keep** |
| 16921 | `buildPtexAdjacency` (+ `triJacobian`, `computeSeamAffine`, `packFrame`, `claimFrame`) |
| 17787 | `diffuseField` |
| 17874 | `padFieldAcrossSeamsSafe` |
| 17934 | `updateRenderSampleView` |
| 17950 | `smoothRenderField` |
| — | `buildSeamTexturesForWebGPU` — **REMOVED in `cd7dd1d`**; WebGPU is now confined to `dev.html` + `webgpu/` and no longer couples to main.js seam data |

> History note: `cd7dd1d` (WebGPU bridge removal) shifted these by ~106 lines
> from the `c49385b` numbering. It removed **zero** ptex/seam-resolver lines —
> only the `WEBGPU_SIM`/`WEBGPU_SEAM` bridge that *consumed* seam atlases.

---

## 11. Dev tooling

### URL flags

| Flag | Effect |
|---|---|
| `?dev` | skip start screen + intro, seed on load |
| `?rafshim=1` | setTimeout rAF trampoline (**required** for headless preview) |
| `?field=N` | override `FIELD_SIZE` |
| `?ptex=1` / `=0` | affine display resolver on/off |
| `?ptexsim=1` / `=0` | affine sim resolver on/off |
| `?safe=1` | diagnostics overlay **without** loading main.js (reads the crashed run's last events from localStorage — the way to get diagnostics off a crash-looping phone) |
| `?smoothfield=0` | Nearest field display (raw disco-ball look) |
| `?nofloatblend` / `?nolinearfloat` | simulate missing iOS extensions |
| `?legacyglow` | restore pre-fix oat glow sprite |
| `?webgpu=1&seam=1` | WebGPU sim bridge with real seam atlases |
| `?bakeExport` | seam bake export mode |

### `__cuttle` console API (after begin)

```
setPtex(bool) / setPtexDebug(bool)  live A/B; debug renders normal as RGB
paintSurfaceField(freq)             SYNTHETIC surface-continuous test field
                                    (f of worldPos) — good for derivative
                                    continuity, BLIND to artifact #3
measureFieldDomainEnergy()          auth / nonAuth / unsafe energy + texel
                                    counts (THROTTLED — see §9)
growFast(steps)                     synchronous sim loop (under-grows)
frameMesh({dir, fill})              frame camera on mesh
saveState() / loadState()           IndexedDB snapshot of fieldRT+agentRT;
                                    ?dev&state auto-restores on reload
verifyPtexAdjacency()               frames vs atlas (expect ~0% — see §7)
ptexAdjacency()                     frame/boundary counts + byte sizes
resetSimulation(), dumpField(), chartIdAt(), getChartOwnershipStats(), ...
```

---

## 12. Next direction for artifact #3 (untested hypothesis)

Use the affine per-edge map to fill a **wider display-field gutter** across chart
boundaries — i.e. write real neighbour-chart data into a multi-texel band outside
each chart's authoritative region, instead of cliffing to zero past the 1-texel
halo. Then the bilinear footprint always lands on real surface data and the hard
step disappears.

Open questions:

- How wide? Must exceed the bump-tap radius (~2.33 texels), so probably 3–4.
- Memory cost.
- Interaction with the ownership/claim gates.
- Whether the single-winner boundary index is enough, or a multi-candidate
  gutter fill is needed at corners.

**Mandatory validation:** real grown slime, at 1536, camera zoomed close to the
surface. Synthetic fields will **not** reveal this class of bug.

### Strategic note

A parallel effort is porting the renderer to WebGPU. As of `cd7dd1d` that work
is **deliberately confined to `dev.html` + `webgpu/`** and no longer touches
`main.js` — the two paths are decoupled.

So the question to settle before investing in artifact #3: **will the WebGPU path
replace the WebGL surface renderer?**

- If **yes** — fixing artifact #3 in WebGL is largely throwaway. Design field-edge
  continuity once, correctly, in the WebGPU path (it gets the affine map for free;
  see §5–6, and note WebGPU compute can do a proper multi-texel gutter fill far
  more cheaply than a WebGL fullscreen pass).
- If **no / coexist** — fix it in WebGL via the §12 gutter approach.

Either way the §5 affine math and the §2 artifact taxonomy carry over unchanged.
