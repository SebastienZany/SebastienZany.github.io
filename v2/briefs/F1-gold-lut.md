# F1 — Gold-wafer LUT bake tool (lane brief; needs only P0)

**Objective:** move legacy's runtime gold-LUT construction to bake time: a Node tool that reads
`material data/thicker_au_rgb_thickness_angle_tensor.json` and emits the fast lookup binary the
M5 renderer will upload directly — plus a CPU reference of the exact-path sampler for tests.
Every line new; written to be read; constants as data with anchors.

**Read first:** PLAN §0 mandates + §2 conventions; `reference/legacy-gpu-inventory.md` §4
(gold material); legacy anchors: tensor validation main.js:4959 (shape [10,600,3] u8, angles
[0,10,…,80,85]°, thickness 10→610 nm), exact sampler `goldWaferFilmColor` main.js:4220
(Catmull-Rom in thickness × 4-tap Fritsch–Carlson Hermite in cosθ over the 10 non-uniform angle
rows), fast bake `buildGoldWaferFastLookupTexture` main.js:5073 (pre-evaluate the angle Hermite
into **600×256 rows uniform in cosθ**, RGBA8; one bilinear fetch at runtime),
`GOLD_BODY_FAST_LOOKUP_ANGLE_ROWS = 256` main.js:191.

## Deliverables
1. `tools/goldlut.mjs` — strict tensor validation (reject on any shape/angle mismatch, exactly
   like the anchor); the CPU exact sampler (Hermite math ported semantics-line-for-line, fresh
   expression); the fast-bake (600×256×RGBA8 + a small header: magic `GLUT`, version, dims,
   cosθ mapping, content hash), gzipped per asset conventions; `npm run bake:goldlut` →
   `assets/` (content-addressed name + manifest-ready hash printed).
2. `src/render/gold-lut.js` — browser/Node loader returning dims + typed array, CRC-checked.

## Tests (node)
- Tensor validation rejects: wrong angle list, wrong dims, non-u8 range.
- Exact-sampler vectors: ≥6 hand-computed samples in the test (show the arithmetic in comments)
  covering interior, thickness clamp ends, and the non-uniform angle segment boundaries.
- Fast-vs-exact agreement: max |fast − exact| over a dense (thickness × cosθ) grid ≤ the
  quantization bound you derive (state it); worst cell reported.
- Determinism: two bakes byte-identical; loader round-trip.

## Forbidden
No GPU/WGSL. No new deps. Don't touch skin.html's inlined copy of the tensor (legacy artifact).
