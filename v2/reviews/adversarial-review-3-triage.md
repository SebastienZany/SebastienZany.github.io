# Adversarial review #3 (Codex, 2026-08-15) — triage and dispositions

> Round 3 ran against a frozen tree, targeting the round-2 amendments. 24 findings; closing
> verdict "substantial issues remain" — correct. **All 24 accepted** (11 design corrections,
> 7 stale-text/consistency bugs introduced by rounds 1–2 editing, 6 spec-tightenings). Legacy
> claims spot-verified before acceptance: bump-tap radius = base + 0.65·spatialSmoothing
> (main.js:669 region, ×√2 diagonals → ~10.6 texels at slider max); crowd `densityRT` is
> saturating **RGBA8 + Linear** (main.js:1781); desktop display history is **RGBA32F**
> (main.js:1702-1712); `simulate()` order is density → agents → **diffuse → deposit → delta**
> (main.js:18098). Reviewer's new numbers (630 chart-local slit components, 53 cross-chart
> groupings, 19 branch junctions, 5 closed loops) adopted as expectations for M1 to confirm.

| # | Sev | Claim | Fix applied |
|---|---|---|---|
| 1 | high | spatialSmoothing drives **direct bump taps** to ~10.6 texels — iteration can't fix a tap; GUTTER=4 dies | v2 realization defined: direct taps clamp at GUTTER−1 (=3 + bilinear = 4); smoothing beyond that is realized in the display blur (iterated isotropic passes) that the taps then read — smoothing-before-derivative, same visual class, params preserved, packing survives. Conscious realization delta, artist-judged at slider extremes; CT footprint table pins "max direct tap = GUTTER−1" as a frozen invariant. |
| 2 | high | 570 endpoint-grouped slit components aren't chart-local work units (53 span charts, 19 branches, 5 closed loops; 630 by chart) | Splitter work unit = **chart-local component (expect 630)**; branches decompose into simple paths at junctions; closed loops get one seed cut then two extensions; M1 groups with `chartOf` included. Postconditions (finding 18) make this testable. |
| 3 | high | "Nearest boundary point" donor walk not constructive at corners/ties | Constructive rule specced: closest boundary point in uv1 (ties → lowest edge id; vertex hits → incident edge minimizing angle to the offset direction), entry triangle fixed by that edge, offset mapped through its tangent basis, walk length = world-scaled uv distance. Corner claims demoted from assumed to **measured**: cross-bisector donor-jump magnitude and corner-error radius are suite outputs, and the stale "sector-composed/multi-donor" phrasing is gone. |
| 4 | high | Authoritative 2×2 bilinear footprint may not exist at the walk endpoint | Donor records generalized: **up to 4 arbitrary authoritative texels + weights** (a gather stencil, not a bilinear UV) chosen at bake time to approximate the endpoint; existence guaranteed, error measured, runtime becomes pure gathers. Record = 24 B (budget updated, finding 15). |
| 5 | high | Child admission counter overshoots capacity | Admission idiom specced: `old = atomicAdd(count,1); if (old ≥ cap) atomicSub(count,1)` + a post-pass finalize kernel (which also writes next-step indirect args) — transient overshoot invisible, final count exact. |
| 6 | high | "No slot written twice" conflicts with parent debit; exposure must scatter over the *final* population | Assertion reworded to the sound property ("no two invocations write one slot; children never land in [0,S)"); pass B debits its parent (same-invocation rewrite is fine); **exposure scatter moved after pass B** — which matches legacy's real order (finding 9). |
| 7 | high | Single-texel scatter breaks sub-texel continuity; σ derivation wrong (disc σ≈1.45, not 1.9) | **Bilinear (fractional) scatter** — 4 weighted atomicAdds — for crowd *and* food deposits; σ derived from the legacy smoothstep falloff (per-axis ≈1.45 at default), pass count from σ²-addition (~4–5 passes). Phase-sweep test stays meaningful. |
| 8 | high | Legacy crowd field is saturating RGBA8 + Linear; v2's r32f nearest is linear-unbounded | v2 spec: clamp density to [0,1] after blur (saturation semantics) + manual bilinear in sensing; float precision kept (8-bit quantization consciously dropped, documented); superposition test now expects saturation. |
| 9 | high | Legacy diffuses **before** deposit/delta; PLAN reversed it | Frame order corrected to legacy's exactly: oats → crowd → agents (A/B) → diffuse+decay → exposure scatter → delta apply (fills interleaved after each write). |
| 10 | high | Display schedule fills only after the blur that needs gutters | Display chain fixed: copy → EMA → **fill** → [blur pass → fill] × n. |
| 11 | high | M5's separable display blur has the conceded rotated-seam defect | Display blur is **iterated isotropic** too — one blur discipline everywhere; separable is gone from the plan entirely (with finding 14). |
| 12 | high | M4 summary resurrects "the M3 separable Gaussian" | Stale text fixed (M4 brief would have been cut from it — exactly the failure mode the reviewer named). |
| 13 | high | Snapshot/restore omits step/controller/params/oat state → restored runs diverge | Snapshot contract = buffers **+ stepIndex, RNG stream ids, controller state, params, oat list/cursor**; restore test asserts continued-run equality, which only passes with complete metadata. |
| 14 | med | σ>3 separable fallback ungated (expensive vs seam-wrong cliff at legal settings) | Fallback **deleted**: iterated-isotropic covers the full legal range (worst case ~20 passes on the small density field, ~48 M texel-ops — bounded, priced in the budget); no second code path, no caveat, no gate needed. |
| 15 | med | Budget understates gutter records (measured 30%@1536 / 46.8%@1024, not 15%) and load-time peak | memory-budget.mjs updated: measured gutter fractions, 24 B stencil records, a transient load-peak row (compressed + inflated + staging coexist); M0 rehearsal sizes from the script. |
| 16 | med | 1024 density lever silently retunes the organism (UV params span ~11% more surface) | The lever now **mandates the deterministic param transform**: all UV-space params (sensorDistance, stepSize, child offset, repel radius) scale by s per the unit-semantics table; texel-space kernels untouched. This is the unit table doing its job. |
| 17 | med | Manifest binds files to each other, not the bake to the JS build | The shell embeds the expected **manifest root hash + schema version** (the BUILD_VERSION cross-check pattern legacy already uses); mismatched bake+code combinations refuse to boot. |
| 18 | med | Slit-split geometry has no topology contract | Postconditions added: triangle count/winding/positions/area preserved; non-cut adjacency unchanged; every original slit pair ends in different charts; every extension edge has exactly two sides. |
| 19 | med | ≥2×GUTTER clearance is off by one (closed dilations need > 2G) | Rule corrected to **≥ 2·GUTTER+1** plus a direct dilated-mask empty-intersection assert (the packer's own demand model was per-chart and unaffected). |
| 20 | med | M0 rehearsal benchmarks an artificial race; 60 s vs Playwright's 30 s timeout; ungated | Synthetic tables must be structure-valid (authoritative-only donor reads); a 5 s gated variant runs in `npm test` with an explicit timeout override; the 60 s run is the manual on-device protocol. |
| 21 | med | Both display branches drop desktop EMA history to f16 (legacy keeps f32; stall/banding risk) | History accumulator stays **r32float** (storage-writable core); only the final filterable sample view is 16-bit — exactly legacy's structure (main.js:1702-1712); temporal step-response test added. |
| 22 | med | No legacy-vs-v2 growth gate anywhere | M4 acceptance gains the **growth-envelope comparison**: capture a scripted legacy baseline (`__cuttle`, matched params/size), compare v2's population/coverage/energy trajectories within tolerance bands. |
| 23 | med | PLAN §1.3 still says two-seam rays "fail conservatively" (contradicts endpoint-parity) | Wording fixed to endpoint-only semantics (tunneling chords are parity). |
| 24 | low | Reference doc + M3 test text still prescribe u32 ids / two-ended / "one-pass correct" | Operative text corrected in both places (the banner alone wasn't enough — the reviewer is right that later prescriptions win). |

**Convergence read:** no finding attacked the architecture's direction (repack + walk-filled
gutters + resolver-for-agents + world-space kernels survived intact); rounds are now correcting
constructions, schedules, and my own edit debt. One more round after this batch to confirm the
curve has flattened.
