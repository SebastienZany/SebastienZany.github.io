# v2 — WebGPU rewrite of "A Bestiary of Vanishings"

Start here:

- **[PLAN.md](PLAN.md)** — architecture, milestone order, tests, working agreement. The source of truth.
- **[briefs/](briefs/)** — self-contained work orders per milestone (M0–M3 exist; later ones are
  cut just-in-time at each milestone boundary).
- **[reference/](reference/)** — distilled legacy knowledge (GPU/sim inventory, feature parity
  checklist, WebGPU-prototype assessment) so nobody has to re-read the 20k-line `main.js`.
- **[reviews/](reviews/)** — adversarial-review triages; each records finding-by-finding verdicts
  and the amendments they drove. Read before re-litigating a design decision.
- `../SEAM_NOTES.md` — the seam-bug knowledge dump the plan's core design answers.

Rules of engagement are in PLAN §5. If reality contradicts a brief: stop, write `BLOCKERS.md`,
don't improvise around the spec.
