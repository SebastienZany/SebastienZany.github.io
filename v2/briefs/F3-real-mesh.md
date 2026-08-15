# F3 — Real cuttlefish mesh under the F2 materials (lane brief; synthetic field, original UVs)

**Objective:** the F2 material stack rendering the real MESH1 cuttlefish (original `uv0`,
synthetic field) with the legacy camera feel — the first real-mesh image of v2. Every line new.

⚠️ Scope guard: original UVs + synthetic field ⇒ **seams will be visible and that is CORRECT
here** — F4 owns seam-correct display on the repacked atlas. Draw no seam conclusions; add a
one-line banner to the page saying exactly this (honesty in the artifact).

**Read first:** PLAN §2/§4.1 (F3 = B + F2); `src/atlas/asset.js` (MESH1 loader — use it, don't
reparse); F2's renderer/look page (extend, don't fork); legacy camera constants (parity
checklist §4: default pose (1.893468, 5.498426, −5.633916), fov 42.8571°, damping 0.07,
min/max distance 3.2/22.4, maxPolar π/2−0.04, Shift = ⅓ speed); mesh normalization is baked
into MESH1 already (longest extent 9.6).

## Deliverables
1. Renderer accepts MESH1 geometry (positions/normals/uv0 + u32 indices; ~501k tris — index
   buffer path, frustumCulled-off equivalent); `look.html?mesh=1` (or auto when the asset
   loads) renders the cuttlefish with slime+gold; synthetic field provider drives `u_food`-
   equivalent over uv0; orbit with the legacy constants above.
2. A `paintSurfaceField`-style synthetic mode (world-continuous f(worldPos) painted into the
   field via a small CPU bake over uv0 texel centers using MESH1 positions — reference
   legacy main.js:18063's intent) so the surface reads organically rather than as flat noise.
3. Browser spec (gate-run): loads MESH1, zero validation errors, renderTestFrame stats sane,
   screenshot saved to `v2/reference/f3-real-mesh.png`.

## Tests (node)
Geometry upload path unit-tested (stride/offsets against MESH1 section table); camera-constant
table matches the checklist values exactly.

## Forbidden
No atlas/repack data, no seam machinery, no sim coupling, no three.js rendering (camera math
only). No new deps.
