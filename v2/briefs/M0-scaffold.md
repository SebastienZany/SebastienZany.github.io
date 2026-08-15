# M0 — Scaffold, test harness, capability probe

**Objective:** `v2/` exists as a self-contained workspace; a WebGPU device + compute dispatch is
proven both in-browser and under `npm test` on this machine; a capability probe page exists that
can be opened on any device (including iPhone once deployed); vendored CPU libraries are pinned.

**Read first:** `v2/PLAN.md` §0–3; `v2/reference/webgpu-prototype-assessment.md` (for the error-
scope / `__dev` patterns worth keeping).

## Deliverables

1. **Layout + hygiene**
   - Directories per PLAN §2 (empty `src/*` subdirs may hold a `README.md` one-liner).
   - `v2/.gitignore`: `node_modules/`, `test-results/`, `playwright-report/`, `.cache/`.
   - `v2/package.json`: `"private": true`, devDependency `@playwright/test` only. Scripts:
     `test` (node suite then GPU suite), `test:node` → `node --test tests/node/`,
     `test:gpu` → `playwright test`, `serve` → a tiny zero-dep static server
     (`node tools/serve.mjs`, ~40 lines, correct MIME for `.wgsl`/`.bin`, serves the **repo root**
     so `/v2/...` paths mirror production).
2. **`v2/src/gpu/` foundation** (small, tested where pure):
   - `device.js`: adapter/device acquisition with required-feature negotiation and a graceful
     failure path (returns a structured report, used by probe and by the future shell);
     `device.lost` handler hook. `pushErrorScope`/`popErrorScope` dev wrapper.
   - `wgsl.js`: fetch + preprocess WGSL (`//#include "file"` + `${CONST}` injection from a plain
     object). Pure string logic → node-testable.
   - `registry.js`: create/track buffers+textures with labels and byte accounting
     (`registry.totalBytes()`, `registry.dump()`); everything GPU-visible goes through it.
