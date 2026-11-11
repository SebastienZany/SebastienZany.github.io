# A Bestiary of Vanishings — conventions and interfaces

This is a rewrite of the older version of the game in this repository's history (last at
commit `2622cd1`), written to be read. That old `main.js` (20k lines) was the only source
of truth for behaviour while this was written. Notes left by earlier, abandoned rewrite
attempts were often wrong and were used only as an index of where to look. No code was
copied from them or from the old `main.js`: it was read for behaviour and constants, and
the behaviour written fresh.

## Shape of the program

```
index.html          the page: build stamp, import map, static start-screen markup
shell/              plain scripts that run before the game: diagnostics log, freshness check and boot
styles/*.css        one stylesheet per UI surface
assets/             model, normal map, gold film tensor, stories.json, sounds/*.wav
src/main.js         boot: load assets, build modules, run the frame loop
src/surface/        the body: mesh, UV atlas maps (position, metric, seams), raycasts
src/slime/          the organism. `model.js` documents the SlimeModel interface;
                    each subfolder is one behavioural model behind that interface
src/render/         camera, lights, slime film material, gold body, oat markers
src/game/           game mechanics: oats, stories, intro/ending flow, input
src/audio/          WebAudio engine
src/ui/             the settings panel
tests/              browser checks (see README.md)
```

The one architectural rule: **game mechanics and rendering never reach inside a slime
model.** They use the SlimeModel interface only (feed it food and disturbances, step it,
read its thickness texture and its coverage queries). Swapping the organism's behaviour
means writing one new folder under `src/slime/`.

## Conventions

- Plain ES modules, no build step, no framework. `three` (0.170.0), `three/addons/` and
  `three-mesh-bvh` (0.8.3) come from the import map in `index.html`.
- Every module exports a factory: `createThing(ctx, options) -> object with methods and
  dispose()`. No module-level mutable state, no singletons, no globals except
  `window.__diag` (owned by the shell) and `window.__game` (dev hooks, owned by main.js).
- Time is passed in. Per-frame code receives `now` (milliseconds, `performance.now()`
  domain) from the frame loop and never calls `performance.now()` or `Date.now()` itself.
  Event handlers may read `performance.now()` once and pass it on.
- Tunable numbers live in a `*.config.js` data file next to the module that uses them,
  each with its unit in the name or a comment (`fadeMs`, `radiusPx`, `distanceWorld`).
- Runtime-tunable settings are a plain `params` object read live each frame, described by
  a `paramSchema` the module exports (see below), so the dev panel is generated, never
  hand-written.
- One purpose per file; aim for 300 lines or fewer. Comments say why, state units and
  invariants; they do not narrate the code. Name things for what they are in the game
  ("oat", "story box"), not for how the old code happened to implement them.
- Units in names where it could be ambiguous: `uv` (0..1 atlas), `texel`, `world`, `px`
  (CSS pixels), `ndc`.
- Fail soft: a missing sound or a failed story load degrades the experience and logs via
  `ctx.diag.log(tag, detail)`; it never throws into the frame loop.

## The shared context

Every factory receives the same `ctx`:

```js
ctx = {
  diag,        // { log(tag: string, detail?: string) } — the shell's diagnostics log
  flags,       // parsed URL flags, e.g. { dev: boolean, ... }
  profile,     // { isMobile: boolean, fieldSize: number, maxPixelRatio: number }
  dom,         // { app: #app, canvas: #sim, overlay: #overlay }
  renderer,    // THREE.WebGLRenderer
  scene,       // THREE.Scene (world space; the body is centred on the origin)
  camera,      // THREE.PerspectiveCamera
  cameraRig,   // { controls (OrbitControls), initialPose, getPose(), setPose(pose) }
  surface,     // see Surface
  audio,       // see Audio
  slimeSize,   // SLIME_SIZE from src/config.js: scale for every slime-related world distance
}
```

`src/main.js` builds it. Slime models get a smaller one: `{ gpu, surface, diag, sizeScale }`,
where `gpu` is the pass helper from `src/util/gpu.js`.

`#overlay` is a full-viewport, `pointer-events: none` layer above the canvas for DOM that
is positioned over the scene. Modules create their own DOM inside `dom.app` or
`dom.overlay` and remove it in `dispose()`. The one exception is the start screen, whose
markup is static in `index.html` so it is visible before any module loads.

### Surface (read-only for everyone but `src/surface/`)

```js
surface.mesh                      // THREE.Mesh of the body, world space, BVH-accelerated
surface.geometry                  // its BufferGeometry (position, normal, uv; uv1 if the file has it)
surface.worldSize                 // longest bounding-box extent in world units (9.6)
surface.fieldSize                 // atlas resolution the slime lives at
surface.worldPerUv, .texelWorld   // mean world length of one atlas unit / of one texel
surface.raycast(ndc, camera)      // -> { uv:{x,y}, point:Vector3, normal:Vector3 } | null
surface.uvToWorld(uv, target?, normalTarget?)   // -> Vector3 | null
surface.isOnBody(uv)              // -> boolean: is this atlas point on a texel slime can occupy
surface.worldDistance(uv, otherUv)// world length of that atlas step, by the metric at uv
surface.isOccluded(from, point)   // -> boolean; true if the body blocks the segment
surface.uniforms()                // uniform values for shaders that include SURFACE_GLSL
surface.pad(texture, target)      // copy a field, filling texels just off the body from across the cut
```

