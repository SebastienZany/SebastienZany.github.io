# Stories and oat markers: notes

Covers `src/game/stories/`, `styles/story.css` and `src/render/oat-markers.js`.
Everything below was checked against the old `main.js`, `index.html` and
`styles.css` (in this repository's history, last at commit `2622cd1`); old function
names are in brackets.

Run the test: `node src/game/stories/smoke-test.mjs` (library hand-out, trigger
polling with a fake clock, timeline numbers, wrapping, placement, CSS vars). In the
browser: `tests/play.mjs` (an oat's story appears) and `tests/story-depth.mjs`
(overlapping boxes hand over gradually).
Not run in a browser: nothing else of the game existed when this was written.

## What the old coverage score computes (for `hooks.coverageNear`)

[observationTriggerScoreFragment, renderObservationTriggerScoreTexture, readOatSlimeTriggerScore]

For each oat uv, the score is the **maximum of the red channel** of the display
field over a square of texels around the oat:

- Field: `renderSampleViewRT`, the smoothed slime/"food" field the slime
  surface shader draws from (spatially and temporally smoothed, clipped to
  authoritative texels, padded across seams). Not the raw simulation field.
- Centre texel: `floor(clamp(uv, 0, 1) * fieldSize)`, clamped into the field.
- Window: 7 x 7 texels (radius 3, `OBSERVATION_SLIME_TRIGGER_RADIUS_TEXELS`),
  read with `texelFetch` (no filtering); texels outside the field are skipped.
  The radius is in texels, so it covers twice the surface on mobile (768 field)
  as on desktop (1536).
- Each value is `max(value, 0)`. No normalisation: the score is the raw field
  value. The shader also computes the window mean, but only the max is used.
- A story triggers when `score >= threshold` (default 0.05).

## Reproduced behaviours

Story library
- `assets/stories.json` is `{ stories: [{ title, text }] }`. Only `text` is
  shown; `title` is used only if an entry has no text. [normalizeStoryEntry]
- Text tidy-up: unix newlines, lines trimmed, runs of spaces collapsed, at most
  one empty line between paragraphs. [normalizeStoryTextValue]
- Fetched with `cache: 'no-store'`. A failed or empty load is logged and
  non-fatal; every story then shows the placeholder sentence. [loadStories, getNextStoryText]
- Stories are handed out in file order, wrapping around, **when an oat's text
  starts** (not when the oat is placed or triggered), so the order follows the
  order oats are reached by slime. `reset()` rewinds to the first story.
  [ensureOatStoryText, maybeStartOatObservationText, clearAllOatsImpl]
- The initial oat gets no story box and is never polled. [addInitialOat: suppressObservation]

Trigger [updateObservationSlimeTriggers, collectObservationTriggerCheckIndices, processObservationTriggerScoreIndex]
- One pass every 220 ms; a pass asks for at most 4 untriggered oats, picked
  round-robin over the oat list. The answer is acted on in the first frame
  after it lands; the next request goes out 220 ms after that.
- Answers asked for before an oat was placed or removed are discarded.
- While story boxes are disabled nothing is polled; polling resumes 220 ms
  after re-enabling.
- On trigger [triggerOatObservation, playCuttlefishRevealSound]:
  `audio.playOneShot('cuttlefish-reveal', { atMs: now })`, marker fade-out over
  1800 ms, text start scheduled for trigger + 1800 ms.

Story box lifecycle [buildObservationTextAnimation, getObservationEnvelope]
- At trigger + 1800 ms: story assigned, text wrapped, `onStoryTextStarted`
  called (the old code started the oat's food decay here), timeline starts.
- 0..2600 ms: glass fades in (smoothstep); text opacity is 0.
- From 2600 ms: lines wipe in left to right. Line duration =
  `max(240, (graphemes * 190 + 1560) * 0.845)` ms; the next line starts when
  the previous is 2/3 done. The wipe is a mask 260% wide sliding from
  `100% 0` to `15.5% 0`.
- Scrolling: the text block starts at `viewport height - 28px` and moves up one
  line height, linearly, between successive line starts.
- Exit: after the last line is revealed the block rolls up and out over
  `max(2400, average line duration * 5)` ms.
- Then glass and text fade out together over 2600 ms. The box stays hidden.
- Box hidden while glass opacity <= 0.005.

Text [wrapObservationText, wrapObservationParagraph, splitObservationWordToFit, splitObservationGraphemes]
- Measured with Canvas2D `measureText` using the text element's computed font
  (EB Garamond, 1.17rem, line-height 1.35); width = client width minus padding,
  at least 20 px. Greedy word wrap; over-long words break between graphemes.
- Graphemes via `Intl.Segmenter`, falling back to code points.
- Each newline becomes an empty line and an empty paragraph is itself an empty
  line, so a blank line between paragraphs becomes **three** empty lines
  (about 0.88 s each). That is what the old code does; kept.
- If `document.fonts.ready` resolves while a box is performing, its text is
  wrapped again and the performance restarts. [createOatObservation]

Placement, every frame [updateOatAnnotations, updateObservationTail, getTailAnchor]
- Box 230 x 126 px (narrower if the screen is under 258 px), centred above the
  oat's screen position by `max(8, tailLengthVh * viewport height)`, clamped to
  14 px screen margins. Hidden if the oat projects outside clip z.
- z-index = `round((1 - depth01) * 100000)`: nearer oats on top. Applied to the box's
  glass and to its text separately (see "Differences" below).
- Opacity = lifecycle x facing `smoothstep(dot, -0.14, 0.2)` x occlusion.
  Occlusion: ray test via `surface.isOccluded(camera.position, oat.point)`,
  re-tested every `120 + (n * 19) % 120` ms (n = nth story oat), skipped and
  taken as hidden when facing <= 0.002, eased exponentially.
- Tail: a 1.5 px line from the box edge to the oat, drawn only when the oat is
  outside the box. It shares the border's opacity, 0 by default (invisible).

Settings [params, syncObservationCssVars, index.html "Story Labels"]

| key | old name | range, default | CSS variable |
| --- | --- | --- | --- |
| storyBoxesEnabled | storyBoxesEnabled | toggle, true | none |
| tailLengthVh | observationTailLength | 0..0.9 step 0.01, 0.15 | none (placement) |
| strokeOpacity | observationStrokeOpacity | 0..1, 0 | --story-stroke-opacity |
| cornerRadiusPx | observationCornerRadius | 0..24, 24 | --story-corner-radius |
| edgeFeatherPx | observationEdgeFeather | 0..48, 24 | --story-edge-feather-outset (x1.75), -mask (x2.6), -opacity (min(1, px/8)) |
| blurRadiusPx | observationBlurRadius | 0..36, 7 | --story-blur-radius |
| tintColor | observationTintColor | colour, #000000 | --story-tint-rgb |
| tintOpacity | observationTintOpacity | 0..0.5, 0.33 | --story-tint-opacity |
| triggerThreshold | observationSlimeTriggerThreshold | 0..1 step 0.01, 0.05 | none |
| depthSoftnessWorld | (new) | 0.02..3 step 0.02, 0.6 | none (depth softening) |

Variables are set on the `.story-layer` element (the old code set them on
`<html>`). Text colour `--story-text-rgb` followed the old `slimeBaseColor`
param (default #ffffff) at alpha 0.88.

Oat markers [makeRadialGlowTexture, makeOatGlowSprite, createOatGlowMarker, updateOatGlowMarkers, getOatStorySpriteOpacity]
- Glow texture: 96 px, radial ramp painted per pixel into an sRGB canvas (the
  iOS "green speckle" fix), stops in `oat-markers.config.js`.
- Sprite: 0.408 world units, white tint, additive, no depth test or write,
  render order 8.
- Fade-in 900 ms from placement; fade-out over the duration given to
  `fadeOut` (stories pass 1800 ms); both smoothstep. Hidden below 0.01.
- Facing fade `smoothstep(dot, -0.18, 0.14)`; occlusion as for boxes but eased
  at 14/s.
- The initial oat has no visible marker (`add` ignores it).
- Fizzle [spawnRejectedOatFizzle, updateRejectedOatFizzleMarker, getFizzleFlameOpacity]:
  1050 ms, 0.364 world units, opacity 0.95 x flame flicker, shrinking with
  jitter, random flicker phase, same facing/occlusion fade.
- `setVisible(false)` hides the group and stops marker updates [`showOats`].

## Deliberately left out

- `?legacyglow` (Canvas2D gradient glow, an A/B switch for the iOS fix).
- Other JSON shapes the old parser accepted (`items`, `entries`, `lines`,
  `story`, `body`, ...): the shipped file uses none of them.
- `completeOatObservation`, `setOatObservationText`, per-oat `storyText`
  options and the trigger diagnostics object: recorder/replay and console hooks.
- The GPU plumbing of the old trigger (occlusion-query pre-check, PBO
  readback): replaced by `hooks.coverageNear`.
- The `M` key toggle [handleStoryBoxesKeydown] belongs to input; it should
  call `stories.setEnabled(!stories.params.storyBoxesEnabled)`.

## Differences from the old code, on purpose

- Line wipes and scrolling were Web Animations on the document clock; here
  they are set from `update(now)` using the same keyframes (all linear), so
  everything follows the frame loop's clock.
- Box occlusion easing: the old box code names a rate of 10/s, but box and
  marker shared one cache that the marker pass had already stepped at 14/s the
  same frame, so with oats shown the box effectively eased at 14/s. Boxes now
  keep their own state at 14/s (and do their own ray test every ~120 ms). With
  `showOats` off the old rate was 10/s; that case is not reproduced.
- Font-arrival re-layout only restarts a box that is still performing. The old
  condition would also have replayed a finished story.
- The old code kept an invisible sprite for the initial oat; here none is made.
- Overlapping boxes. In the old code each box was one element whose frosted glass
  (a backdrop blur) covered whatever was behind it, other boxes' words included, so
  two boxes swapping depth order popped. Here a box is two elements: its glass, in a
  `.story-glasses` layer beneath every box's text, and its text, in `.story-texts`.
  Glass therefore never frosts another box's words. Instead `depth-softening.js`
  computes, per box, how obscured it is by nearer boxes it overlaps: 0 when level with
  them in depth, rising to 1 once it is `depthSoftnessWorld` behind and 40% covered.
  `story-box.js` `setObscured` turns that into a blur of up to `blurRadiusPx` and a
  dimming of up to `tintOpacity` on the box's text. Added 2026-11-10 at the artist's
  request.

## Contradictions with the earlier checklist

- "title never rendered": true for the shipped file, but the code falls back
  to the title when an entry has no text.
- "handed out per oat on first need": first need is the text start, 1800 ms
  after the trigger, not placement.
- The checklist does not mention the tail line, the three empty lines between
  paragraphs, or that the initial oat's marker is invisible.
- Its line numbers are off by roughly 130 to 150 lines.

## Needed beyond the contract

- `hooks.params` (optional): the live settings object with the keys above. If
  absent, `createStories` makes one from `defaultParams()`. Either way it is
  exposed as `stories.params`; the dev panel mutates that object.
  `setEnabled(on)` writes `params.storyBoxesEnabled`.
- `hooks.getTextColor() -> '#rrggbb'` (optional): story text colour, the old
  `slimeBaseColor`. Defaults to `'#ffffff'`.
- `ctx.dom.canvas.clientWidth/clientHeight` is used as the viewport size.
- `surface.isOccluded(from, point)` must stop short of `point`: the old ray
  ended 0.048 world units before the oat (`OBSERVATION_OCCLUSION_MARGIN`), or
  every oat would be hidden by the surface it sits on.
- Frame order: call `markers.update(now)` and `stories.update(now)` after the
  camera controls have updated and before rendering. `markers.setVisible` takes
  the `showOats` setting.

## Unsure

- Text blur on phones: the depth softening changes a CSS blur on text every frame
  while boxes overlap and the camera moves. Measured on a desktop it costs nothing
  visible (60 fps with five boxes); it has not been measured on a phone.
- `coverageNear` latency: the old readback usually landed a frame or two after
  the request. A much slower implementation slows triggering in proportion.
