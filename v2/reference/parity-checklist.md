# Feature parity checklist — "A Bestiary of Vanishings"

> Provenance: generated 2026-08-14 at commit `b113413` by a code-reading agent.
> This is the contract for what v2 must reproduce. Line anchors drift; behavior is the spec.
> Items marked ⏸ are consciously deferred or dropped in v2 (decide at the milestone that touches them).

## 1. Game flow

### 1a. Boot / diagnostics (before main module)
- [ ] Inline diag script runs before the module so it can report the module never executing — index.html:12-217
- [ ] `BUILD_VERSION` stamp cross-checked between shell and module; mismatch = "one file is cached" — index.html:27, main.js:10
- [ ] Ring-buffered event log (400 lines, last 150 persisted) → `localStorage['cuttle-diag-last']` every 250 ms + on `pagehide` — index.html:38-55
- [ ] Reload-loop counter in `sessionStorage` — index.html:33-36
- [ ] Captures window.error (incl. resource errors), unhandledrejection, patched console.warn/error, visibilitychange — index.html:150-170
- [ ] Env snapshot: UA, screen@dpr, cores, visibility, online — index.html:138-145
- [ ] Hard fail if the platform lacks a required feature (legacy: import maps; v2: WebGPU adapter) with a human-readable overlay message
- [ ] Overlay: fixed, safe-area insets, mono, copy button (clipboard + textarea fallback), close — index.html:100-131
- [ ] Auto-opens on: any error before load, 20 s watchdog, `?diag=1` — index.html:156,161,187-196
- [ ] Triple-tap on start screen within 1200 ms toggles overlay — index.html:173-185
- [ ] `?safe=1` — diagnostics only, game module never injected (crash-looping phones) — index.html:854-862
- [ ] `?rafshim` — setTimeout rAF trampoline — index.html:20-22

### 1b. Loading
- [ ] Status stays literally `loading...`; progress goes to diag log only — main.js:9732-9750
- [ ] Progress phases logged (download → preparing → mapping → shading → starting → compiling) — main.js:15273-15489
- [ ] Assets: mesh asset, gold LUT, stories.json, sound pack (idle-scheduled after start button) — main.js:8998-9022, 15871
- [ ] Throwaway warm-up frame absorbs pipeline-compile stall before start button — main.js:15489-15495
- [ ] Fatal path: red status on start screen + diag overlay — main.js:9753-9802
- [ ] Mobile profile: `(pointer:coarse)` && min(screen) ≤ 820 → smaller field, DPR cap 1.5, fast perf mode — main.js:98-117,18613-18618

### 1c. Start screen
- [ ] Title "A Bestiary of Vanishings" + subtitle "what grows in the dark remembers everything" + 3 animated dots + status + `begin` — index.html:241-252
- [ ] Fade choreography (`INTRO_UI_FADE_MS=1000`): status out 1 s, then begin in 1 s; button clickable only when opacity > 0.18 — main.js:6006-6048
- [ ] Custom-drawn button visuals (hover mix, cyan-white glow rgba(188,255,236), inset glow); hover fade 500 ms — main.js:5872-5924
- [ ] Hover/focus/pointerdown/keydown(Enter,Space)/blur drive hover target — main.js:18522-18536

### 1d. Intro sequence (`requestIntroStart` main.js:6082-6167)
- [ ] t=click: `slime-fuse` plays synchronously in-gesture (iOS unlock) before any await — main.js:6092-6100
- [ ] Timeline holds until intro.wav decoded, max 4000 ms (iOS "intro late" fix) — main.js:6102-6118
- [ ] `beginFadeOutAt = clickedAt + 826.23 ms` (click-sound peak); `contentStartAt = +1000 (fade) +1000 (silent beat)` — main.js:238-243,5996-6004
- [ ] intro.wav scheduled exactly at contentStartAt; warn if >250 ms off — main.js:6129-6143
- [ ] Title/subtitle/dots fade schedule; screen fades out at contentDelay+5500−1000 — main.js:6062-6079
- [ ] Preloads kicked: slime-appear-stretch, slime-tumble, cuttlefish-camouflage, env — main.js:6144-6164
- [ ] Oat sprite drop (10 s): starts NDC y=1.55, smoothstep descent, lands at progress 0.68, brighten ×1.72 to 0.9, fade by 1.0; scale formula — main.js:6233-6236,6353-6397
- [ ] Sprite start back-solved (18-iter binary search) so it crosses screen top exactly at contentStartAt+5500 — main.js:6252-6329
- [ ] Env loop starts at contentStartAt+5500 — main.js:6355-6362
- [ ] slime-appear-stretch at 10000−1000 ms — main.js:6388-6395
- [ ] Finish: sprite disposed, start screen `is-complete` + aria-hidden, `replayInitialAgentSeed()` — main.js:6399-6415
- [ ] Seeding ramps 4096 agents over 3460 ms; slime-tumble loop starts with fade-in = seed duration — main.js:17472-17528
- [ ] `S` skips intro — main.js:8369-8376,6169-6195
- [ ] `?dev` skips everything and seeds; `?dev&state` restores snapshot — main.js:15858-15870

