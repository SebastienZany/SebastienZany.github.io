# Adversarial review #5 (Codex, 2026-08-15) — triage, dispositions, and the loop's close

> Second convergence check; verdict **NOT CONVERGED**, 12 findings, all accepted — but the
> reviewer's own META answer marks the boundary: *"continued planning-document review remains
> higher-value for **one focused correction pass**; I would switch to code review after the
> fused operator, packing feasibility, stencil/adjoint representation, scatter bounds, timebase,
> and oat law are resolved."* This triage IS that pass; each named item is now resolved. Per the
> loop's charter, planning-doc review closes here — subsequent adversarial effort belongs to
> code as milestones land (the per-milestone gates already include it).

| # | Sev | Claim | Fix |
|---|---|---|---|
| 1 | high | Fused blur/fill computed F(input), leaving gutters one iteration stale | Corrected to the **composed operator**: gutter output = Σ wᵢ·(3×3 over the *input* at tapᵢ) = stencil∘blur evaluated exactly in the same pass (36 gathers on gutter texels); M0 rehearses this composed pass. |
| 2 | high | Conservative rasterization pushes 1024 demand to ~107% @G4 (~94% @G3, ~93% @s0.9/G4) — both single levers dead | Mobile plan → **combined levers** (G3 + density-as-needed, target ≤ ~85% measured) with **1280 as the explicit fallback size**; all demand figures labeled pre-split lower bounds; the M2 gate decides on conservative post-split numbers. |
| 3 | high | Stencil not total (convex-hull exclusion; no tie objective; suite reapplies ¼-texel unconditionally; oracle text stale) | Weight solve: min-norm least squares; hull-exclusion/collinear → bounded weights (|w| ≤ 2, sum-1) with the degraded census; **suite bars split by class** (exact-bilinear vs census-measured) in the suite code; oracle wording fixed. |
| 4 | high | Legacy crowd sprites are 1-px-snapped at densityBlur ≤ 4 (1536) / ≤ 6 (1024) — unconditional bilinear scatter fails low-slider parity | Scatter follows **legacy's size law**: snapped single-texel where legacy snaps, bilinear in the continuous regime; phase test per regime. |
| 5 | high | i32 fixed-point wraps at ~23k co-located max-strength agents | Scale derived from the **analytic no-overflow bound** on u32 (S ≈ 2³²⁄(capacity·maxContribution) ≈ 300) — provably wrap-free at full co-location *and* finer than legacy's own 8-bit field (1/300 vs 1/255); full-capacity-on-one-texel test added. |
| 6 | high | Adjoint scatter had no g→record lookup; 24 B understated; u16 sums inexact; conservation untested on shipped data | Reverse index embedded in the ownership map (gutter texels store `recordIndex + 2¹⁶` in the u32 they already occupy — zero added memory); records = 28 B (budget updated); exact-sum quantization rule; **transpose-identity test on deployed tables**. |
| 7 | high | Timebase undefined (fixed-tick language vs legacy's capped wall-dt/substep law; un-dt'd diffusion) | Spec'd as **legacy parity**: rawDt = min(elapsed/16.667, 2.2), dt = rawDt/steps, diffusion/decay per-substep un-dt'd (that IS the law); tests pin elapsed; decouple stays an M6 flag, default off. |
| 8 | high | Oat law still invented (no UV→world radius conversion, no hop weights, no adjacency owner, missing hairpin fixture, repel contradiction) | Radius converts via the oat chart's baked texel-world scale; hop weights fixed (1 / 0.5 / 0 at hops ≤1 / 2 / >2, CT constants); adjacency graph is an M2 deliverable; hairpin fixture added; stale world-space-repel text swept (legacy UV+chart verbatim wins). |
| 9 | med | Deposit-radius s-scaling is a no-op that contradicts single-texel parity | Deposit removed from the s-scaling list (pinned 1 px by legacy's max(1,·) at every size/lever). |
| 10 | med | One equal-density seamless reference can't represent both sides of a metric-mismatched seam | C1 gate rewritten: **per-side references** at each side's own chart metric + explicit cross-seam continuity bands — inherited metric anisotropy no longer conflated with seam error. |
| 11 | med | Line-for-line rule unenforced (qualitative tests can't catch dropped caps/normalizations) | **CPU oracles**: delta pass + controller ported line-for-line to JS; GPU vs oracle numerical agreement on random states; secondary actuator enabled in one test; half-texel probe asserts nearest sensing. |
| 12 | med | Stale operative text (2.33 GUTTER prose, 2×GUTTER risk row, "~5×" memory claim, corner-sector gate wording, assessment's u32/one-pass prescriptions) | All swept; the assessment's allocator-parity sentence now states the capacity bug inline instead of relying on the banner. |

## Loop summary (5 rounds)

108 findings total: R1 35 → R2 25 → R3 24 → R4 12 → R5 12. Acceptance rate ≈ 96% (4 refutations,
of which 2 were later overturned against me and conceded). The architecture chosen in round 1 —
repacked atlas + filled gutters + agent resolver + world/connectivity kernels — survived all five
rounds unchanged; everything after round 1 corrected constructions, schedules, parity details,
and my own cross-file edit debt. Every quantitative claim that survived is either
independently-audit-verified (mesh numbers) or script-computed (memory). Remaining risk now
lives in implementation, exactly where the per-milestone gates (tests-as-contract, CPU oracles,
Claude review, artist eye) are designed to catch it.
