# A Bestiary of Vanishings

The game at bestiaryofvanishings.com.
A slime mould grows over a sculpted body; the player feeds it oats; where it reaches
an oat, a story surfaces.

This is a rewrite, made in November 2026, of an older 20,000-line version. The old
version is in this repository's history (last commit `2622cd1`). Pushing `main` deploys;
bump `window.__BUILD_VERSION` at the top of `index.html` when you do.

## Run it

Any static file server from this folder works; there is no build step.

```
python3 -m http.server 8319
open http://127.0.0.1:8319/
```

Useful URLs: `?dev` (skip the start screen and intro), `?slime=mould` (a different
organism), `?mobile=1` (the phone profile), `?diag=1` (diagnostics report),
`?safe=1` (report only; load nothing). In the game: `P` settings panel, `S` skip
the intro, `M` story boxes on/off, `1` / `2` slime / gold layers, arrow keys orbit,
Shift slows the camera.

## Where things are

| Folder | What it is |
|---|---|
| `index.html`, `shell/` | The page, the diagnostics log, and the boot script that keeps cached code from going stale |
| `src/main.js` | Boot: load assets, build the parts, run the frame loop |
| `src/surface/` | The body: mesh, raycasts, and the two atlas textures (metric and seams) that let shaders work on the skin without knowing how it was unwrapped |
| `src/slime/` | The organism. `model.js` is the interface; `physarum/` is the game's organism; `mould/` is a second, tiny one |
| `src/render/` | Camera, lights, the slime film, the gold body, oat markers |
| `src/game/` | The mechanics: oats, stories, the start/intro/ending flow, pointer input |
| `src/audio/` | The sound engine |
| `src/ui/panel.js` | The settings panel, generated from each part's `paramSchema` |
| `tests/` | Browser checks (see below) |
| `docs/CONTRACTS.md` | Conventions and the interfaces between the parts |
| `docs/NOTES.md` | How this differs from the old game, and what was left out |

Each of `src/audio/`, `src/game/flow/` and `src/game/stories/` has its own `NOTES.md`
listing the old-game behaviours it reproduces.

## Swapping the slime's behaviour

The game mechanics and the renderer only use the `SlimeModel` interface in
`src/slime/model.js`: give it food and disturbances, step it, read its `thickness`
texture, ask how much slime is near some points. To try another behavioural model:

1. Copy `src/slime/mould/` (one file, about 150 lines, the whole interface).
2. List your factory in `SLIME_MODELS` in `src/slime/model.js`.
3. Load `?slime=<your id>`. Its settings appear in the panel by themselves.

Write distances in world units (the body is 9.6 units long) and include
`SURFACE_GLSL` in your shaders: it converts world distances to atlas steps and carries
points across the atlas's cuts, so a model never deals with the unwrap.

## Resizing the slime

`SLIME_SIZE` in `src/config.js` is the slime's size relative to the body (1 = the old
game's proportions; currently 0.5). It scales the organism, the oats' reach and spacing,
and the pointer's push together.

## Swapping the mesh

Put the new GLB (and its normal map) in `assets/` and point `ASSETS` in `src/config.js`
at them. The GLB needs a `uv` set for the slime atlas; a second set (`uv1`) is used
for the normal map if present. Nothing needs retuning for a different unwrap: speeds,
sizes and food reach are in world units. What the unwrap does decide is detail: a part
of the body that gets few texels can only carry coarse slime.

## Checks

They drive the real game in headless Chrome and need Playwright
(`PLAYWRIGHT_PATH=/path/to/playwright/index.mjs` if it is not installed here) and a
server on port 8319.

| Command | What it checks |
|---|---|
| `node tests/smoke.mjs` | The game boots, seeds a colony, and the colony lives |
| `node tests/play.mjs` | The opening as a visitor: Begin, intro, an oat, its story |
| `node tests/surface-checks.mjs` | Slime crosses the atlas's cut; nothing lives off the body |
| `node tests/idle-ending.mjs` | Two idle minutes end the game and reset it (takes 3 min) |
| `node src/audio/smoke-test.mjs` etc. | Each delegated module's own logic test, in Node |
