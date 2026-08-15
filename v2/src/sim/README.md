# Simulation

M3 implements the deterministic flat-torus substrate. `sim.js` owns the public API and delegates
resource creation, explicit layouts, bindings, pipelines, readback, snapshots, and pass encoding to
single-purpose modules. No file imports the legacy prototype.

The per-step pass order is the legacy order: oat refresh when dirty, crowd rebuild, survivor
advance, child admission/finalize, dynamic-field diffuse/decay, final-population exposure scatter,
then the exposure delta. Density is rebuilt from zero every step. Oats remain in their own max-
composited field.

## Crowd kernel realization

Legacy point size is `p = max(1, densityBlur / 4 × fieldSize / 1536)` texels and radius is `r=p/2`.
When `p<=1`, scatter snaps to one texel exactly as the one-pixel legacy sprite does. Otherwise,
bilinear fixed-point scatter preserves sub-texel phase and scales by the legacy disc integral
`πr²/2`, retaining peak rather than normalized-mass semantics.

The radial smoothstep disc has per-axis second moment `σ² = 0.15r²`. One full two-dimensional
binomial 3×3 pass has per-axis variance `0.5`, so the realized kernel uses
`n = ceil(0.3r²)` passes and blend `α = 0.3r²/n`. The composed variance is therefore exactly
`n × 0.5α = 0.15r²`; at the desktop default `r=3.75`, `σ≈1.452` and `n=5`. The final pass clamps to
`[0,1]` and rounds to 1/255 unless `?crowdfloat=1` selects the Delta Ledger variant.

The two fixed-point scales are derived in `constants.js`. Crowd uses 256: even 500,000
max-reserve agents co-located at the largest slider radius stay below u32 overflow, while its step
is slightly finer than legacy RGBA8 density. Point-like food exposure has no radius-squared mass
multiplier, so it keeps 4096 precision and remains below u32 overflow at the exposure cap.

## Determinism and snapshots

Agents are 32-byte records with persistent 64-bit ids. Counter RNG and child ids use id, step, and
stream only. Atomic append may reorder slots, so `hashState()` reduces keyed per-agent hashes with
commutative sum/xor and combines them with a field hash. This guarantees state-set determinism
below capacity; saturated child admission is explicitly best-effort.

Snapshots contain the live agent words, canonical field, step index, controller state, parameters,
oats, hand-out cursor, timebase state, and a compatibility header carrying schema version, manifest
root hash, field size, and capacity. Restore rejects any header mismatch before writing GPU state.
