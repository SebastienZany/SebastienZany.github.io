# Flow: notes

Start screen, intro, ending, restart. Verified against the old `main.js` in this repository's history, as of commit
`045672c` ("Add idle-triggered ending"), plus its `index.html` and `styles.css`.
Logic test: `node src/game/flow/smoke-test.mjs` (fake clock, fake DOM, stub audio, stub
`three`). In the browser the flow is exercised by `tests/play.mjs` (Begin, intro, seeding)
and `tests/idle-ending.mjs` (idle ending and restart).

## Files

| file | what |
| --- | --- |
| `index.js` | `createFlow`: wiring, `phase`, restart |
| `flow.config.js` | every timing and constant; `paramSchema` for the two ending toggles |
| `start-screen.js` | status/Begin cross-fade, title, intro line and dots, error state |
| `begin-button.js` | Begin's hover fill and click glow |
| `intro.js` | the timeline from the click to `seedColony` (timeline table at the top) |
| `intro-oat-path.js` | the oat's path, scale, brightness; the top-edge back-solve |
| `intro-oat-sprite.js` | the sprite and its glow texture |
| `ending.js` | time-limit and idle endings, idle clock |
| `ending-overlay.js` | black fade sheet and corner countdowns (created in `#app`) |
| `easing.js` | smoothstep and its inverse |
| `smoke-test.mjs`, `smoke-three-stub.mjs` | the Node test |

## Intro timeline (ms)

`commit` = the click, or later if `intro.wav` was not decoded (see below). `C = commit + 2826.23`.

| at | what |
| --- | --- |
| click | `unlockFromGesture()`, `slime-fuse` one-shot, Begin disabled: all synchronous |
| commit | `intro` one-shot scheduled with `atMs = C`; Begin snaps lit and its glow swells; `is-armed`; preload of `slime-appear-stretch`, `slime-tumble`, `cuttlefish-camouflage` |
| commit + 826.23 | Begin and title fade out (1000) |
| C | intro.wav sounds; intro line fades in (1000) |
| C + 875 / 1750 / 2625 | the three dots fade in (1000 each) |
| C + 3500 | intro line fades out (1000) |
| C + 4500 | black screen fades out (1000); `is-running` (input reaches the canvas) |
| C + 5500 | `startEnvLoop()`; the oat's lower edge crosses the top of the screen |
| S = C + 5500 - lead | sprite created and starts falling (`lead` solved from the camera) |
| S + 6800 | landed (0.14 world above the initial oat); starts brightening to opacity 1.72 |
| S + 9000 | `slime-appear-stretch`; sprite fades out |
| S + 10000 | sprite removed; `is-complete`; `hooks.seedColony(now, { durationMs: 3460 })` |
| + 3460 | colony grown: idle clock may start; time-limit ending is armed if enabled |

## Old behaviours reproduced (old function names)

- Status -> Begin cross-fade: status out 1000, then Begin in 1000; clickable only above opacity 0.18, when ready, not requested, not disabled (`updateStartScreenUi`, `showStartButton`).
- Begin visuals: hover mix eased over 500 ms, white fill, text white->black, border alpha 0.62..0.90, glow `rgba(188,255,236)`; click glow rises until the click-sound peak then decays over 1000 (`applyStartButtonVisual`, `setStartButtonHoverTarget`).
- Begin events: pointerdown and keydown Enter/Space light it at once; pointerenter/leave, focus (only `:focus-visible`) and blur ease it. Keyboard activation is the native button click (listeners in `init`).
- Fatal error: message replaces the status in red (`.error`), Begin hidden and disabled, screen un-hidden (`showStartScreenError`, `fail`).
- Click: the claim, the click sound and the audio unlock happen before anything asynchronous (`requestIntroStart`).
- Wait for `intro.wav`: timeline held until decoded, at most 4000 ms; if it never decodes the intro runs without it, and it starts late if it turns up (`requestIntroStart`, `INTRO_BUFFER_WAIT_MAX_MS`).
- Title/line/dots/screen fades (`updateStartScreenUi`), `is-running` at C+4500 (`updateStartScreenIntroState`).
- Oat: target, start at NDC y 1.55 over the target, fallback start 2.8 world up, pose maths, 18-step bisection for the top-edge lead, additive sprite with depth test off and renderOrder 20, per-pixel sRGB glow texture (`getIntroOatTargetPosition`, `getIntroOatStartPosition`, `getIntroOatSpriteScale`, `getIntroOatTopEdgeLeadMs`, `maybeBeginIntroSequence`, `updateIntroSequence`, `makeOatGlowSprite`, `makeRadialGlowTexture`).
- Env loop at C+5500 (`startIntroEnvAudio`); seed sound 1000 before the end, played at the finish instead if it had not been (`updateIntroSequence`, `finishIntroSequence`, `replayInitialAgentSeed`).
- Skip: allowed once ready and until the colony is seeded, also from the start screen before Begin; stops `intro` (80 ms fade), starts the env loop, finishes at once; the "click time" becomes the skip time (`skipIntroSequence`).
- `?dev`: `setReady` hides the screen (`display:none`) and skips (end of `init`, `DEV_MODE`). A later ending shows it again: `returnToBegin` clears that `display`.
- Ending arming, schedule, fallback fade, fade curve, countdown text and its target, restart (`armEndingSequence`, `prepareEndingCamouflageSchedule`, `startEndingCamouflageSound`, `useFallbackEndingFade`, `updateEndingSequence`, `completeEndingSequence`, `formatEndingCountdown`).
- Restart order: ending cancelled and `cuttlefish-camouflage` stopped (80 ms) -> `hooks.resetWorld(now)` -> `stopEnvLoop({ fadeMs: 2500 })` -> `stopTumbleLoop({ fadeMs: 1200 })` -> intro state cleared -> start screen back, opaque, Begin fully visible and clickable immediately (`completeEndingSequence`, `resetIntroSequenceToStartScreen`).
- Toggle side effects (`bindToggle('endingTimeLimitEnabled')`, `bindToggle('endingIdleEnabled')`).

