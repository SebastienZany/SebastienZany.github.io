# M3 — Deterministic flat-torus sim core (Track B; parallel with M1/M2)

**Objective:** the WebGPU agent/field simulation running on a flat wrapping field (no seams, no
mesh) — **written fresh** (every-line-new mandate: `webgpu/sim.js` is a *semantic and technique
reference* — its atomic-append idea, format choices, and burned gotchas inform the design, but
no line of it is copied; the fix list below is what the fresh write must get right that the
prototype got wrong), tested, and visible in `dev.html`. Written to be read: kernels carry
contract comments, names follow the glossary, modules stay small. This becomes the substrate M4
puts on the real atlas.

**Read first:** `reference/webgpu-prototype-assessment.md` (the verdict + every caveat — this
brief implements its fix list); `reference/legacy-gpu-inventory.md` §2 (authoritative sim
semantics + formulas); prototype source `webgpu/sim.js` (READ for technique, never copy — v2 code lives in
`v2/src/sim/` and is written fresh); legacy formula anchors: `scoreAt` main.js:3138, `advanceAgent` main.js:3170
(agent-side reserve credit ~3210), child rules main.js:3225/3355, delta conversion main.js:3674,
controller theory ~19359 / supply update ~19455 / secondary actuator ~19303.

## Semantics to preserve (the organism must be the same species)

- 3 sensors at `±sensorAngle` + ahead, distance `sensorDistance` (0.008 UV), **plus the "stay"
  score**; score = `foodWeight·(1−exp(−1.2·food))·appetite + crowdWeight·crowdPreference −
  repelPenalty`; move scale `max(minMoveScale, smoothstep(0, 0.08, best−stay))`.
