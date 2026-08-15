# M2 — Seam bake: repacked atlas, affine frames, gutter tables, invariant suite

**Objective:** the correct-by-construction seam substrate, built and *proven* entirely on the CPU.
This is the heart of the rewrite — the milestone that makes artifacts #1/#2/#3 impossible rather
than mitigated. Everything here is bake-time Node code + a verification suite; still no GPU.

**Read first:** PLAN §1 (the design, non-negotiable); `SEAM_NOTES.md` §2–5 + §12 (taxonomy,
invariant, affine math — fallible but spot-verified); `reference/legacy-gpu-inventory.md` §3b
(ptex build details + the corner gap + the broken-verifier warning); legacy source anchors
`main.js:16934` (`triJacobian`), `main.js:16953` (`computeSeamAffine`), `main.js:16985`
(`claimFrame`) — port the math, not the surrounding machinery.

Parameters (constants in one module, overridable per bake): `GUTTER` — **derived from the CT
contract's max-kernel-footprint table** (nominally 4; must cover the largest single-pass footprint:
the per-size direct-tap clamp GUTTER−1 + bilinear's 1; wider UI kernels are realized in the display blur, PLAN §1.3),
`MIN_CHART_TEXELS = 4`, target sizes **1536 and 1024** (768 is dropped — the packing arithmetic
fails outright with real gutters at 768; triage finding 3).

## Deliverables

