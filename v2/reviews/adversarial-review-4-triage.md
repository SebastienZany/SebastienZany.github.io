# Adversarial review #4 (Codex, 2026-08-15) — triage and dispositions

> Round 4 was the first explicit convergence check; verdict **NOT CONVERGED**, 12 findings —
> honest and correct. Character of the round: 3 cross-file consistency debts from my own editing,
> 4 catches of briefs *paraphrasing* legacy formulas (dropping caps/normalizations/state), 3
> genuine design refinements, 2 corrections of round-3 dispositions **that I verified and
> conceded** (legacy sensing is nearest `texelFetch`, main.js:3063 — round 3's "manual bilinear"
> was anti-parity; the deposit sprite clamps to 1 px, main.js:780 — round 3's bilinear-for-food
> was anti-parity). All 12 accepted (2 partial). The systemic fix this round: PLAN §5 now
> carries the **"anchored code is the spec; brief prose is orientation — port line-for-line"**
> rule, which retires the paraphrase-drift class of findings permanently.

| # | Sev | Claim | Fix |
|---|---|---|---|
| 1 | high | Bilinear scatter near seams writes into gutters → mass lost at next fill | **Adjoint scatter**: taps landing on gutter texels forward through the fill stencil's transpose (4 more atomicAdds onto the authoritative texels the gutter mirrors) — mass-conserving, phase-continuous, uses data M2 already bakes. PLAN §1.3 + M4 summary + M2 stencil section. |
| 2 | high | Gather stencil not constructive (no selection algorithm, constraints, or attainable gates in slivers) | Spec'd: common case = the exact 2×2 bilinear footprint (¼-texel gates apply); else ≤4 nearest authoritative centers, constrained least-squares weights (value + first moment, nonneg, sum-1, conditioning-bounded), inverse-distance fallback with a **degraded-stencil census** gated on measured error; record layout fixed (index list + 4×(u32,u16), destination implicit). |
| 3 | high | Iterated 3×3 still not metric-covariant across scale/shear seams; "no caveat" claim false | ◐ Conceded on the claim, not the design: iterated-isotropic fixes the *rotation* defect; scale/shear covariance is chart-metric behavior every per-texel kernel has (legacy's diffusion and smoothing included) — now stated as **inherited, documented, measured** (impulse-spread test), instead of claimed away. |
| 4 | high | Legacy sensing is nearest texelFetch (filter bypassed); amplitude is peak-fixed (mass ∝ r²), not normalized | Verified both (main.js:3063; 3595-3603). Sensing spec → **nearest parity** (round-3 bilinear reverted); scatter amplitude → **peak-semantics** via kernel-integral scaling, with the radius-amplitude relation added to the profile test. |
| 5 | high | "Verbatim" exposure economy dropped legacy's normalization/cap/scale/clamps; deposit sprite is 1 px | Verified (min(density/densityMass, cap) etc. at 3674-3710; 1 px clamp at 780). Delta pass → **line-for-line port** per the new §5 rule; food deposits → **single-texel** (bilinear-for-food reverted). |
| 6 | high | Deleting the wide-radius fallback creates an ungated legal-settings perf cliff (≈160 pass-pairs/frame worst case; 1.4 GiB staging copies) | Two-part fix: **fused fill** — on ping-ponged passes the gutter output is a stencil-gather over the input, so no separate dispatch or staging copy exists for blur iterations (the standalone in-place fill remains only for in-place writes); and the **worst-case legal row** (max radius × max steps × max smoothing, device's real fill path) becomes a mandatory M0 rehearsal row recorded before M2 freezes GUTTER. |
| 7 | high | 1024 density lever leaves texel kernels unscaled (surface meaning drifts 1/s, 1/s² for diffusion); repel wrongly listed | Unit table corrected: crowd/deposit kernels are **surface-space** (legacy's own SPLAT_FIELD_SCALE precedent, main.js:762) and scale by s; diffusion stays per-texel (legacy never scaled it across sizes — documented inherited behavior); repel removed from the list (it keeps legacy UV+chart semantics). |
| 8 | high | Normal-damping gate starves legitimate feeding across >80° folds; same-chart hairpins pass both gates | Primary gate → **seam-hop connectivity** (baked chart-adjacency graph; an adjacent chart feeds fully regardless of fold angle); normals demoted to optional secondary. Honest residual documented: the same-chart hairpin (hop 0, surface-far) still couples — the one case legacy's UV metric handled better — measured on a hairpin fixture, artist-judged. Repel reverts to legacy UV+chart verbatim. |
| 9 | high | M1 still emits/locks 570 endpoint-grouped components while M2 needs 630 chart-local | Consistency debt fixed: M1 groups with `chartOf` (expect **630**; 570 kept as a diagnostic), records branch degree + loop flags per component. |
| 10 | med | M2 tests still pin the default 2.33-texel taps and the rejected ≤2-texel corner disc | Reconstruction test taps at the per-size clamp (GUTTER−1: 3 @1536, 2 @mobile-G3); corner gate switched to measured gradient-radius + cross-bisector jump distributions. |
| 11 | med | Controller spec permits a simplified non-legacy law (EMA, deadband, sample timing, secondary state omitted) | Line-for-line rule applied (anchors 19258/19414/19455); the law test runs **through the ported implementation** including its timing state. |
| 12 | med | Budget still internally wrong (history charged as f16; PLAN prose desynced; maxFood omitted; fractions are pre-split lower bounds) | Script fixed (r32float history row, sample views, max-food row, pre-split caveat comment); PLAN prose now **copied from script output, never hand-edited** (232–295 MB @1536, 125–153 @1024, + canvas + transients). |

**Convergence read:** the architecture has not moved since round 1; rounds now split between
(a) my cross-file edit debt — real, embarrassing, fixable, and exactly what a review loop is
for — and (b) micro-parity that the line-for-line rule now handles at the correct altitude
instead of via ever-longer prose. Round 5 runs as the second convergence check.