- Economy — **two independent halves, both verbatim-legacy (round-2 finding 1):**
  (a) *Agent side:* each agent credits its own reserve **directly** from the food at its
  position (`reserve += (uptake·food − deposit − burn)·dt`, main.js:3210 region), clamped to
  maxReserve; ≤0 ⇒ death (append nothing). This happens in the agent kernel, per agent.
  (b) *Field side:* per-texel exposure accumulates in an atomic buffer; the resolve pass ports
  `deltaFragment` (main.js:3674-3710) **line-for-line** — including the exposure normalization
  `min(density/densityMass, cap)`, deltaScale, dt handling, and the output clamps; the formula
  in this sentence is orientation, the anchored code is the spec (PLAN §5 rule — review #4
  caught this brief's earlier paraphrase dropping the normalization and caps). ⚠️ The ledger is
  **intentionally open** — legacy's field loss does not equal the sum of agent gains, and
  closing it would change the organism. Do not "fix" that. The prototype implements neither the exposure buffer nor field depletion
  (round-1 finding 14) — build both; the depletion test guards the field side, agent-growth
  parity guards the agent side. **Pass-order parity (review #3 finding 9):** legacy runs
  crowd → agents → **diffuse → deposit-exposure → delta** (main.js:18098) — deposits are laid
  onto the *post-diffusion* field and spread only on the next step. Keep that order exactly;
  PLAN §2's frame lists it.
- **Oat semantics (triage finding 16):** oats live in their **own field, separate from the
  dynamic food field**; overlapping oats combine by **max** (main.js:2323); agents sense
  `dynamicField + rationedOat` with density-based rationing (main.js:3156; `useOatRationing`
  defaults on, main.js:363). The prototype sums oat Gaussians into the persistent canonical
  field — wrong, do not port.
- Division: `reserve > reproThreshold` ⇒ ≤2 children at ±reproAngle + jitter, `childReserve =
  0.25·parent`; **parent debited only per accepted child**. ⚠️ **No crowd gate on birth** — the
  prototype's `reproCrowdCap` is invented behavior with no legacy counterpart (triage finding 17;
  legacy anchor main.js:3279); crowd shapes steering and economy, never birth eligibility.
- **Density field lifecycle:** cleared and rebuilt every step (legacy clears — main.js:17657);
  the prototype's `max(current, prev·0.9)` persistence ghost-trails dead agents (finding 29).
  Any persistence becomes an explicit param, default off.
- Crowd/density field: legacy realizes `densityBlur` as a **write-side point-sprite splat** —
  size `max(1, densityBlur/WORLD_LINEAR_SCALE × SPLAT_FIELD_SCALE)` (main.js:773, ~4-texel radius
  at defaults), drawn additively with a falloff shaped in `densityFragment` (main.js:3550); food
  deposits go through the same material at a different point size (renderDepositDensity
  main.js:17690). v2 deliberately restructures this (PLAN §1.3): **deposits via atomicAdd,
  following legacy's own size law** — where legacy's computed sprite size is ≤ 1 px (densityBlur
  ≤ 4 at 1536, ≤ 6 at 1024) the deposit is single-texel-snapped exactly like legacy's snapped
  sprite; in the continuously-moving regime it is bilinear (4 weighted atomicAdds; review #5
  finding 4 — unconditional bilinear would fail low-slider phase parity) — **+ iterated
  near-isotropic 3×3 passes** (PLAN
  §1.3 — variances add, σ = σ₀√n; σ from the legacy disc's second moment, per-axis ≈1.45 at
  default; whole slider range by iteration; **no separable fallback**). **Amplitude is
  peak-semantics** (review #4): the legacy fragment writes
  `smoothstep(1,0,(d/r)²) · clamp(reserve, 0, maxMass) · massScale` (main.js:3595-3603) — peak
  fixed, mass ∝ r² — so the scatter scales by the kernel integral; a mass-normalized blur
  would shrink sensed crowd as radius grows. After blurring, **clamp to [0,1]** (saturating-
  RGBA8 parity, main.js:1781). **Sensing reads nearest/texelFetch** — legacy floors the UV and
  fetches (main.js:3063), bypassing its own linear filter; bilinear sensing would be
  anti-parity (review #4 corrected round 3 here). **Quantize to 1/255 steps post-blur** (full RGBA8 parity — the artist's parity mandate;
  `?crowdfloat=1` keeps a float variant, Delta Ledger row). **Food-deposit exposure is single-texel** — the
  deposit sprite clamps to 1 px (main.js:780), so texel-snapped IS legacy (round 3's bilinear-
  for-food was wrong). Read all anchors before implementing; document the realized kernel +
  σ₀/n mapping in the module header. In this milestone the passes run plain (flat torus); M4
  inserts a gutter re-fill after every pass and the adjoint-scatter rule near seams.
- **Profile-match test (required, strengthened):** compare the realized crowd kernel against the
  legacy sprite formula (radial smoothstep falloff, `densityFragment` main.js:3550) at default
  `densityBlur`, across a **sub-texel phase sweep** of agent positions, with **reserve-weighted
  amplitude**, and a **multi-agent superposition** case — a single centered agent can pass while
  all three are wrong (triage finding 25). Stated tolerance, plotted residual. Note: food
  deposits are ~point-sized in legacy (≈0.5 texel), so plain atomicAdd point deposits are
  *parity* for food — only crowd needs the blur.
- **Population controller (round-1 finding 15, round-2 finding 17):** legacy's law — theory
  comment at main.js:~19359, supply update at ~19455, optional secondary actuator (burn/repro
  thresholds) at ~19303: state `x = log(N/N_target)`, actuator `v = log(oatSupplyRate)`,
  `v_next = v + K·(r_desired − r_measured)` with `r_desired = −λx`, **bounded by
  populationOatSupplyMin/Max (the bounds are the anti-windup and the extinction floor)**, under
  forced rationing. That equation is orientation only — **port the controller function bodies
  line-for-line** (they also carry sample-period timing, a growth-rate EMA — main.js:19414 —
  a deadband, a commanded-growth clamp, and the stateful secondary actuator at ~19258; review
  #4 confirmed a simplified law passes a naive test while behaving differently). The prototype's
  reproThreshold controller is a placeholder to be **replaced**, not ported. Required test is on
  the **law through the ported implementation**: a step change in target produces the
  log-supply response including its EMA/deadband timing, not just the eventual outcome.

## Fixes over the prototype (all of these, none optional)

1. **Explicit `GPUBindGroupLayout`s** everywhere (auto-layout pruning already bit the prototype
   twice). Shared layouts across pipelines where bindings match.
2. **Indirect dispatch:** tiny kernel converts `countBuf` → dispatch args (`ceil(n/WG)`), agent
   pass uses `dispatchWorkgroupsIndirect`. Keep a debug path dispatching over capacity; test
   asserts both produce identical results.
3. **Determinism — defined precisely (round-1 finding 12, round-2 finding 9):** atomic append
   makes *slot order* scheduler-dependent, so "bit-identical buffers" is unachievable. The
   contract is **state-set determinism below capacity**:
   - `Agent` struct → 32 B: `{vec2f pos, f32 heading, f32 reserve, u32 id_lo, u32 id_hi,
     u32 flags}`. Ids are **64-bit** — a u32 mixing hash collides at planned populations
     (~40 expected pairs at desktop capacity), which would corrupt RNG-stream uniqueness and
     the survivor test.
   - Child ids = `hash64(parentId64, stepIndex, k)` — NEVER from slots or a shared atomic
     counter (both are scheduler-ordered). Seed ids come from the seeded CPU PRNG.
   - Counter-based RNG (PCG hash of `(id64, stepIndex, streamId)`) — never the slot index,
     never `Math.random()` in any sim path.
   - `hashState()` is **order-independent**: a commutative reduction (e.g. sum/xor) over
     per-agent hashes keyed by id, plus the field hash. Fixed-point deposit adds are integer
     atomics, hence order-exact already.
   - At capacity saturation, *which* children drop is admission-order-dependent — determinism
     is guaranteed **below capacity**; tests run below cap and the cap path is documented
     best-effort.
   - Timebase per PLAN §2: implement BOTH; **legacy wall-clock law is this track's default** (parity mandate), `?fixedtick=1` is the variant (and physarum-18's default); determinism tests pin elapsed under either; the M4/M5 A/B runs both.
3b. **Parents-never-dropped allocator — two-PHASE, not two-ended (round-2 finding 2):** the
   prototype appends children through the same counter as parents, so at the capacity boundary
   a child can take the last slot and a *surviving parent* is silently discarded. A two-ended
   (bottom/top counters) scheme still races on the crossing slot, so the fix is **two passes**:
   pass A advances every agent and appends **survivors only** (survivor count ≤ previous
   population ≤ capacity — parents structurally cannot lose); pass B dispatches over the
   *written survivors* (indirect), re-checks the reproduction condition, **re-derives each
   child deterministically** (child state is a pure function of the written parent + RNG keyed
   `(parentId64, step, k)` — no proposal buffer needed), **debits its own parent's slot** (a
   same-invocation rewrite — each parent slot is owned by exactly one pass-B invocation), and
   admits children with the overshoot-safe idiom: `old = atomicAdd(count,1); if (old ≥ cap)
   { atomicSub(count,1); skip; }` — the transient overshoot is invisible because a **finalize
   dispatch** (which also writes the next step's indirect args) runs after pass B; the final
   counter is exact (review #3 finding 5). The sound assertion (finding 6) is: *no two
   invocations write the same slot, and no child lands in `[0, survivorCount)`* — a parent slot
   legitimately gets its pass-A write plus its own pass-B debit. **Exposure/deposit scatter runs
   after pass B** over the final population (matching legacy's compact-then-deposit order).
   Test: at forced saturation, every survivor id from step N exists at step N+1; a debug-assert
   pass checks the ownership property; the finalized count never exceeds capacity.
4. **Deposit rounding:** round-to-nearest fixed point (kill the −2.2% truncation bias and the
   sub-1/4096 dropout — pick the FP scale consciously and document it).
5. **Params UBO cleanup:** real `densityMass` param; independent flags; one documented packing
   table shared by JS and WGSL through the `wgsl.js` const injection.
6. WGSL moves to `src/sim/*.wgsl` via the M0 loader; kernels labeled; error scopes in dev.
7. Keep from the prototype: workgroup sizes (64 / 8×8), r32float field+density ping-pong,
   fixed-point atomic scatter, separate passes as barriers, non-blocking readbacks, exported
   params struct shared with the 2D renderer (adopt `render2d.js` into `src/render/field2d.js`).

## dev.html growth

Flat mode: `?cap= ?seed= ?field=` params; the prototype's slider HUD (params live-mutable);
pause/step buttons; `window.__v2.sim` with `{step(), seed(n), count(), hashState()}` where
`hashState()` = the **order-independent** state hash from fix 3 (commutative per-agent reduction
keyed by id + field hash — NOT a byte-hash of the buffers, whose order is scheduler-dependent);
agent-dot overlay on the 2D field view.

## Tests (`tests/browser/sim.spec.js` + node where pure)

- **Determinism (below capacity):** same `?seed`, two fresh page loads, 500 steps → identical
  `hashState()`. Then: run 250 steps, take a snapshot, run 250 more; restore the snapshot into a
  fresh sim, run 250 → identical hash (save/load foundation). **A snapshot is buffers PLUS the
  metadata that determines future state** — stepIndex (child ids and RNG are keyed on it),
  controller state, params, oat list + hand-out cursor (review #3 finding 13) — **PLUS a
  compatibility header** {manifest root hash, field size, capacity, schema version}: a snapshot
  restored against a re-baked atlas silently reinterprets every UV (post-split charts moved!),
  so mismatch rejection is explicit and TESTED (cross-review finding 4); the
  continued-run equality above only passes if the snapshot is complete, which is why the test
  is shaped this way. M6's IndexedDB save/load inherits this contract.
- **Wraparound (the "torus" in flat-torus — triage finding 30):** the prototype clamps at edges.
  Assert true wrap: an agent crossing the field edge continues (position, heading, sensing all
  wrap); a diffusion blob straddling the edge evolves identically to an interior control blob;
  no growth bias accumulates along the border over 1k steps.
- **Indirect ≡ capacity dispatch** over 200 steps (hash compare).
- **Saturation survivor test:** at forced capacity, every surviving agent id from step N exists
  at step N+1, and the finalized count never exceeds capacity (the two-phase allocator's
  guarantees — fix 3b).
- **Population invariants:** seed 60k → count grows; saturates ≤ capacity; count never negative;
  controller holds a `?target=` within tolerance and never extincts.
- **NaN/Inf scan** kernel over field + agents after 1k steps → zero.
- **Economy sanity, both directions:** (a) deposit=0, decay<1 → total field mass decays
  geometrically (analytic ratio ± ε); (b) **depletion:** an agent cluster parked on a food patch
  drains it measurably faster than a decay-only control — this is the test that catches the
  prototype's missing exposure/uptake plumbing (triage finding 14).
- **Profile match** per the strengthened spec above (phase sweep, reserve weighting,
  superposition) — at the default radius **and both slider extremes** (round-2 finding 14).
- **Oat semantics (round-2 finding 18):** (a) two overlapping oats ⇒ sensed food = **max**, not
  sum; (b) clearing all oats ⇒ oat contribution vanishes next step (proves the oat field is
  separate and non-persistent); (c) rationing on/off changes sensed contribution as specced;
  (d) **64 oats** are honored (the prototype's cap of 8 at webgpu/sim.js:58 is wrong).
- **Perf (informational):** ms/step at 1536-equivalent settings appended to `perf-log.ndjson`.
- **CPU-oracle enforcement of the line-for-line rule (review #5 finding 11):** the delta-pass
  formula and the population controller are ALSO ported line-for-line into plain JS oracles
  (tools/tests side); tests drive GPU and oracle with identical random states and assert
  numerical agreement — this is what makes "line-for-line" falsifiable (a qualitative depletion
  test cannot catch a dropped cap or normalization). One test enables the secondary actuator.
  A half-texel-offset probe asserts nearest (not bilinear) density sensing.
- Node: PCG vectors (fixed inputs → fixed outputs, cross-checked against a JS reference
  implementation in the test itself); params packing table round-trip.

## Acceptance

`npm test` green; dev.html shows live growth (attach a screenshot to the milestone PR);
determinism + snapshot tests green **twice in a row** (flakiness here poisons everything
downstream); Claude review of the diff.

## Forbidden

- No seam/atlas code (M4). No `Math.random` anywhere under `src/sim/`. No `layout:'auto'`.
- Don't import from `/webgpu/*` — copy and adapt; the prototype stays frozen as reference.
- Don't "tune" the organism: constants come from `src/shared/params.js` (extracted directly from
  main.js:325–546 in M0), never invented.
