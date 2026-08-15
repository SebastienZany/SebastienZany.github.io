# U2 — Story reveal engine + boot/diagnostics shell (DOM lane; fake clock, no GPU)

**Objective:** the narrative text machinery and the boot diagnostics layer, written fresh.
Two independent modules sharing only the clock.

**Read first:** parity checklist §1f (story lifecycle — the contract) + §1a (boot/diag) + §2c
Story-Labels group; anchors: stories load/hand-out main.js:7062-7122, reveal choreography
5734-5755/6812-6968 (glass 2600ms, 190ms/grapheme masked lines, next line at 2/3, exits),
Canvas2D wrapping + Intl.Segmenter 6732-6801, box layout/opacity rules 5723-5731/7822-7898
(tail length, depth z, facing smoothstep, occlusion REFRESHED VIA PROVIDER — BVH arrives with
the mesh in M6/M7, here a stub), CSS-var bindings 558-577; diag: index.html:12-217 (ring log
400/persist 150 @250ms + pagehide, load counter, watchdog 20s, version cross-check, ?safe/
?diag, triple-tap, copy button, safe-area).

## Deliverables
1. `src/game/stories.js` — fetch/fallback, sequential cursor, per-oat assignment rules
   (suppression, initial-oat exclusion); reveal state machine as a pure clock-driven model
   emitting DOM ops; typography module (measure with real computed font via Canvas2D,
   grapheme segmentation, masked line reveals) — all timings from a constants table with
   anchors; Story-Labels params drive CSS custom properties.
2. `src/boot/diag.js` + the inline-capable snippet pattern: ring log, localStorage persistence,
   session load counter, watchdog, BUILD_VERSION cross-check hook, ?safe/?diag modes, overlay
   DOM (mono, safe-area, copy w/ fallback), triple-tap toggle. Must be loadable standalone
   (the shell inlines it before modules — document the contract).
3. `v2/stories.html` — harness: fake clock scrubber, a fake oat with a story, reveal
   lifecycle driveable end-to-end; `window.__v2.stories` state for gates.

## Tests (node, fake clock; jsdom NOT available — design DOM ops as data + a thin applier,
test the data)
Reveal timeline vectors (glass in/reveal/roll/exit timestamps for a known text); grapheme
segmentation vectors incl. emoji/combining; wrapping given a stub measurer; cursor/assignment
rules; diag ring-buffer + persistence-throttle logic; watchdog/version-check state machines.

## Forbidden
No GPU/sim/audio imports. No legacy copying. No new deps. performance.now only via clock.js.
