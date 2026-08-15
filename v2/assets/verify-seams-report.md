# M2 seam invariant report

CPU output of `npm run verify:seams`. Status: **not green**.
The exact-bilinear ¼-texel bar is applied only to that class. Moment/degraded records retain
their own measured bands, as required by the brief.

## Fixture matrix

| Fixture | Size | Charts | Gutters | Signed degraded | Transpose rel. error | Seam walks | Conservative failures |
|---|---:|---:|---:|---:|---:|---:|---:|
| seam-quad | 1536 | 3 | 13552 | 13 | 4.4847e-14 | 339 | 1 |
| folded-quad-45 | 1536 | 3 | 10760 | 16 | 9.2152e-15 | 359 | 0 |
| folded-quad-80 | 1536 | 3 | 10760 | 17 | 5.1027e-15 | 367 | 2 |
| cylinder | 1536 | 4 | 21008 | 34 | 9.0967e-14 | 293 | 0 |
| two-chart-sphere | 1536 | 2 | 11936 | 0 | 1.1462e-14 | 385 | 0 |
| three-chart-corner | 1536 | 4 | 12168 | 57 | 3.1462e-15 | 768 | 7 |
| thin-sheet | 1536 | 4 | 21664 | 24 | 5.2050e-14 | 369 | 2 |
| seam-quad | 1024 | 3 | 6804 | 15 | 6.0948e-15 | 303 | 1 |
| folded-quad-45 | 1024 | 3 | 5412 | 3 | 4.8210e-15 | 355 | 1 |
| folded-quad-80 | 1024 | 3 | 5412 | 6 | 5.1110e-15 | 318 | 0 |
| cylinder | 1024 | 4 | 10560 | 10 | 3.2340e-15 | 240 | 0 |
| two-chart-sphere | 1024 | 2 | 6000 | 0 | 6.1256e-16 | 334 | 0 |
| three-chart-corner | 1024 | 4 | 6102 | 41 | 2.2203e-14 | 691 | 3 |
| thin-sheet | 1024 | 4 | 10884 | 10 | 3.9226e-15 | 316 | 1 |

## Real atlas 1536

| Invariant | Measurement |
|---|---:|
| Coverage samples / wrong chart | 100,000 / 0 |
| Authoritative texels missing/wrong triangle | 0 / 0 |
| Clearance measured / required | 9 / 9 |
| Gutter records / signed degraded | 879,753 / 7,914 |
| Exact/moment/degraded moment max | 0.000142 / 0.000121 / 14.093406 texels |
| Weight-sum max / absolute-weight max | 1.1921e-7 / 2.000000 |
| Transpose identity relative error | 1.5372e-14 |
| Smooth value max exact/moment/degraded | 4.5496e-2 / 4.1811e-2 / 6.8217e-2 |
| Sharp value max exact/moment/degraded | 9.7206e-2 / 1.5567e-1 / 1.4670e-1 |
| Smooth/sharp no-fill negative-control max | 7.9588e-1 / 1.0000e+0 |
| Affine max by distance | 1: 2183.6807; 2: 4661.1032; 3: 7609.4938; 4: 10149.8268 texels |
| Legacy max by distance | 1: 2183.6809; 2: 4661.1036; 3: 7609.4944; 4: 10149.8276 texels |
| Random transport samples / seam resolves / failures | 100,000 / 10,039 / 433 |
| Cross-backs >¼ / worst | 7,971 / 2012.51168 texels |
| Frame cap overflow / maximum candidates | 158,858 / 20 |
| Texels with >1 nearby seam curve (proxy, not multi-hop incidence) | 545,170 |
| Block graph nodes / directed edges | 5,570 / 29,284 |

Every conservative-failure texel from this run is listed in `atlas-1536.transport-failures.csv.gz`.

## Real atlas 1024

| Invariant | Measurement |
|---|---:|
| Coverage samples / wrong chart | 100,000 / 0 |
| Authoritative texels missing/wrong triangle | 0 / 0 |
| Clearance measured / required | 7 / 7 |
| Gutter records / signed degraded | 429,181 / 8,865 |
| Exact/moment/degraded moment max | 0.000093 / 0.000081 / 3.573327 texels |
| Weight-sum max / absolute-weight max | 1.1921e-7 / 1.923298 |
| Transpose identity relative error | 3.5239e-14 |
| Smooth value max exact/moment/degraded | 5.6064e-2 / 2.2386e-2 / 3.2847e-2 |
| Sharp value max exact/moment/degraded | 2.2598e-1 / 2.0837e-1 / 4.3120e-1 |
| Smooth/sharp no-fill negative-control max | 7.9637e-1 / 1.0000e+0 |
| Affine max by distance | 1: 3444.8682; 2: 7851.8656; 3: 11710.2494 texels |
| Legacy max by distance | 1: 3444.8685; 2: 7851.8662; 3: 11710.2503 texels |
| Random transport samples / seam resolves / failures | 100,000 / 9,811 / 384 |
| Cross-backs >¼ / worst | 8,837 / 1310.91364 texels |
| Frame cap overflow / maximum candidates | 67,549 / 21 |
| Texels with >1 nearby seam curve (proxy, not multi-hop incidence) | 228,465 |
| Block graph nodes / directed edges | 3,951 / 21,274 |

Every conservative-failure texel from this run is listed in `atlas-1024.transport-failures.csv.gz`.


## Failed or blocking gates

- real@1536: 7,914 signed donor records have no u16 encoding
- real@1024: 8,865 signed donor records have no u16 encoding

## Invariant groups not yet established

- Formal C1 value/gradient comparison against a per-side seamless reconstruction at the direct-tap clamp, including the pointwise sharp-front gate.
- Transport sampling conditioned on true geometric seam crossings, including world-heading continuity and resolver cross-back (the current random endpoint probe is diagnostic only).
- Per-edge-local cone-corner cross-bisector jump and gradient-error-radius distribution on every real ≥3-chart corner.
- 100-step real-atlas per-seam-band signed diffusion flux bounds and real-table wrong-diffusion-tap sensitivity.
- Impulse-spread second-moment comparison against seamless controls, banded by chart scale.
- Block-graph distance error against exact mesh geodesics and interpolated block-boundary continuity.
- Exact multi-hop sensing incidence along sensor-disc chords (nearby-frame multiplicity is reported only as a proxy).
- Deployed-data quantized transpose/conservation proof, blocked by the missing signed donor encoding.

The missing groups are reported as missing—not skipped or inferred from adjacent tests. Browser/GPU
work is outside this CPU milestone and is not attempted by this command.
