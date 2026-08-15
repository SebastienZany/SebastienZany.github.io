# F2 — Slime + gold material look on fixtures (lane brief; synthetic field)

**Objective:** the surface materials — slime thin-film and gold body — developed and visible on
fixture meshes with a synthetic field, so look iteration starts long before the sim touches the
atlas. Raw WebGPU render pass; camera from vendored three (CPU-only). Every line new.

⚠️ Scope guard (SEAM_NOTES' hardest lesson, PLAN §4.1): synthetic fields are for **materials and
lighting only** — draw NO seam conclusions here; F4 owns seam-correct display on the real atlas.

**Read first:** PLAN §0–2; `reference/legacy-gpu-inventory.md` §1d + §4 (render + gold);
anchors: `slimeVertex`/`slimeFragment` main.js:3979/4003 (bump = 4/8 height taps on the display
field; thin-film; GGX via `microfacetSpecular` main.js:4118), icosa light rig main.js:1611-1625
(32 lights: 12 verts + 20 face centres — port positions/intensities as a data table with the
renormalized 12-light variant), film params (parity checklist §2c Surface group), gold fast-LUT
sampling main.js:4948-4952 (one bilinear fetch; use F1's `gold-lut.*.bin.gz` via
`src/render/gold-lut.js`), gold body driven by running-max food main.js:2972 (implement the
max-history pass), layering main.js:5368-5414 (gold opaque under slime One/OneMinusSrcAlpha).

## Deliverables
1. `src/render/` — mesh render pass (fixture geometry: `two-chart-sphere` from tools/fixtures);
   depth24plus; slime.wgsl + gold.wgsl with contract comments; camera UBO from vendored three
   PerspectiveCamera + OrbitControls (legacy constants: fov 42.8571°, damping 0.07, limits per
   checklist §4); max-food history pass; the display-side chain stub = synthetic field provider
   (`src/shared/field-provider.js`) → r32float history → 16-bit sample view per §2 formats.
2. `v2/look.html` — the look-dev page: fixture + materials + orbit + the Surface param group
   live-bound from `shared/params.js` (sliders affect uniforms immediately); `window.__v2.look`
   with `{renderTestFrame()}` returning {nonBackgroundFrac, maxLum} (offscreen readback,
   prototype-assessment pattern).
3. Browser specs (gate-run by Claude): zero validation errors; renderTestFrame stats sane;
   NaN scan on the target; a screenshot artifact saved for the review queue.

## Tests (node)
Light-rig table matches anchors (verts + face centres, unit dirs, renormalization); param
binding table completeness vs checklist Surface group; WGSL sources pass the include/const
preprocessor and contain no unparenthesized bitwise/arithmetic mixes (static check).

## Forbidden
No atlas/seam data, no real cuttlefish mesh (F3), no sim coupling. No new deps. Legacy GLSL is
semantics reference only.
