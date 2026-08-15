# Source conventions

Review every milestone against this checklist.

- [ ] Each module has one purpose and normally stays at or below 400 lines.
- [ ] Passes and resources use the names in PLAN §2 and `shared/GLOSSARY.md`.
- [ ] Unit-bearing names distinguish `uvPos`, `texelPos`, `worldPos`, and screen-space values.
- [ ] Every WGSL kernel begins with its inputs, outputs, formats, units, invariants, and PLAN or brief anchor.
- [ ] Comments explain reasons, invariants, legacy anchors, or derivations; they do not narrate syntax.
- [ ] Every non-obvious constant carries its legacy anchor or derivation.
- [ ] Explicit bind-group layouts are used; pipelines and bind groups are created once.
- [ ] Per-frame work allocates no GPU-visible resources other than a command encoder.
- [ ] Complexity is admitted only for a measured hot spot, with the measurement recorded beside it.
- [ ] Atlas textures never receive ordinary mipmaps.
- [ ] Timelines and schedulers consume `shared/clock.js`, never `performance.now()` directly.
- [ ] Any knowing legacy-semantic deviation appears in PLAN §1.5 before it lands in code.