Shaders that work in the atlas include `SURFACE_GLSL` from `src/surface/surface-glsl.js`.

### Oat (created by `src/game/oats.js`)

```js
oat = {
  id: number,            // unique, increasing
  uv: { x, y },          // atlas position
  point: Vector3,        // world position on the body
  normal: Vector3,       // unit surface normal there
  initial: boolean,      // the first oat, where the colony is seeded; it never gets a story
  createdAtMs: number,
}
```

### Audio (`src/audio/index.js`)

```js
createAudio(ctx) -> {
  unlockFromGesture(),                 // call synchronously inside the Begin click handler
  preload(names) -> Promise<void>,     // fetch + decode; never needs a gesture
  isReady(name) -> boolean,
  durationMs(name) -> number | null,
  playOneShot(name, { atMs, volume } = {}) -> { stop({ fadeMs }) } | null,
  startEnvLoop({ atMs } = {}),   stopEnvLoop({ fadeMs } = {}),
  startTumbleLoop({ atMs, fadeInMs } = {}),   stopTumbleLoop({ fadeMs } = {}),
  stopAll({ fadeMs } = {}),
  update(now, { camera, sourcePosition, referenceDistance }),  // spatial sync; call every frame
  dispose(),
}
```

Clip names are the wav basenames in `assets/sounds/` (`intro`, `slime-fuse`, ...).
`atMs` is a `performance.now()`-domain time for sample-accurate starts.

### Flow (`src/game/flow/index.js`): start screen, intro, ending, restart

```js
createFlow(ctx, hooks) -> {
  phase,                    // 'loading' | 'ready' | 'intro' | 'playing' | 'ending'
  setReady(now),            // loading finished: the Begin button may appear
  fail(message),            // fatal load error shown on the start screen
  update(now),              // every frame
  skipIntro(now),
  introSpritePosition(),    // Vector3 | null: where the falling intro oat is (audio follows it)
  setEndingEnabled(on),     // the time-limit ending (off by default)
  setIdleEndingEnabled(on), // the idle ending: two minutes without input (on by default)
  noteActivity(now),        // count something other than a pointer/wheel/key event as player activity
  colonyReseeded(now, grownAtMs),  // the game re-seeded outside the intro
  debugState(),             // snapshot for dev hooks and tests
  dispose(),
}
hooks = {
  getInitialOat() -> oat | null,       // the landing target of the intro oat
  seedColony(now, { durationMs }),     // start growing the colony at the initial oat, and start the tumble loop
  resetWorld(now),                     // ending restart: clear slime, oats and stories, re-place the initial oat
}
```

The flow listens for input on `window` itself to run the idle ending. Its two toggles
are also exported as a `paramSchema`; the panel calls the two setters.

### Stories and oat markers (`src/game/stories/index.js`, `src/render/oat-markers.js`)

```js
createOatMarkers(ctx) -> {
  add(oat, now), remove(oat), fadeOut(oat, now, durationMs),
  fizzle(point, normal, now),          // the "rejected oat" puff
  setVisible(on), update(now), reset(), dispose(),
}
createStories(ctx, hooks) -> {
  load() -> Promise<void>,             // assets/stories.json; failure is non-fatal
  onOatPlaced(oat, now), onOatRemoved(oat),
  update(now),                         // polls coverage, runs story boxes
  setEnabled(on), reset(), dispose(),
  params,                              // live "Story labels" settings (schema exported by the module)
}
hooks = {
  markers,                              // the createOatMarkers instance
  coverageNear(uvs) -> Promise<number[]>,  // slime coverage score near each atlas point
  onStoryTextStarted(oat, now),         // the game starts that oat's food decay here
  getTextColor() -> '#rrggbb',          // optional: story text colour (the slime's body colour)
  params,                               // optional: use this settings object instead of the defaults
}
```

The initial oat gets no marker and no story. Call `markers.update(now)` and
`stories.update(now)` after the camera has moved for the frame and before rendering.

### Slime model (`src/slime/model.js`)

The interface, with its documentation, is the `SlimeModel` typedef in that file. Models
are created with `{ gpu, surface, diag, sizeScale }`.

## paramSchema

A module with runtime-tunable settings exports defaults and a schema; it reads
`params[key]` live.

```js
export const paramSchema = [
  { section: 'Story labels', items: [
    { key: 'storyBoxesEnabled', label: 'Story boxes', type: 'toggle', default: true, help: '...' },
    { key: 'tailLengthVh', label: 'Tail length', type: 'range', min: 0, max: 0.5, step: 0.005, default: 0.12, help: '...' },
    { key: 'tintColor', label: 'Tint', type: 'color', default: '#ffffff' },
    { key: 'debugView', label: 'View', type: 'select', options: ['slime', 'food'], default: 'slime' },
  ] },
];
export function defaultParams() { /* -> { key: default, ... } from the schema */ }
```

## Module notes

The audio, flow and stories modules each have a `NOTES.md` next to them listing: the
old-game behaviours reproduced (with the old function names they were verified against),
what was deliberately left out and why, what is still unsure, and what the module needs
from its caller. When a module changes, change its notes in the same commit; a note that
no longer matches the code is worse than no note.