### 1e. Main play loop
- [ ] Orbit (damped), zoom (dolly or optical FOV), oat drop (pointerup < 4 px movement), continuous pointer repulsion (45 ms raycast throttle, radius 0.07/3 UV, strength 3.0) — main.js:18129-18208
- [ ] Oat rejection: outside atlas / non-authoritative texel / too close to existing → "fizzle" marker — main.js:17114-17140
- [ ] MAX_OATS=64; at cap evict oldest non-initial oat (index 0 preserved) — main.js:156,17141-17149
- [ ] Initial oat via viewport-center raycast, `suppressObservation`, no story — main.js:9920-9969
- [ ] Oat power decays 1.0→⅓ over 90 s (250 ms tick); initial oat decays from creation, story oats from text reveal — main.js:178-181,17189-17246
- [ ] Frame order: startScreenUi → intro → FOV smoothing → keyboard orbit → oat decay → N sim steps → seeding → ending → agent overlay → smoothing → observation triggers → material select → render → stats — main.js:18632-18719

### 1f. Stories
- [ ] 10 stories `{title, text}`; **title never rendered** — stories.json
- [ ] Loaded once, `cache:'no-store'`; failure non-fatal → placeholder text — main.js:7062-7089
- [ ] Handed out sequentially round-robin per oat on first need; order = file order — main.js:7106-7122
- [ ] **Trigger = slime coverage near the oat**, not proximity/time: GPU score in 3-texel radius; fires at `observationSlimeTriggerThreshold` (default 0.05); polled every 220 ms, ≤4 oats/pass — main.js:157,489,7669-7740
- [ ] On trigger: `cuttlefish-reveal` plays, oat glow fades 1800 ms, text starts after — main.js:7133-7149
- [ ] Box lifecycle: glass in 2600 ms → line-by-line mask reveal (190 ms/grapheme, 1560 ms fade, next line at ⅔) → scroll roll → exit ≥2400 ms → glass out 2600 ms — main.js:5734-5755,6812-6968
- [ ] Wrapping measured in Canvas2D with real computed font; graphemes via `Intl.Segmenter` — main.js:6732-6801
- [ ] Box 230×126 px, 14 px margin, clamped on screen, above oat by `observationTailLength`×vh, z from depth, opacity × facing smoothstep(-0.14,0.2) × BVH occlusion (120 ms staggered rechecks) — main.js:5723-5731,7822-7898
- [ ] `M` key / checkbox disables story boxes — main.js:8378-8384

### 1g. Ending
- [ ] **Off by default** (`endingTimeLimitEnabled:false`) — main.js:541
- [ ] Armed on seed completion; `targetReturnAt = beginClick + 120000 ms` — main.js:5988-5994,17520-17526
- [ ] Phases preparing → gameplay → camouflage-loading → camouflage → fade; camouflage clip scheduled to **end exactly at** targetReturnAt; black fade starts 7000 ms after clip start — main.js:6445-6543,6579-6599
- [ ] Clip failure → plain 3 s fade — main.js:6468-6479
- [ ] Twin corner countdown `MM:SS.s` — main.js:5939-5951
- [ ] Restart: cancel + stop sounds → reset sim (oats reset, no spawn) → stop env + tumble (1.2 s fade) → back to start screen, begin clickable — main.js:6545-6556,5953-5986
- [ ] `game-complete.wav` is never played (only stopped) — dead; keep dead ⏸

## 2. UI surfaces

