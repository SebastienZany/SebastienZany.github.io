# Independent mesh audit — verified ground truth for the seam design

> Run 2026-08-14/15 by Claude against `luyvwj-fwgyww.glb` directly
> (`v2/tools/audit/mesh-audit.mjs` + `mesh-audit2.mjs`; also the memory-budget calc referenced by
> PLAN §2). Purpose: the two adversarial reviews made load-bearing quantitative claims; these runs
> reproduce **every one of them exactly**, so the numbers below are treated as verified ground
> truth (M1/M2 re-derive them as regression tests — a deviation there means a tool bug).
> Method notes: charts = union–find over index-shared edges; seam pairing = boundary edges matched
> by 3D endpoints quantized at 1e-5; packing demand = per-chart texel-center rasterization,
> per-chart chebyshev dilation by GUTTER, summed (a lower bound on required atlas area).

| Quantity | Value |
|---|---|
| Vertices / triangles | 281,981 / 501,428 |
| Charts (index-connectivity) | 1,233 |
| Seam pairs (undirected → directional) | 30,034 → 60,068 |
| Same-chart slit pairs | 3,592 — **630 chart-local components** (the splitter's work units; M1-measured: 18 branching, 19 branch vertices, **0 loops**); 570 endpoint-grouped curves (diagnostic only — cross-chart merges fabricate apparent branches/loops), largest 87 edges |
| Fold angles (between paired tris) | >60°: 3,718 · >80°: 1,318 · >89°: 147 (histogram in script output) |
| Multi-chart vertices | 3-chart: 2,167 · 4-chart: 164 · 5-chart: 12 |
| Corner angle defects (|defect| > 0.05 rad) | positive: 181 · negative: 1,358 · ~flat: 804 |
| Boundary-side adjacent-triangle UV altitude @1536 | median **1.49 texels**; 59,215 / 60,068 sides < 4 texels |
| Raw chart occupancy (any size) | 52.4% of the atlas |
| Per-chart dilated demand @GUTTER=4 | **117.3%** of 768² · **99.2%** of 1024² · **82.4%** of 1536² |
| Sub-texel charts (zero texel centers) | 30 @768 · 14 @1024 · 12 @1536 |
| Largest single-chart demand @1536 | 31,708 texels |

Design consequences (all reflected in PLAN/briefs):
- 768 is unpackable with real gutters; **mobile baseline = 1024** and even that needs a lever
  (~10% linear density sacrifice or mobile GUTTER=3 + tiered taps). 1536 requires mask packing
  ≥ ~85% efficient; bbox packing is ruled out.
- Median altitude 1.49 texels ⇒ per-edge affines are invalid past the first gutter texel almost
  everywhere ⇒ **gutter donors must come from exact bake-time geodesic walks**, with affines
  retained only for the runtime agent resolver (legacy-parity approximation).
- 570 slit curves must be split per component (per-edge splitting would add ~6× the perimeter).
- 1,539 defect corners ⇒ corner continuity is C0-with-bounded-gradient near cone points; no
  method can be C1 through them.