1. **`tools/repack.mjs`** — chart repacking with guaranteed clearance:
   - **Slit handling first, per CHART-LOCAL component:** M1's 3,592 same-chart edge pairs form
     570 endpoint-connected curves, but endpoint grouping merges across charts — the correct
     work unit is the **chart-local component: 630, M1-measured and test-locked** — and M1's
     measurement corrected the round-3 metadata (M1 gate, BLOCKERS resolved): chart-locally
     there are **18 branching components (19 branch vertices) and ZERO closed loops** — the "5
     loops" existed only in the cross-chart endpoint grouping (570), which is diagnostics, not
     the work-unit graph. So: decompose branched components into simple paths at junctions; no
     loop seed-cut path is needed; then extend each endpoint along mesh edges to the chart
     boundary and split. A boundary-reaching path always exists in a connected
     chart, so the splitter **must always succeed — there is no fallback** (display and
     diffusion have no resolver; an unsplit slit is a field cliff; the suite asserts zero).
     Splitting requires **vertex duplication along the cut**: the bake emits its own reindexed
     geometry (per-baked-vertex `uv1`, duplicated cut vertices); M1's `MESH1` original geometry
     is the *input*, the atlas sections carry the derived geometry that the sim and renderer
     actually load. Extension edges become ordinary seam pairs. **Topology postconditions
     (tested):** triangle count, winding, positions/normals, and total area unchanged; non-cut
     adjacency unchanged; every original slit pair's two sides end in *different* post-split
     charts; every extension edge has exactly two paired sides.
   - Rasterize each (post-split) chart's triangles to a texel mask at target size (conservative —
     any texel a triangle touches), dilate by GUTTER.
   - Enforce `MIN_CHART_TEXELS`: scale tiny charts *up* in UV so their footprint is at least
     4×4 authoritative texels (this deletes legacy's sub-texel/quarantined-chart class — record
     how many charts this touched). Upscaling makes these charts' texels denser than their 3D
     area warrants (legacy quarantined them instead), so **bake a per-chart texel-density factor**
     (world-area-per-texel relative to the atlas mean) into the chart table — the compensation
     lever if M4 fixtures or the artist find these charts simming at the wrong rate — and have
     the report rank the worst offenders.
   - Pack dilated masks. **Mask packing is required, not optional** — texel-center demand at
     GUTTER=4 is 82.4% of 1536² and 99.2% of 1024², and under THIS deliverable's conservative
     any-touched-texel rule review #5 measured **~107% @1024-G4, ~94% @1024-G3, ~93% @1024-G4
     with s=0.9** (pre-split lower bounds — re-measure post-split). The 1024 bake therefore
     plans **combined levers** — **(b)** mobile GUTTER=3 with CT-tiered direct-tap clamp, plus
     **(a)** a density sacrifice s as needed — targeting measured demand ≤ ~85%, with **1280 as
     the explicit fallback field size** if the combination fails its gate (decided with the
     user). Output
     per-chart transform (uniform scale + translate — **never rotate**, it would invalidate
     ported tangent conventions) → `uv1` per baked vertex. **If lever (a) is chosen, the
     density sacrifice is not free** (reviews #3/#4): a global scale s changes what every
     parameter spans on the surface, so the bake emits s and the runtime **must** apply the
     deterministic conversions per the CT unit table: UV-space params (sensorDistance,
     stepSize, child offset) scale by s; **surface-space texel kernels scale too** — legacy's
     own precedent is `SPLAT_FIELD_SCALE` (main.js:762: splat pixels scale with effective field
     density), so the crowd kernel radius multiplies by s (the food-deposit sprite does NOT — it is
     pinned at 1 px by legacy's max(1,·) at every size and lever, main.js:780); diffusion stays per-texel
     (legacy never scaled it across field sizes — its 768 organism already diffused differently;
     documented inherited behavior); repel is NOT on this list (it keeps legacy UV+chart
     semantics and scales with the UV group). This is a unit conversion, not a tuning choice —
     optional-if-it-looks-wrong is not acceptable.
   - **Report + gates**: achieved occupancy vs the measured demand at both sizes; mean/min/max
     world-size per texel ratio vs legacy (1536 target within ~15%; 1024 per the chosen lever);
     clearance proof (see tests); post-split demand re-measured (slit extensions add perimeter).
     If a gate fails, don't silently shrink charts — surface it (PLAN risk table).
2. **`tools/seams.mjs`** — one frame per **directional side** (2 per undirected pair, on `uv1`).
   Scope honesty: frames serve the **runtime agent resolver only** — the gutter fill uses the
   exact walk above and never touches frames.
   - UV→world Jacobians per adjacent triangle; **hinge-unfold affine**
     `M = pinv(J_dst)·R_hinge·J_src`, where `R_hinge` rotates the source triangle's plane onto
     the destination's about their shared 3D edge. Legacy's projection form (`main.js:16953`,
     no hinge) collapses transverse displacement at folds (3,718 pairs >60° — verified), so port
     the Jacobian math but **add the hinge**; verify M reduces to legacy's on coplanar pairs
     (test below). Like legacy's, the affine is a single-triangle approximation that degrades
     with distance from the seam (median adjacent-triangle altitude 1.49 texels) — that is
     accepted for agent transport (legacy shipped exactly this class of approximation) and is
     why it must NOT be used for fill.
   - Heading transport is **`normalize(M·d)`** — do not bake a constant sinT/cosT as the
     transport (wrong under shear); a frame may cache the polar angle for diagnostics only.
   - Frame table (flat f32 array, layout documented in the file header: srcRef, dstRef, M
     columns, charts, diagnostics; per-size — frames are expressed in that size's `uv1` and are
     **not shared across sizes**).
3. **`tools/rasterize.mjs`** — per-texel maps at each target size:
   - ownership: chartId (u32, 0 = none) for authoritative texels;
   - worldPos + tangent frame maps (barycentric interpolation at texel centers; for gutter texels,
     via their donor mapping);
   - **gutter fill table — donors by exact geodesic mesh walk, NOT by affine**, with a fully
     **constructive rule** (review #3 finding 3): donor(g) starts at p* = the uv1-closest point
     of the chart's authoritative boundary (ties → lowest seam-edge id; if p* is a vertex, enter
     via the incident boundary edge minimizing angle to the offset direction — deterministic);
     the entry triangle is the one owning that edge; the offset (g − p*) maps through its
     tangent basis; walk the surface triangle-by-triangle for the world-scaled distance —
     through as many triangles and charts as needed (adjacent-triangle altitudes are median
     **1.49 texels**, so a single affine is invalid past the first texel for ~99% of sides, and
     narrow MIN_CHART charts are only traversable multi-hop). Adjacent gutter texels on opposite
     sides of a corner's sector bisector may walk through different edges — that donor jump is
     the corner's C0 discontinuity: **measure it** (cross-bisector donor-value delta on test
     fields, and the radius within which gradient error exceeds threshold) rather than assuming
     a ≤2-texel disc; cone points (defects +181/−1,358) cannot be C1 through the vertex under
     any construction. **Donor record = gather stencil, not a bilinear UV**, constructively
     (review #4 finding 2): where the walk endpoint has a full 2×2 authoritative bilinear
     footprint (the overwhelmingly common case) the stencil IS that footprint — exact class,
     ¼-texel gates apply. Otherwise: taps = the ≤4 nearest authoritative texel centers; weights
     solve constrained least squares reproducing value + first moment, nonnegative, sum-to-one,
     conditioning-bounded, minimum-norm as the deterministic tie objective; when the endpoint lies
     outside the taps' convex hull (or taps are collinear), nonnegativity is relaxed to bounded
     weights (|w| ≤ 2, sum-to-one, min-norm) — mild extrapolation beats a wrong interior point —
     and the texel lands in a **degraded-stencil census** gated on *measured* error. Every
     suite bar that says "¼ texel" applies to the exact-bilinear class only; census texels are
     gated on their measured band (state this in the suite code, not just here). Record layout: gutter-texel coord list + parallel
     4×(u32 texelIndex, u16 weight) — 28 B effective per record; weights quantized with an
     **exact-sum rule** (largest weight absorbs the rounding residual so Σw = 65535 exactly).
     The **reverse lookup the adjoint scatter needs** (arbitrary texel g → its record) is free:
     the ownership map already stores 0 for gutter texels — store `recordIndex + 2¹⁶` there
     instead (chart ids stay < 2¹⁶), so scatter reads one map texel it was reading anyway. A
     **transpose-identity test on deployed data** (scatter a unit through the adjoint, gather it
     back through the stencil, assert round-trip within quantization) establishes the
     conservation claim on the shipped tables, not just in theory. All stencil taps
     authoritative ⇒ the runtime fill stays a single race-free pass. Every gutter texel must resolve (the stencil construction
     cannot fail — nearest authoritative texels always exist); `dead` is reserved for
     unreachable-by-any-footprint texels only (count ~0; investigate any).
   - **boundary frame index** (full field, u32/texel): nearest-seam frame id, with a per-texel
     frame *list* (cap 4) where multiple seams are within sensing range — fixes legacy's
     single-winner corner gap (`reference/legacy-gpu-inventory.md` §3b). The cap WILL overflow on
     some texels — the legacy bake format carries an `0x80` overflow flag on its own 4-slot
     records, which is direct evidence this atlas exceeds 4 candidates in places — so **count and
     list every cap-overflow texel** (nearest-4 kept, rest dropped → resolver degrades to
     conservative failure there); the count is a report gate, not a silent truncation.
4. **`tools/bake.mjs`** — orchestrates M1+M2 → **per-section, individually-gzipped,
   content-addressed asset files** (`atlas-<size>.<section>.<hash8>.bin.gz`) bound together by a
   **manifest** (bake UUID + schema version + per-file content hashes; the loader fetches the
   manifest first and refuses any file whose hash disagrees — per-file CRCs alone would let a
   cached old `uv1` mix with new gutter tables). The manifest itself must be bound to the code:
   **the shell embeds the expected manifest root hash + schema version** (the same
   BUILD_VERSION cross-check pattern legacy uses for index.html vs main.js), so a cached
   old-manifest+old-files combination — internally coherent but incompatible with the running
   JS — refuses to boot with a human-readable message (review #3 finding 17). Baked reindexed geometry + per-size `uv1`/frames/boundary-index/
   gutter-tables/rasters for 1536 and 1024 — repacked UV spaces are size-specific, nothing
   frame-like is shared. **Hard assert every emitted file < 95 MB** (GitHub rejects ≥100 MB and
   Pages can't serve LFS), plus `assets/atlas-report.md` including a **ranked worst-seams list**
   (by fold angle × anisotropy × boundary length, plus the worst defect corners) with UV + world
   coordinates — M5's artifact-kill cameras point at these.
5. **`src/atlas/asset.js`** grows to load the atlas sections. **`src/atlas/fill.js`** — a *CPU*
   reference implementation of gutter fill + the sense/move resolver (gather-stencil donors;
   frame lookup, affine apply, conservative validity) — the suite tests against this, and M4's WGSL
   must match it (it becomes the oracle).
5b. **Block graph for geodesic attenuation** (cross-review): partition each atlas into
   ~32²-texel blocks; emit block-adjacency edges with surface-distance weights derived from the
   chart-adjacency + seam data (per size). Consumed by M4's per-oat placement-time Dijkstra.
   Suite: block-graph distances vs exact mesh geodesics on fixture meshes within stated bounds;
   continuity of interpolated distance across block boundaries.
5c. **Leak detection & fault injection** (cross-review — the suite's own sensitivity principle
   applied to mass): a per-step **exact ledger** in the CPU oracle
   `{T_prev, T_diff, T_post, deposits, acceptedDepletion, upperClampLoss,
   seamFlux := T_diff − T_prev, residual}` with oracle-expected flux on fixtures;
   **per-seam-band signed flux bounds** on the real bake (a single global sum lets
   opposite-signed errors cancel); and **corrupted-donor / wrong-diffusion-tap injections that
   must FAIL the suite** — on fixtures AND the real tables. A leak detector that has never seen
   a leak proves nothing.
6. **`tools/fixtures.mjs`** — tiny synthetic meshes with known-analytic seams, run through the
   *same* bake: `seam-quad` (two abutting charts, controlled non-isometric stretch), a **folded
   variant of it at 45°/80° dihedral** (the hinge-affine truth case), `cylinder` (one wrap seam),
   `two-chart-sphere`, `three-chart-corner` (three charts meeting at a vertex — the corner-walk
   truth case), and a `thin-sheet` (two parallel faces close in 3D — the world-space-kernel bleed
   case for M4). Fixtures make failures debuggable and feed M4's tests.

## The invariant suite — `tools/verify-seams.mjs` (`npm run verify:seams`)

Runs on fixtures **and** the real atlas, at 1536 **and** 1024. All thresholds are constants with a
comment justifying each.

1. **Clearance proof:** authoritative regions of different charts separated by ≥ **2·GUTTER+1**
   (chebyshev — closed G-dilations are disjoint only above 2G; review #3 finding 19 caught the
   off-by-one), verified BOTH by the distance rule AND by a direct empty-intersection assert on
   the dilated masks (no texel claimed by two charts' gutters); every chart ≥ GUTTER from the
   atlas border; every authoritative texel's chart matches its triangle's chart.
2. **Coverage:** 100k random surface points (uniform by area) land on authoritative texels of
   their own chart; every authoritative texel maps back to ≥1 triangle.
3. **Fill-walk and affine fidelity — separate tests with separate bars:**
   (a) **Walk fidelity (tight):** for dense samples across every seam, the fill donor's world
   position matches the true geodesic continuation within ¼ texel — including transverse rows at
   ±1..GUTTER texels (the fold-collapse case edge-only sampling can't see) and through
   multi-triangle/multi-chart continuations; banded by fold angle, worst band reported.
   (b) **Affine fidelity (agent-tolerance):** on the shared edge, `uv_src → M → uv_dst` within
   ¼ texel; off-edge, error vs the walk is *measured and banded by distance* — the bar is
   "no worse than legacy's single-triangle approximation class", not geodesic exactness (the
   affine only serves agent transport). (c) heading transport `normalize(M·d)` within 2° of the
   walk's transport for a fan of directions *at the seam*; (d) on coplanar pairs M reduces to
   legacy's projection form within ε. Report per-seam worst cases → ranked list.
4. **C1 reconstruction (the artifact-#1/#3 killer):** for smooth `f(worldPos)` (3-sinusoid sum):
   fill authoritative texels from the worldPos map, run CPU gutter fill, then along dense paths
   crossing every seam compare (a) bilinear value and (b) bump-style finite-difference gradients
   — **taps at the per-size direct-tap clamp, GUTTER−1** (3 @1536-G4, 2 @mobile-G3; testing only
   the default 2.33 would under-test the operative rule — review #4 finding 10) — against a
   **per-side seamless reference** — each sample compares to the reconstruction of f on an
   unbroken grid at *that side's own chart metric* (one shared grid cannot represent both sides
   of a metric-mismatched seam — review #5 finding 10); the cross-seam property asserted is the
   continuity of the atlas reconstruction itself (value/gradient jump bands), so inherited
   metric anisotropy is not conflated with seam error. Assert atlas error ≤ seamless
   error × (1+ε). **Repeat with a sharp field** (smoothstep front crossing the seam at several
   angles) — the exact case that exposed artifact #3. Sharp-field gate is **pointwise and
   absolute**: at each sample, |atlas − seamless| ≤ ε_abs + k·|∇f_local| — a global
   "no worse than the reference's worst step" bound can bless a fully-broken gutter whose error
   happens to be ≤1 on a unit front (triage finding 26). **Negative control lives HERE in the
   CPU suite**: rerun with gutter fill disabled and assert the gate FAILS — a seam gate that
   cannot detect the legacy bug proves nothing.
5. **Transport:** 100k random agent walks (CPU resolver): stepping across seams keeps world
   position continuous (error < step × ε), heading world-direction continuous (< 2°), and an
   immediate cross-back returns within ¼ texel; zero walks land non-authoritative without a valid
   resolve; conservative-failure rate reported (expect ≈0 on fixtures; small nonzero allowed on
   real corners — every failure texel listed).
6. **Diffusion mass drift (world-area-weighted):** 3×3 gather blur through filled gutters on
   random fields, 100 steps: |**world-area-weighted** mass drift| per step below a
   measured-and-locked tolerance (texel-count mass would bless sources/sinks on upscaled
   micro-charts — triage finding 11); drift maps rendered so seam-concentrated drift is visible.
   (Exact conservation is not required — legacy wasn't conservative either and the sim has
   explicit decay — but drift must be bounded, understood, and stable.)
6b. **Corner exhaustiveness (per-edge-local, cone-aware):** every ≥3-chart corner vertex gets a
   dedicated sampling pass — all gutter texels within GUTTER of the vertex, each validated
   against **its own edge's walk** (a single global "geodesic reference" does not exist at cone
   points; measured defects: +181/−1,358 vertices). At defect vertices, assert value continuity
   along paths crossing each individual edge, **measure** the gradient-error radius and the
   cross-bisector donor jump per corner (no assumed disc size — review #4 finding 10), gate on
   the measured distribution, and emit the worst offenders for the M5 camera list. Random walks
   do not count as corner coverage.
6c. **Impulse spread (diffusion tensor):** inject unit impulses at points straddling seams on
   fixtures + a sample of real charts; after n diffusion steps compare the world-space second
   moment (spread speed + ellipticity) against the seamless reference — bounded mismatch,
   reported per chart-scale ratio band. Mass conservation alone cannot see wrong spread speed
   on rescaled charts (round-2 finding 16); per-chart diffusion compensation stays an optional
   lever, measured here.
7. **Report gates:** density/texel-size vs legacy (from repack); dead-gutter count; corner-list
   frame coverage (every within-sense-range seam represented in the per-texel list) **plus the
   cap-overflow census** — texels needing >4 frames counted, listed, and bounded; per-chart
   texel-density factors within a sane range, outliers ranked; **multi-hop sensing incidence** —
   count of texels whose sensor disc (12.3 texels at 1536) crosses more than one boundary along
   any chord (the single-hop resolver's endpoint-semantics blind spot — PLAN promised this
   metric; note legacy's resolver checks *endpoints only*, so tunneling chords are parity, not
   a v2 regression).
8. **worldPos precision check:** compute the worldPos/tangent maps in f32, quantize to f16, and
   measure the worst-case position error against the smallest world-space kernel the sim uses
   (oat sigma, repel radius). If worst error < 1/8 of that kernel, the shipped asset stores f16
   (halves the biggest bake asset — see PLAN §2 memory table); otherwise f32. Either way the
   decision and the measured bound go in the report.

## Acceptance

`npm run bake && npm run verify:seams && npm test` green at **1536 and 1024**; both reports
committed; the density tradeoff (incl. the chosen 1024 lever) + worst-seam list + slit-split
census reviewed by Claude and signed off by the user (this is the one decision gate in the plan
— PLAN §6 row 1). The verified ground-truth numbers (PLAN §7: pairs/slit-curves/folds/corners/
altitudes/occupancy/demand — independently audited, `../reviews/mesh-audit-results.md`) are
re-derived by the tools as regression tests.

## Forbidden

- No GPU/WGSL. No weakening thresholds to pass — a red invariant is a finding, not an obstacle
  (BLOCKERS.md it).
- No chart rotation in repack; no re-parameterization of chart interiors.
- Do not consult `seam-bake-*.bin` or legacy's transition/redirect/weld construction for
  semantics — they are the design being deleted. The affine build (`triJacobian`/
  `computeSeamAffine`) is the only legacy seam code worth porting.