- [ ] `#app[data-panels-visible]` root toggle; `#sim` canvas `touch-action:none`, cursor always default; `#panelTouchToggle` invisible ≥60 px bottom-right hotspot (coarse pointer); `#annotationLayer`; `#endingFadeOverlay`; twin countdowns; start screen; `.panel` (top-left, ≤460 px, backdrop-blur); `#soundCheckPanel` (top-right ≤760 px); actions row Reset / Reset camera / Seed / Initial oat — index.html:229-295,821-830
- [ ] Stats: `#agentCount` `#oatCount` `#slimeCoverage` `#fps` (EMA 0.92/0.08); readback stats every 650 ms, opt-in, skipped under load; 3 history canvases (population/growth/acceleration, 180 samples) — index.html:268-295, main.js:19043-19077
- [ ] Presets: simulation `default-current`(default), `stable-medium`, `stable-compact`, `stable-loose`, `slow-growth`, `original-defaults`, +custom; render `render-default`, `pearl-bright`(default), +custom; any manual edit flips to custom — index.html:298-306, main.js:363-529,18433-18438
- [ ] Slider→param table (transplant verbatim) — main.js:18212-18253:
  - Agents: uptakeRate 0.005–0.09 · depositRate · burnRate · reproThreshold 0.2–4.5 · stepSize 0–0.003
  - Steering: foodWeight · crowdWeight · crowdExponent · densityBlur 1–64 · densityTarget · minMoveScale
  - Field: fieldDecay 0.94–1 · simulationSteps 0–8 · foodClamp · oatPower (re-syncs all oats) · oatSupplyRate · useOatRationing
  - Population: usePopulationControl (forces rationing) · populationTarget 1–262144 · populationLambda · populationSupplyLogGain · populationOatSupplyMin/Max · populationUseSecondaryActuator
  - Surface: smoothFieldDisplay · spatialSmoothing 0–10 · temporalSmoothing · surfaceHeight · surfaceBump · iridescenceStrength · slimeBaseColor (also drives `--observation-text-rgb`) · iridescenceMinThickness · iridescenceThickness · filmThicknessCurve · filmFollowsSlimeHeight · useGoldWaferFilm (lazy LUT) · useGoldWaferBody (default on) · goldBodyFade · goldBodyRoughness · goldBodyReflectivity · goldBodyColor · lightBrightness · useIcosaFaceLights (12 vs 32 lights, renormalized)
  - Story labels: storyBoxesEnabled · observationTailLength · strokeOpacity · cornerRadius · edgeFeather · blurRadius · tintColor · tintOpacity · slimeTriggerThreshold (CSS vars except threshold)
  - Visibility: endingTimeLimitEnabled · showOats · showAgentDots · meshOutlineEnabled · showWireframe
  - Debug: useSeamStitching ⏸ (v2: gutter/resolver toggles instead) · useIslandMasking ⏸ · useHeadingRotation · useOpticalZoom · statsReadbackEnabled · debugView select (v2 subset: slime/food/chart-id/seam/domain + new gutter view)
  - Camera readout + copy-pose button (150 ms refresh)
- [ ] Every control row has a focusable `?` help tip that doesn't leak events to canvas — main.js:18412-18422
- [ ] Sound-check panel built at runtime: per-clip Play/Stop, Vol (peak-safe max), Loop, fade in/out; env + slime-tumble rows toggle their schedulers; compressor section; all disabled without WebAudio — main.js:9497-9560,18565-18582
- [ ] Triple-tap corner toggles panel on phones (1200 ms window, >12 px cancels) — main.js:8331-8367
- [ ] Fades are JS smoothstep-driven opacity, not CSS transitions — main.js:6944-6947

## 3. Audio