## The idle-triggered ending (`noteEndingActivity`, `updateIdleEnding`)

- On by default; the time-limit ending is off by default. If the time limit is on, the idle ending is inert.
- Activity = `pointerdown`, `pointermove`, `click`, `wheel`, `keydown` on `window` (capture, passive). The flow binds these itself.
- The idle clock only runs once the intro is complete and the colony has finished growing in; the first such frame starts it at zero. It is stopped on the start screen and during the intro.
- After 120000 ms without activity the ending is armed with trigger `idle`: the camouflage sound starts immediately, the black fade starts 7000 ms into it and reaches full black exactly as the sound ends, then the game restarts. No countdown is shown.
- Any activity before the restart cancels it: sound stopped, black cleared at once (no fade back), idle clock restarted.
- Time limit, for contrast: armed when the colony has grown in; deadline = Begin time + 120000 (from "now" when switched on mid-game); the sound is placed to end on the deadline; countdown reads time to the sound's start, then time to the deadline; activity does not cancel it.

## Camera

The old intro and ending move the camera nowhere, and the restart does not reset it. The flow reads `ctx.camera` (projection for the oat's path) and never touches `ctx.cameraRig`.

## Deliberately different or left out

- The old code awaited promises inside `requestIntroStart` and the ending; here those waits are polled from `update(now)` (`audio.isReady`, plus the settling of `audio.preload`). A late `intro.wav` therefore commits on the next frame rather than in a microtask.
- The old ending phase `camouflage-loading` is gone: `playOneShot` is synchronous, so the phase was instantaneous.
- The old warning when intro.wav started more than 250 ms off schedule is dropped: the audio contract does not report the real start time.
- `game-complete` was only ever stopped, never played, in the old game. Not referenced.
- The ambience clip is not preloaded by the flow at Begin (the old code called `initEnvAudio`). `src/game/game.js` preloads it in the background as soon as the start screen is ready.
- Loading progress text: the old status always read `loading...` (progress went to the diag log only). Kept; the flow has no progress API.
- Old `fail()` also opened the diagnostics overlay and wrote a panel status line: the shell's business.

## Where the August checklist was wrong or stale

- It predates the idle ending entirely.
- "Camouflage clip scheduled to end exactly at targetReturnAt": only for the time limit. The idle ending starts the clip immediately.
- "targetReturnAt = beginClick + 120000": the base is the committed click time (after any decode wait), a skip overwrites it with the skip time, and a clock value of exactly 0 counts as unknown.
- The countdown is not simply "time left": see above.
- All its line numbers have drifted.
- "Seeding ramps 4096 agents" was not checked (not this module).

## Unsure

- `playOneShot(name, { atMs })` with `atMs` in the past must start immediately (the old code clamped). The time-limit ending relies on it when less than one clip length remains.
- `?dev` and `S` on the start screen call `startEnvLoop()` and `playOneShot()` before or without a Begin click. `skipIntro` calls `unlockFromGesture()` (S is a key gesture); the `?dev` path cannot.
- A second Begin after a restart does not stop a still-sounding `intro.wav` from the first run; neither did the old game.
- z-indexes (ending fade 8, countdown 9, start screen 10) are the old ones. `#overlay` (story boxes) has no z-index in `base.css`, so it sits below all three.
- `start-screen.css` uses `--font-story`, `--font-ui`, `--red` with fallbacks; `base.css` defines the two fonts and not `--red`, so the error colour is the fallback.

## Needed beyond the contract

Nothing extra is required from `ctx` or `hooks`. Assumptions and additions:

- `ctx.dom.app.ownerDocument.defaultView` is the window (used for the activity listeners and for `performance.now()` inside event handlers and `fail`).
- `hooks.seedColony(now, { durationMs })` must also start the tumble loop: `audio.startTumbleLoop({ atMs: now, fadeInMs: durationMs })` (old `beginInitialAgentSeeding`).
- `hooks.resetWorld(now)` = old `resetSimulation({ resetOats: true, spawnAgents: false })`: clear slime and every oat and story, re-place the initial oat, seed nothing.
- `hooks.getInitialOat()` may return `null` before the oat exists; the fall waits for it.
- The integrator's `S` handler (old `handleIntroSkipKeydown`): key `s`, no alt/ctrl/meta, not a repeat, not in an editable field -> `flow.skipIntro(performance.now())`. Returns `true` if it skipped.
- `src/game/game.js` preloads `slime-fuse` and `intro` before calling `setReady` (waiting at most 4 s), then the ambience and the story reveal sound in the background.

Extra members on the object `createFlow` returns:

```js
flow.setEndingEnabled(on)          // contract; this is the TIME-LIMIT ending (default off)
flow.setIdleEndingEnabled(on)      // idle ending (default on)
flow.noteActivity(now)             // count a non-DOM input (e.g. gamepad) as player activity
flow.colonyReseeded(now, grownAtMs)// the game re-seeded outside the intro (dev "Reset"):
                                   // cancels any ending; play counts as resumed at grownAtMs
flow.skipIntro(now) -> boolean     // contract, plus a return value
flow.debugState()                  // { intro, ending, beginClickedAtMs, colonyGrownAtMs } snapshot
```

`index.js` also exports `paramSchema` / `defaultParams` (keys `endingTimeLimitEnabled`,
`endingIdleEnabled`); the panel should call the two setters on change.
