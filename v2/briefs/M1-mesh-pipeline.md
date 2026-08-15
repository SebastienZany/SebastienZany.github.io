# M1 — Mesh pipeline: GLB → packed asset + chart ground truth

**Objective:** a deterministic Node tool that converts `luyvwj-fwgyww.glb` into v2's packed mesh
binary plus an analysis report, establishing verified ground truth about charts and seams that M2
builds on. No GPU code in this milestone.

**Read first:** PLAN §1–2; `reference/legacy-gpu-inventory.md` §4 (GLB handling, normalization);
`SEAM_NOTES.md` §1 (expected counts). Ground-truth numbers already verified by header inspection:
GLB is raw (no extensions, no Draco), attributes POSITION/NORMAL/TEXCOORD_0, **281,981 verts**,
indexed triangles (expect **501,428**), 1 embedded image/material — **unused by the game**
(material replaced at `main.js:15379`), so the packed asset drops it and UVs are ours to remap
in M2.

## Deliverables

1. **`tools/glb.mjs`** — hand-rolled GLB reader (this one known-simple file class, not a general
   loader): header + JSON chunk + BIN chunk, accessor/bufferView walk, returns typed arrays for
   POSITION (f32×3), NORMAL (f32×3), TEXCOORD_0 (f32×2), indices (u16/u32 → normalize to u32).
   Strict: assert componentTypes, counts, tight strides; throw with context on anything unexpected.
2. **`tools/mesh.mjs`** — pure functions:
   - `normalizeGeometry(pos)` — replicate legacy exactly (`main.js:15294` region): translate bbox
     center to origin, uniform-scale so the longest bbox extent equals `SURFACE_WORLD_SIZE = 9.6`
     (= 2.4 × `WORLD_LINEAR_SCALE` 4). Every downstream world-space constant (camera distances,
     audio rolloff, oat radii × 4) assumes this frame — read the legacy anchor before writing it.
   - `buildChartSegmentation(uv, indices)` — union–find over triangles sharing a UV-space edge
     (same two vertex indices AND same UV coordinates on both; UV-split edges are chart
     boundaries). Returns per-triangle chartId + per-chart stats (tri count, UV bbox, area).
   - `extractSeamEdges(...)` — UV-boundary edges paired by shared 3D vertex positions
     (position-epsilon pairing). Terminology is load-bearing: an **undirected pair** has two
     **directional sides**; verified ground truth (`../reviews/mesh-audit-results.md`):
     **30,034 pairs → 60,068 directional sides** (assert exactly). **Classify every pair**:
     cross-chart vs **same-chart slit** (verified: 3,592 slit pairs; group them into
     **CHART-LOCAL components — expect 630** (grouping by shared endpoints alone gives 570 but
     merges curves across charts — include `chartOf` in the union; review #4 finding 9);
     record per component its chart, edge count (largest 87), branch degree (19 components
     branch), and closed-loop flag (5 loops) — M2's splitter consumes exactly these units;
     do NOT assert "no self-pairs"). Also record per pair the **fold angle**
     (verified: >60° = 3,718, >80° = 1,318, >89° = 147) and per side the **adjacent-triangle UV
     altitude** (verified median 1.49 texels at 1536 — the number that forced M2's fill donors
     onto geodesic walks) — M2's constructions and tests are banded by both.
3. **`tools/pack.mjs` + `src/atlas/asset.js`** — packed binary format `MESH1` (little-endian):
   header (magic, version, counts, section table with offsets/lengths/CRC32 per section), sections:
   positions (normalized), normals, uv0 (original — reference only), indices u32, triChartId u32,
   chart table, seam-pair table (+ slit-component table). Loader parses in browser + Node from
   the same module, returns typed-array views, verifies CRCs. Note: this is the **input**
   geometry — M2's slit splitting emits its own reindexed geometry (duplicated cut vertices +
   per-baked-vertex uv1) in the atlas sections; runtime loads *that*, not MESH1's topology.
4. **`npm run bake:mesh`** → `assets/mesh-1.bin` + `assets/mesh-report.md` (counts, chart
   histogram by tri count and by UV area — including how many charts are sub-texel at 1536/1024 —
   seam-pair count, bbox/scale applied, tool + input hashes).

## Tests (`tests/node/`)

- Reader: exact vert count 281,981; triangle count exact (assert the measured value, expected
  501,428); UVs within [0,1] + report any epsilon-outside; no NaN anywhere.
- Normalization: post-transform bbox longest extent == 9.6 ± 1e-5, centered at origin.
- Segmentation: chart count asserted exactly once measured (expected ≈ 1,233 — if it differs
  meaningfully from SEAM_NOTES, **stop and record why in the report before locking the golden**);
  every triangle assigned exactly one chart; chart tri-counts sum to total.
- Seam pairs: assert the **verified** counts (30,034 undirected / 60,068 directional; 3,592 slit
  pairs; **630 chart-local components** — 570 endpoint-grouped is the diagnostic number, not the
  work-unit count) — these were independently audited, so a deviation means a tool bug, not a
  new expectation; each pair's two 3D edges coincide within epsilon; corner
  census asserted (2,167 three-chart / 164 four-chart / 12 five-chart; angle defects
  +181/−1,358/~804 flat); altitude median asserted (1.49 texels @1536 ± tolerance).
- Pack/loader round-trip: every section byte-identical after load; CRC tamper detected.
- Determinism: two tool runs → byte-identical `mesh-1.bin` (hash compare).
- Browser check (one Playwright spec, **only once P0g exists** — M1 itself depends only on P0's
  node side; don't block on the GPU harness): fetch + parse the asset, assert counts/hashes match
  the Node-side manifest. Until then the loader's Node-side round-trip test carries this.

## Acceptance

`npm run bake:mesh && npm test` green; `assets/mesh-report.md` committed; goldens locked with a
note for any deviation from SEAM_NOTES' expected counts (that file is fallible — *our tool's
measurements, once verified, become the new ground truth*).

## Forbidden

- No three.js in the tools (hand-rolled reader + math keeps the pipeline dependency-free and
  deterministic).
- No quantization yet (PLAN §7 open item).
- No repacking/rasterization — that's M2; keep this milestone's scope crisp.