Graph (main.js:9074-9118, 8772-8779, 9463-9481, 8842-8855):
```
one-shots: source → envelopeGain → gain ─┐
env loop:  source → xfadeGain → output ──┤
tumble:    source → xfadeGain → panner(HRTF) → distanceFilter(lowpass) → volume ├→ master → [compressor?] → destination
                      └→ {dry, reverbSend → convolver(procedural IR) → wet}─────┘
```
- [ ] Env loop: env.wav → fallback env-under-25mb.wav (404 expected, warn once); overlap-crossfade scheduler (interval = duration − 2.5 s, 12 s lookahead, 1 s pump) — main.js:8945-8971,9266-9321
- [ ] Tumble: first 8 s cropped; loop remainder with 2 s crossfade; HRTF panner (inverse model, refDistance = initial cam distance, rolloff 4.8); lowpass 18 kHz→900 Hz by smoothstepped distance, Q 0.55; procedural 3.8 s noise IR (decay 3.2, stereo, 35 ms early lift), wet 0→0.58 with distance — main.js:199-215,8545-8552,9037-9170
- [ ] **Audio position = power-weighted centroid of oats**, overridden by intro sprite, fallback initial-oat hit then controls.target — main.js:8564-8578
- [ ] Listener follows camera; both synced ≤15 Hz with position/direction epsilons — main.js:208-211,8614-8721
- [ ] One-shots: ≤16 voices/clip, oldest stolen with 25 ms fade; optional sample-accurate `startAtPerformanceMs` via `getOutputTimestamp` — main.js:216-218,8736-8770,9413-9454
- [ ] Ramps via `setTargetAtTime` 0.035 s; per-clip volume/fades clamped to peak-safe maxGain — main.js:216-221,8428-8480
- [ ] Clips used in game: intro, env, slime-appear-stretch, slime-tumble, slime-fuse, cuttlefish-reveal, cuttlefish-camouflage. Sound-check-only: slime-appear, slime-tumble-complete, text-reveal, game-complete — main.js:255-267
- [ ] Compressor off by default (−24 dB/30/12:1/3 ms/250 ms); toggling rewires master — main.js:222-236,8842-8876
- [ ] Single lazy AudioContext (+webkit fallback); unlock synchronously in Begin gesture; preloads never need a gesture; slime-fuse+intro decoded ahead of the idle batch (iOS memory-pressure lesson) — main.js:8911-8923,8988-9011

## 4. Input

- [ ] Canvas pointer: down records origin + forces repel raycast; move updates repel (45 ms); up < 4 px = oat drop; leave/cancel clears repel — main.js:18165-18208
- [ ] Orbit: pan disabled, damping 0.07, rotateSpeed 0.65, zoomSpeed 0.7; minDist 3.2, maxDist 22.4, maxPolar π/2−0.04 (never under the body) — main.js:166-168,1208-1219
- [ ] Shift = ⅓ speed on orbit + wheel — main.js:169,1352-1357
- [ ] Keyboard orbit: arrows, 120 ms response / 520 ms decay / speed 0.68; cleared on blur — main.js:170-173,1327-1371,1608-1610
- [ ] Optical zoom (default off): capture-phase wheel, exponential on tan(fov/2), scale 0.001, clamp 8°–76°, 120 ms smoothing, 0.01° snap; off → wheel scales dolly zoomSpeed — main.js:161-165,1268-1305,1584-1602
- [ ] Default camera: pos (1.893468, 5.498426, −5.633916), target origin, FOV 42.8571°, near 0.04, far 1200 — main.js:159-160,1186-1206
- [ ] Shortcuts: P panel · S skip intro · M story boxes · 1 slime layer · 2 gold layer · 3 agent dots; suppressed in form fields — main.js:8300-8399,18553-18556

## 5. Persistence / meta

- [ ] localStorage diag log; sessionStorage load counter; IndexedDB dev snapshots (field+agents raw, size-checked, `?dev&state` restore). **No gameplay/settings persistence — every reload fresh** — main.js:17998-18054
- [ ] `window.__cuttle`-equivalent dev namespace in v2 (`__v2`)
- [ ] Title "A Bestiary of Vanishings", lang en, favicon `data:,`, viewport-fit=cover + safe-area insets, `color-scheme: dark`, bg #07090a, scene clear rgb(0.004,0.006,0.005) — index.html:2-7, styles.css:2-3,52-57
- [ ] Fonts: EB Garamond (story/title) + Inter (UI) via Google Fonts, preconnect; `document.fonts.ready` re-layout — index.html:8-10, main.js:7222-7226
- [ ] No PWA manifest / OG tags (status quo) ⏸
- [ ] Deploy: GitHub Pages, static, no build step, CNAME bestiaryofvanishings.com; relative paths; manual cache-bust via BUILD_VERSION

## Standalone experiments (main game does NOT depend on them)

`slimemold.html` (2D flat-plane sandbox ancestor), `skin.html` (gold-wafer response explorer, tensor inlined), `gold_wafer_viewer.html` (PBR preview), `dev.html` + `webgpu/` (WebGPU prototype harness — see webgpu-prototype-assessment.md).
