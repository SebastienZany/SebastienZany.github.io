# Cross-review #2 (physarum-18 Fable instance, 2026-08-15) — triage

> Post-loop cross-review from the parallel track, which had adopted this track's audit
> discipline, verified numbers, and ~a dozen design elements (and credited the tunneling-parity
> insight with fixing a real flaw in their sensing gate). Their five findings here: **all five
> accepted.** The first is the round's headline — it caught a regression *introduced by my own
> round-4/5 fixes* that every Codex round missed, which is the argument for cross-track review
> in one sentence.

| # | Sev | Claim | Fix |
|---|---|---|---|
| 1 | high | Hop-step oat weights (1/0.5/0) are spatially discontinuous — a 2× food edge exactly at chart boundaries, the artifact class this rewrite kills; the hairpin residual is solvable with existing machinery | **Geodesic attenuation over a block graph** (~32²-texel blocks, edges from the baked adjacency, per-oat placement-time Dijkstra, continuous interpolation between block centers) replaces hop weights in PLAN §1.4; hairpins are fenced by actual surface distance (the fixture stays as regression proof). Their pre-paid traps adopted verbatim: anchor-point-seeded (not block-seeded) Dijkstra; attenuation-not-admission; the near-field UV shortcut fixture. New M2 deliverable 5b (block graph + continuity suite). |
| 2 | high | Mass accounting has no leak detector — drift bounds but no exact ledger, no independent flux expectation, no fault injection on real tables (my own ?gutter=0 sensitivity principle, unapplied to mass) | New M2 deliverable 5c: exact per-step ledger `{T_prev, T_diff, T_post, deposits, acceptedDepletion, upperClampLoss, seamFlux, residual}`; oracle-expected flux on fixtures; **per-seam-band signed flux bounds** on the real bake (global sums let opposite-signed errors cancel); **corrupted-donor / wrong-tap injections that must fail**, fixture AND real tiers. M4 exposes the ledger via the dev API and re-runs the injection tier on shipped tables. |
| 3 | med | Legacy parity silently ships a monitor-refresh-dependent organism, and the determinism-tested path is never the shipped path | Reframed as the **artist's decision** in PLAN §2, with a recommended default flipped to **fixed 60 Hz-equivalent tick** (tested == shipped; the tuned look becomes universal) and legacy's wall-clock law behind a parity flag for the M4/M5 A/B; controller samples at step boundaries under fixed tick. M3 implements both. This is the largest deliberate behavioral fork in the plan and it now belongs to the artist, not a default. |
| 4 | med | Snapshots aren't bound to a bake — restore against a re-baked atlas silently reinterprets every UV | Snapshot contract gains a **compatibility header** {manifest root hash, field size, capacity, schema version} with explicit tested rejection (M3; M6 inherits). |
| 5 | low | Legacy is nondeterministic — a single scripted growth trajectory is noise | M4's envelope gate specifies **N-run bands** (≥5 legacy runs, banded per metric). |

With this triage the plan has now survived: two independent recons, five Codex ultra rounds,
two Fable cross-reviews, and three independent audits. Same close as review #5: remaining risk
lives in implementation; the loop stays closed and adversarial effort moves to code at the
milestone gates.