3. **`v2/probe.html`** — zero-dep page that reports, in DOM text (with a "copy JSON" button):
   adapter info (vendor/architecture/description), all `adapter.limits`, `adapter.features`,
   `navigator.gpu.getPreferredCanvasFormat()`, `devicePixelRatio`, screen size,
   `navigator.deviceMemory|hardwareConcurrency`, UA. Then live checks, each PASS/FAIL:
   - device acquisition; `shader-f16`; `float32-filterable`; `texture-formats-tier1` (gates
     r16float STORAGE — the display chain's format helper branches on this, never assumes it);
     **the `readonly_and_readwrite_storage_textures` WGSL language extension** (check
     `wgslLanguageFeatures` AND compile a trivial `read_write` r32float pipeline — the gutter
     fill's fast path depends on it, and it is an extension, not core);
   - per-format usage matrix actually attempted, not inferred: `r32float` STORAGE,
     `r16float` RENDER_ATTACHMENT + filterable sampling, `rgba16float` STORAGE;
   - a compute smoke: 64k-element `atomicAdd` reduction vs the analytic sum;
   - a render smoke: clear + tiny draw + readback of one pixel;
   - **workload rehearsal** (the part that makes the iPhone run meaningful): allocate the full v2
     resource set at a selectable target size (1024 default on phones, 1536 on desktop) — sizes
     and formats from PLAN §2, contents synthetic (random gutter tables / noise fields; the real
     atlas doesn't exist yet and isn't needed to rehearse allocation and bandwidth) — and run a
     60 s loop of fill + iterated-blur + scatter dispatches — running the gutter fill on
     **whichever path the device will actually use** (read_write fast path where the extension
     exists, the staging-copy fallback where it doesn't — and on capable devices, both, so the
     fallback's cost is known everywhere) — reporting sustained ms/frame at start vs end
     (thermal proxy) and peak allocation success/failure. Two validity rules (review #3 finding
     20): synthetic donor tables must be **structure-valid** (donor reads only from designated
     "authoritative" regions, matching the real table's race-freedom — random donors would
     benchmark a read/write race the real workload never has), and gutter-record volume comes
     from the measured fractions in `tools/audit/memory-budget.mjs` (30%@1536 / 47%@1024), not
     a guess. **Gating:** a 5 s variant of this loop runs inside `npm test` with an explicit
     Playwright timeout override (the default 30 s would kill the 60 s run); the full 60 s run
     is the manual on-device protocol, results recorded. The matrix **must include the
     worst-case legal row** — max crowd radius × max `simulationSteps` (≈20 blur/fill pairs × 8
     steps) plus max display smoothing, on the device's actual fill path — recorded BEFORE M2
     freezes GUTTER (review #4: extreme-slider cost is a design input; "performance is
     informational" does not apply to this row). A phone passing a hello-triangle proves
     nothing; this rehearses the real footprint.
   Never throws to console-only: every failure renders on the page.
4. **`v2/dev.html`** — minimal for now: init device via `src/gpu/`, clear canvas to
   `rgb(0.004, 0.006, 0.005)` (legacy scene clear), FPS meter, `window.__v2 = {device, registry}`,
   `uncapturederror` listener printing into the page. M3 grows this into the sim harness.
5. **`v2/vendor/`** — committed copies, exact versions, with a `VENDOR.md` recording source URLs:
   `three@0.170.0/build/three.module.js`, `three@0.170.0/examples/jsm/controls/OrbitControls.js`
   (import rewritten to `../three.module.js`), `three-mesh-bvh@0.8.3` ESM build (its three imports
   rewritten relatively). A node test imports each and constructs a `PerspectiveCamera`, an
   `OrbitControls` on a fake element (or skips DOM-touching paths), and a `MeshBVH` over a
   two-triangle geometry → raycast hits. (CPU-only use; nothing may instantiate a WebGL context.)
6. **Playwright config** (`v2/playwright.config.js`): `channel: 'chrome'` (system Chrome 151),
   `webServer` = the `serve` script. Start headless (`headless: true`); if WebGPU is unavailable
   headless, fall back to headed and **record the working configuration + flags in
   `v2/reference/probe-results.md`**. The GPU test fixture must **assert the adapter is
   hardware via `adapter.info.isFallbackAdapter === false`** (the API flag is the primary
   signal — vendor/description strings may be empty or privacy-reduced, so they are logged as
   secondary diagnostics only) and record adapter identity in every test report — a suite that
   silently passes on SwiftShader validates nothing about the shipped path. Tests in
   `tests/browser/`:
   - `probe.spec.js`: open probe.html, assert device PASS, compute-sum PASS, render PASS; save the
     copied JSON into `v2/reference/probe-results.md` under a "Mac Chrome <version>" heading.
   - `dev.spec.js`: open dev.html, assert zero uncaptured errors and the clear-color pixel.
7. **Node tests** (`tests/node/`): wgsl preprocessor cases (include, const injection, missing-
   include error); registry byte math; vendor imports (above).
7b. **Readability standard, day one:** `src/CONVENTIONS.md` (the PLAN §2 written-to-be-read
   rules as a checklist reviewers use) + `src/shared/GLOSSARY.md` (the project vocabulary —
   gutter, donor stencil, authoritative, exposure, walk, hop, chart, slit… — code names must
   match it). Every later brief's acceptance implicitly includes conformance; M0's own code is
   the first example of the standard.
8. **Shared contracts (`src/shared/`)** — tiny, but they unlock the parallel streams in PLAN §4.1,
   so they land here, day 1:
   - `clock.js`: `{now(), timeScale}` wrapper over `performance.now` — every timeline/scheduler
     in the game must consume this, never `performance.now` directly.
   - `params.js`: the full parameter table (names, defaults, ranges, steps, preset tables) — the
     single object UI binds to and the sim reads from. **Extraction sources (all three —
     round-2 finding 22):** the base params object + both preset tables in `main.js:325–546`
     *plus the constants those defaults reference outside that window* (chase each reference);
     **UI min/max/step from the `index.html` slider attributes** (ranges live there, not in
     main.js); completeness cross-checked against the slider→param binding table at
     `main.js:18212–18253` (every bound param must appear). Record every anchor extracted from.
     Include per-param unit annotation (surface/UV/texel-space, PLAN §2 rule) and the
     **max-kernel-footprint table** (largest single-pass texel footprint each kernel may use —
     bump taps, blur pass radius, bilinear) — M2 derives GUTTER from it, so it is part of the
     frozen contract.
   - `field-provider.js`: the interface the renderer consumes (`{texture, view, size, frame()}`)
     with a **synthetic implementation** (procedural noise + painted patterns) so look work (F2)
     never waits on the sim.
   - Node tests: params table round-trips; defaults match the checklist's stated values.
9. **Fixture generator (`tools/fixtures.mjs`)** — pulled forward from M2: emit the synthetic test
   meshes (`seam-quad` with controlled non-isometric stretch, `cylinder`, `two-chart-sphere`) as
   packed-asset-shaped data (hand-built until M1's packer exists — a versioned stub format is
   fine). Both C (invariant suite) and F2 (material look) consume these on day 1.

**Sequencing note for parallel kickoff:** deliverables 1+8+9 plus the node runner are `P0` —
enough for the mesh stream (M1) and the DOM/audio lanes to start. The GPU half (2, 3, 4, 6) is
`P0g`, needed only by the sim and look streams; it may trail P0 by a session without blocking
anything on the critical path.

## Acceptance

```bash
cd v2 && npm install && npm test
```
green on this Mac; `reference/probe-results.md` contains the Mac Chrome results and the harness
notes. **On-device probing is an acceptance item, not a suggestion**: get the branch deployed
(v2/ is additive — merging to main is safe at any time), then have the user run Safari locally on
`probe.html` and iPhone Safari at `https://bestiaryofvanishings.com/v2/probe.html` including the
workload rehearsal at 1024, and record all results. The mobile memory/thermal picture gates M2's
asset decisions; do not let it trail into M4.

## Forbidden

- No bundler, no framework, no TypeScript, no deps beyond `@playwright/test`.
- No modifications outside `v2/`.
- Don't paper over a failing probe check — report it; the plan's format choices depend on honest
  probe data.
