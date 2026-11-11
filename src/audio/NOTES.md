# Audio engine notes

Verified against the old `main.js` (in this repository's history, last at commit `2622cd1`) only. Old function names are in backticks.

## Files

| file | purpose |
| --- | --- |
| `index.js` | `createAudio(ctx)`: the contract's API, each call wrapped so it cannot throw |
| `audio.config.js` | every constant: clip table, voices, loops, spatial, compressor |
| `output-graph.js` | the lazy AudioContext, master gain, optional compressor, unlock |
| `buffers.js` | fetch + decode cache |
| `clock.js` | `performance.now()` ms <-> AudioContext seconds |
| `one-shots.js` | one-shot voices, envelope, voice stealing |
| `loop-scheduler.js` | overlap-crossfade scheduler shared by both loops |
| `env-loop.js` | the ambience bed |
| `tumble-loop.js` | the cropped, crossfaded slime loop |
| `spatial-chain.js`, `reverb-impulse.js` | panner, lowpass, reverb, listener/source sync |
| `param-ramps.js` | AudioParam glide/fade helpers |
| `smoke-test.mjs` | `node src/audio/smoke-test.mjs`, fake AudioContext |

## Behaviours reproduced

- One lazy AudioContext with `webkitAudioContext` fallback, master gain at 1 -> destination (`ensureSoundCheckAudioContext`, `connectSoundOutputGraph`).
- Decode without a gesture: loading creates the context but never resumes it (`loadSoundCheckBuffer` with `resumeContext: false`). Failed loads are forgotten so a later call retries.
- Clip table: default gain, peak-safe `maxGain`, fades (`SOUND_CHECK_CLIPS`, `soundSettingsState`). Defaults: fade in 0 s, fade out 0.08 s. Non-default gains: env 2, slime-appear-stretch 2, slime-tumble 0.5, cuttlefish-reveal 0.5.
- Clips the game plays: intro, env, slime-appear-stretch, slime-tumble, slime-fuse, cuttlefish-reveal, cuttlefish-camouflage. Never played: slime-appear, slime-tumble-complete, text-reveal, game-complete (the game only ever *stops* game-complete, in `stopEndingSequenceSounds`).
- One-shot graph `source -> envelope -> volume -> master`; envelope fade-in, 0.08 s fade at the natural end; stop = linear fade then `source.stop(max(now, start) + fade + 0.02)` (`playSoundCheckOneShot`, `stopOneShotSourceRecord`).
- 16 voices per clip; a new play steals the oldest non-stopping voices with a 0.025 s fade (`trimOneShotVoicesForNewSource`).
- Sample-accurate starts through `getOutputTimestamp`, never earlier than `currentTime` (`performanceMsToAudioContextTime`, `audioContextTimeToPerformanceMs`).
- Env loop: interval = duration - 2.5 s, 12 s lookahead, 1000 ms pump, first copy 0.05 s ahead, clip gain 2 on a shared gain node, stop fade 2.5 s on each copy then `stop(now + fade + 0.02)` (`initEnvAudio`, `scheduleEnvAudioCopy`, `startEnvAudio`, `stopEnvAudio`).
- Tumble loop: 8 s crop, copies of the remainder with a 2 s fade in and out (capped at half the loop), interval = loop - crossfade, 12 s lookahead, 1000 ms pump, 0.02 s start delay, default fade-in 3460 ms on the shared fade gain, default stop fade 0.08 s (`initSlimeTumbleLoopAudio`, `scheduleSlimeTumbleLoopCopy`, `startSlimeTumbleLoop`, `stopSlimeTumbleLoop`). Starting while running only re-syncs the spatial state.
- Spatial chain `copies -> panner -> fade -> lowpass -> volume -> {dry, send -> convolver -> wet} -> master`: HRTF, inverse model, rolloff 4.8, 360 degree cones, refDistance = reference distance, maxDistance = far distance (`ensureSlimeTumbleLoopOutput`).
- Far distance = OrbitControls `maxDistance` if finite, else 2 x reference; at least reference + 0.001 (`getSlimeTumbleFarDistance`).
- Lowpass 18000 -> 900 Hz (Q 0.55) and wet 0 -> 0.58 by `smoothstep(distance, reference, far)` (`getSlimeTumbleLowpassFrequency`, `getSlimeTumbleReverbWet`).
- Procedural stereo impulse: 3.8 s of noise x `(1 - t)^3.2` x early lift (0.36 -> 1 over 35 ms) x 0.22 (`makeSlimeTumbleReverbImpulse`).
- Listener = camera position, forward and up; source = `sourcePosition`. Synced at most every 66 ms, skipping moves under 0.048 world units (0.012 x the old world scale of 4), turns under 0.0008 (1 - cos), lowpass changes under 8 Hz and wet changes under 0.00116 (`syncSlimeTumbleSpatialAudio`, `syncSlimeTumbleListener`, `syncSlimeTumblePannerPosition`). Nothing is synced until the tumble chain exists, as before.
- Two different smoothing constants: positions and orientation use `setTargetAtTime` 0.045 s with no pinning (`setAudioParamTarget`); lowpass and wet use 0.035 s after pinning the current value (`applyAudioParamValue`). The first sync when the loop starts is a jump, not a glide.
- Compressor: off; -24 dB, knee 30, ratio 12, attack 0.003 s, release 0.25 s (`SOUND_COMPRESSOR_DEFAULTS`). It is a build-time switch in `audio.config.js`.

## Deliberately different

- **env.wav is not tried.** The old `loadEnvAudioBuffer` tried `env.wav` and fell back to `env-under-25mb.wav`. Only the latter exists here, so it is loaded directly. The clip is named `env-under-25mb` (its basename); there is no `env` alias. Its `maxGain` (15.5816) was listed against the `env` entry in the old table and may have been measured on the larger file.
- **`playOneShot` is synchronous.** The old function awaited the context resume and the decode, so a cold clip played late. Here a clip that is not decoded returns `null`, logs `audio:not-ready`, and starts loading for next time. Callers that need a sound on time must `await preload([...])` first (the old intro flow already waited up to 4 s for `intro`). The two loops keep the old behaviour: they start as soon as their file has decoded.
- **A stop cancels a start that is still loading**, for both loops. The old env loop had no such guard (a stop during loading was lost, and two starts during loading could double the loop).
- **`getOutputTimestamp` is ignored unless the context is running** and the timestamp is non-zero. The old code awaited `resume()` before reading it; this module cannot await, and a zero timestamp would schedule a sound minutes late. The fallback is `currentTime + (atMs - performance.now())`.
- `referenceDistance` is read on every `update` and the panner's `refDistance`/`maxDistance` follow it. The old value was fixed at page load.
- The per-clip `restart` / `allowOverlap: false` option of `playSoundCheckOneShot` (used for the ending's camouflage sound) is gone: hold the returned handle and call `stop()` before playing again.
- The tumble volume is set once; the old re-check each sync only existed for the sound-check slider.
- Left out: the sound-check panel, runtime volume/fade/compressor setters, the audition loop flag, recorder audio.

## Decisions that now belong to the caller

- **Where the tumble source is.** The old `getSlimeTumbleSpatialAnchor` chose: the intro sprite if it exists, else the centroid of all oats weighted by `max(0.1, oat.power)`, else the initial oat's world position, else the orbit target. Pass the result as `sourcePosition`. With `null` the source stays where it was (initially the origin).
- **Preload order.** The old `scheduleSoundPackPreload` decoded `slime-fuse` and `intro` first, then the whole pack on idle (`requestIdleCallback`, 1500 ms timeout, or a 250 ms timer), because decoding the 25 MB ambience first starved the intro on iOS.
- The old Begin click unlocked the context by playing `slime-fuse` inside the gesture. Here: `unlockFromGesture()` then `playOneShot('slime-fuse')`.

## Where the old code contradicted the earlier checklist

- The checklist's graph omits the tumble's shared fade gain and puts the reverb split in the wrong place. The split is after the volume gain, and the panner comes first.
- "Ramps via setTargetAtTime 0.035 s" is only half of it: spatial positions use 0.045 s.
- The env "crossfade" is one-sided: a new copy enters at full gain while the old one fades out. Only the tumble copies fade both ways.
- The checklist lists game-complete as sound-check-only without noting that the ending still stops it.

## Unsure / not verified

- The smoke test checks wiring and scheduling arithmetic against a fake context. The artist has since listened to the deployed game on desktop and on an iPhone 13 Pro Max and reported that sound works (2026-11-10); nobody has compared levels or timing against the old game by measurement, and real `getOutputTimestamp` behaviour on iOS was not examined beyond that.
- `playOneShot`'s `volume` is treated as an absolute gain replacing the clip default, clamped to `0..maxGain`. The old game never passed a per-play volume, so this meaning is a guess.
- Listener "up" is the camera's world-matrix Y column. The old code rotated `camera.up` by the camera quaternion, which is the same thing only while `camera.up` is (0, 1, 0) and the camera has no rotated parent.

## Beyond the contract

- `ctx.cameraRig.controls.maxDistance` is read (optionally) as the far distance.
- `ctx.camera` is used as the listener until `update` supplies one.
- The handle from `playOneShot` also carries `startedAtMs`, the old `startedAtPerformanceMs`, which the ending used to time its fade.
