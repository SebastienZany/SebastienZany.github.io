# U1 — Parameters panel + stats HUD (DOM lane; fresh build, no GPU)

**Objective:** the full control surface — parameters panel and stats HUD — written fresh as a
small declarative DOM module driven by `shared/params.js`, matching legacy's controls, grouping,
presets, help-tips, and keyboard/touch affordances per the parity checklist. Binds to a state
provider interface; the sim/game wire in later (M6).

**Read first:** PLAN §0 mandates; `reference/parity-checklist.md` **§2 in full** (every control,
preset behavior, stats semantics, touch hotspot, shortcuts); anchors: binding table
main.js:18212-18253, presets 363-529 + custom-flip 18433-18438, help-tips 18412-18422, panel
DOM index.html:254-829 + styles.css (REFERENCE ONLY — fresh markup/CSS, same visual character:
dark glass, top-left ≤460px, backdrop blur), stats 19043-19077 + history charts (3 canvases,
180 samples), triple-tap hotspot 8331-8367, shortcuts 8300-8399.

## Deliverables
1. `src/game/panel.js` — declarative: the panel renders FROM the params table (groups, sliders
   with min/max/step, checkboxes, colors, selects, help-tips from a strings table), two preset
   selects with verbatim preset application + any-edit→custom; collapse; pause button hook;
   action row (Reset/Reset camera/Seed/Initial oat) firing a command interface.
2. `src/game/stats.js` — agent/oat/coverage/fps lines + the three history canvases (population/
   growth/acceleration, 180-sample ring), fed by a stats-provider stub; readback-opt-in
   semantics preserved as interface flags.
3. `src/game/hotkeys.js` + touch hotspots (P/S/M/1/2/3 routing to a command interface; field
   suppression; triple-tap corner logic with the 1200ms/12px rules).
4. `v2/panel.html` — harness page mounting panel+stats against stub providers with a fake
   clock; `window.__v2.panel` exposing state for gate automation.
5. Fresh CSS (own file) with the legacy visual character; no styles.css copying.

## Tests (node)
Panel model: every checklist §2c control present with exact ranges/defaults (cross-check against
params.js — must be a projection, no drift); preset application vectors (apply stable-medium →
exact values; edit one → custom); history ring math; hotkey routing table; triple-tap state
machine on a fake clock.

## Forbidden
No GPU, no sim imports, no legacy code copying, no new deps, DOM only in panel/stats modules +
harness. Keep modules ≤400 lines each (split by group if needed).
