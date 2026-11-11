# How this differs from the old game

The old game (`main.js` in this repository's history, last at commit `2622cd1`) was the
reference for behaviour. This file
lists where the rewrite knowingly differs, and what it does not include.

## Deliberate differences

- **The organism works in world units.** The old simulation measured speed, sensing
  distance, food reach and so on in atlas (UV) units, so its behaviour depended on how
  the mesh was unwrapped and needed retuning for each mesh. Here those are world
  distances, converted through the surface's metric. The numbers are the old ones
  converted at the old mesh's average of 19.483 world units per atlas unit, so on
  average the colony behaves the same. Locally it differs wherever the unwrap is denser
  or sparser than average: on the current mesh the opening colony is about 1.2 times
  wider than in the old game, because that part of the body has more texels than
  average and the old game therefore drew it smaller.
- **The slime is half the old size relative to the body** (`SLIME_SIZE = 0.5` in
  `src/config.js`, set on 2026-11-10 at the artist's request). One number scales every
  slime-related distance together, oats' reach and spacing included. Set it to 1 for
  the old proportions. To have texels fine enough for the smaller slime, the mesh in
  `assets/` uses the sculpt's own full-size UVs (61% of the atlas), not the shrunken
  ones the live site's copy has (20%).
- **One seam mechanism.** Every cut in the atlas is described once, as the map that
  carries a point beyond the cut to where it really is (`src/surface/`). Agents use it
  to move and sense across cuts, and fields are padded with it. This replaces the old
  redirect halos, transition atlases, weld maps, per-edge resolver and baked seam files.
- **Budding without sorting.** The old game sorted all agents every step (22 GPU
  passes) to hand free slots to newborn agents. Here each step pairs slots by a random
  shift and a parent may bud into its partner slot if that slot is free (1 pass). While
  the colony is far below capacity, which is always in normal play, every bud succeeds
  as before. Near capacity the old game filled slots in a fixed order and this one
  fills them with probability equal to the free fraction.
- **Story trigger reads the organism's own thickness**, not the smoothed copy used for
  drawing. The smoothed copy lags by a few frames, so a story may start a few frames
  earlier than in the old game.
- **The sculpt's normal map is applied to the gold body as well as the slime film.**
  The old game (as of the day the Shen v24 mesh went in) applied it to the film only.
- **Freshness.** The boot script re-checks every module with the server before running
  it, by walking the import graph; no list of files to maintain.
- **A second organism** (`?slime=mould`) exists as a template; the old game had one.

## Not included

- The session recorder and MP4 replay/export (the old `replay/` folder and the `R` key).
- The sound-check panel, the statistics readouts and history graphs, the camera pose
  readout, and the simulation/look preset menus. The settings panel has every slider;
  the defaults are the old "Default" simulation preset and "Pearl bright" look.
- Population control (off by default in the old game), optical zoom (off by default),
  the agent-dots and wireframe views, and the many seam debug views.
- Dev save/load of simulation state, `?rafshim`, and the triple-tap corner gesture that
  opened the panel on phones.

## Not verified

- Sound has only been exercised with a stubbed audio system and in headless Chrome
  (no errors). Nobody has listened to it.
- No real phone has run it. The phone profile and the no-float-blend / no-float-filter
  code paths run in desktop Chrome (`?mobile=1&likephone`).
- The look was compared with the old game by eye on screenshots of similar moments,
  not pixel by pixel: the two simulations are not step-for-step identical, so there is
  no identical frame to compare.
