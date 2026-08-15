// Offline soundtrack reconstruction for replay renders.
//
// Two halves:
//
//   createAudioRecorder({ api })     capture sound-trigger INTENTS during a
//                                    controlled (virtual-clock) pass
//   renderSessionAudio({ ... })      rebuild the mix in an OfflineAudioContext
//                                    and hand encode.js an AudioBuffer
//
// ---------------------------------------------------------------------------
// WHY NOT JUST CALL main.js's AUDIO FUNCTIONS?
//
// Every scheduler in main.js reads module singletons —  soundCheckAudioState
// .context / .output (main.js:8143-8150), envAudioState (8152-8163),
// slimeTumbleLoopState (8165-8199) — and anchors automation to
// `context.currentTime` of the ONE live AudioContext created in
// ensureSoundCheckAudioContext (main.js:8911-8923). They cannot be pointed at
// an OfflineAudioContext, so this file contains standalone builders that
// re-implement the same graphs. Every builder cites the main.js lines it
// mirrors; if those change, these must change with them.
//
// ---------------------------------------------------------------------------
// THE SEAM
//
// All game sound reaches the speakers through exactly one call:
// `AudioBufferSourceNode.prototype.start`. One-shots (main.js:9487), env-bed
// copies (main.js:9284) and slime-tumble loop copies (main.js:9152) all funnel
// through it. That is the ONE seam this recorder hooks.
//
// It cannot be `__cuttle.audio.playSoundCheckOneShot`: main.js's own callers
// (6097, 6130, 6522, 7127, 17601) call the module-local binding, not the
// object property, so wrapping the exported reference records nothing.
//
// The three start() arg counts classify the stream with no ambiguity:
//     1 arg  -> playSoundCheckOneShot          `source.start(startTime)`
//     2 args -> scheduleEnvAudioCopy           `source.start(startTime, 0)`
//     3 args -> scheduleSlimeTumbleLoopCopy    `source.start(t, 8, loopDur)`
//
// ---------------------------------------------------------------------------
// TRAPS HANDLED HERE (all verified against main.js)
//
// 1. performanceMsToAudioContextTime (main.js:8749-8760) calls
//    getOutputTimestamp(), whose `performanceTime` comes from the REAL clock,
//    while `startAtPerformanceMs` (intro 6130, camouflage 6522, reveal 7127,
//    tumble start 17544) is a VIRTUAL timestamp from the shimmed
//    performance.now(). Subtracting one from the other is garbage, and the
//    `Math.max(context.currentTime, ...)` clamp then silently collapses every
//    scheduled lead to zero — the intro music would land ~2.8 s early.
//    installAudioProbe() shims getOutputTimestamp to report
//    { contextTime: ctx.currentTime, performanceTime: performance.now() }, so
//    the mapping is consistent with whichever clock is installed. The recorded
//    lead is then exact.
//
// 2. Media time is tick/simHz, never tick/outputFps. A 900-tick recording is
//    15 s of audio whether it was rendered at 24, 30 or 60 fps.
//
// 3. env.wav 404s (it is not in shen-soundpack/wav/); loadEnvAudioBuffer
//    (main.js:8945-8971) falls back to env-under-25mb.wav. The DECODED
//    DURATION drives envAudioState.interval (main.js:9033) and therefore every
//    loop boundary, so the resolved path is load-bearing. resolveEnvPath()
//    below asks the live game which path it actually landed on and verifies it
//    before falling back.
//
// 4. decodeAudioData resamples to the DECODING context's rate. main.js's
//    context is `new AudioContextCtor()` with no sampleRate option
//    (main.js:8915), so live buffers may be 44100. Everything here is decoded
//    by the OfflineAudioContext itself, so all buffers are already at the
//    render rate and no cross-rate arithmetic exists.
//
// 5. applyAudioParamValue (main.js:8723-8735) and setAudioParamTarget
//    (8580-8589) read `audioParam.value` and `context.currentTime` of the live
//    context. During an offline render those are meaningless and FAIL
//    SILENTLY: renderSceneOnce calls syncSlimeTumbleSpatialAudio() with no
//    args (main.js:18791), which passes its 66 ms performance.now() throttle
//    (8674-8681) against VIRTUAL time and then writes automation onto a live
//    graph nobody is listening to. Harmless, and deliberately ignored — this
//    module never reads the live graph's parameter values, only the plain
//    numbers behind them (getSlimeTumbleLoopState(), main.js:9651-9682).
//
// 6. Tracks must be declared before output.start() in Mediabunny. encode.js
//    already handles that via `withAudio: true`; the AudioBuffer produced here
//    is fed to enc.addAudio() after the video pass.
//
// ---------------------------------------------------------------------------
// SCOPE — L1.5. WHAT IS OMITTED, DELIBERATELY
//
//   * NO HRTF / PannerNode. The live tumble loop runs through a PannerNode
//     (main.js:9078-9092, panningModel 'HRTF', distanceModel 'inverse') whose
//     position is re-targeted every ~66 ms from the camera. Here the panner is
//     replaced by a single static gain equal to
//     getSlimeTumblePannerDistanceGain() sampled once at loop start, so the
//     loop keeps its correct loudness but is MONO-CENTRED with no stereo
//     image and no movement.
//   * NO per-tick tone automation. lowpass frequency (8549-8552) and reverb
//     wet (8545-8547) are sampled ONCE at loop start and held. In game they
//     glide with camera distance.
//   * NO listener orientation (syncSlimeTumbleListener, 8628-8661).
//   * slimeTumbleLoopState.referenceDistance is captured once at module init
//     (main.js:8187) from the STARTING camera pose, so the distance curve is
//     already pinned to boot state in the live game too — sampling the derived
//     values once is closer to the live behaviour than it sounds.
//   * The reverb impulse (main.js:9059-9072) uses Math.random at line 9068.
//     Here it is generated from a seeded PRNG so renders are reproducible.
//     Different noise, identical envelope/decay/length.
//   * One-shot voice stealing (trimOneShotVoicesForNewSource, 9413-9422) is
//     not modelled; 16 voices per clip is far above anything the game fires.
//   * stopSoundCheckOneShot / mid-flight one-shot cancellation is not
//     modelled. Only the ending's tumble+env stops are.
//
// ---------------------------------------------------------------------------

// ===========================================================================
// Constants mirrored from main.js. Cited line numbers are from the commit this
// module was written against.
// ===========================================================================

// main.js:193-219
export const ENV_AUDIO_PATH = 'shen-soundpack/wav/env.wav';
export const ENV_AUDIO_FALLBACK_PATH = 'shen-soundpack/wav/env-under-25mb.wav';
const ENV_AUDIO_CROSSFADE_SECONDS = 2.5;
const ENV_AUDIO_START_DELAY_SECONDS = 0.05;
const SLIME_TUMBLE_AUDIO_PATH = 'shen-soundpack/wav/slime-tumble.wav';
const SLIME_TUMBLE_LOOP_START_SECONDS = 8;
const SLIME_TUMBLE_LOOP_CROSSFADE_SECONDS = 2;
const SLIME_TUMBLE_REVERB_SECONDS = 3.8;
const SLIME_TUMBLE_REVERB_DECAY = 3.2;
const SLIME_TUMBLE_LOWPASS_NEAR_HZ = 18000;
const SLIME_TUMBLE_LOWPASS_Q = 0.55;
const SOUND_FADE_SECONDS_MAX = 30;
const SOUND_DEFAULT_FADE_IN_SECONDS = 0;
const SOUND_DEFAULT_FADE_OUT_SECONDS = 0.08;

// main.js:245 — beginInitialAgentSeeding passes durationMs/1000 as the tumble
// loop's fade-in (main.js:17544-17546). Used only as a last-resort default;
// the recorder reads the real value from getInitialAgentSeedState().
const INITIAL_AGENT_SEED_DURATION_MS = 3460;

// main.js:222-228
const SOUND_COMPRESSOR_DEFAULTS = Object.freeze({
  enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25,
});

// main.js:255-267 — SOUND_CHECK_CLIPS, verbatim.
export const SOUND_CLIPS = Object.freeze([
  { id: 'intro', path: 'shen-soundpack/wav/intro.wav', loop: false, maxGain: 2.1809 },
  { id: 'env', path: ENV_AUDIO_PATH, loop: true, gain: 2, maxGain: 15.5816, fadeOutSeconds: ENV_AUDIO_CROSSFADE_SECONDS },
  { id: 'slime-appear', path: 'shen-soundpack/wav/slime-appear.wav', loop: false, maxGain: 3.4979 },
  { id: 'slime-appear-stretch', path: 'shen-soundpack/wav/slime-appear-stretch.wav', loop: false, gain: 2, maxGain: 4.1431 },
  { id: 'slime-tumble', path: SLIME_TUMBLE_AUDIO_PATH, loop: false, gain: 0.5, maxGain: 1.9959 },
  { id: 'slime-tumble-complete', path: 'shen-soundpack/wav/slime-tumble-complete.wav', loop: false, maxGain: 3.0304 },
  { id: 'slime-fuse', path: 'shen-soundpack/wav/slime-fuse.wav', loop: false, maxGain: 1.7083 },
  { id: 'cuttlefish-reveal', path: 'shen-soundpack/wav/cuttlefish-reveal.wav', loop: false, gain: 0.5, maxGain: 2.2347 },
  { id: 'cuttlefish-camouflage', path: 'shen-soundpack/wav/cuttlefish-camouflage.wav', loop: false, maxGain: 1.6634 },
  { id: 'text-reveal', path: 'shen-soundpack/wav/text-reveal.wav', loop: false, maxGain: 5.2462 },
  { id: 'game-complete', path: 'shen-soundpack/wav/game-complete.wav', loop: false, maxGain: 2.4264 },
]);

// ===========================================================================
// Small helpers
// ===========================================================================

/** main.js:8201-8205 */
function clampFinite(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

const clipById = new Map(SOUND_CLIPS.map((c) => [c.id, c]));

/** main.js:8219-8238 — the settings a clip starts with, before UI edits. */
function defaultSettings(clip) {
  const maxVolume = Math.max(0.01, Number(clip?.maxGain) || 1);
  return {
    volume: clampFinite(clip?.gain ?? 1, 0, maxVolume, Math.min(1, maxVolume)),
    maxVolume,
    loop: Boolean(clip?.loop),
    fadeInSeconds: clampFinite(clip?.fadeInSeconds ?? SOUND_DEFAULT_FADE_IN_SECONDS, 0, SOUND_FADE_SECONDS_MAX, SOUND_DEFAULT_FADE_IN_SECONDS),
    fadeOutSeconds: clampFinite(clip?.fadeOutSeconds ?? SOUND_DEFAULT_FADE_OUT_SECONDS, 0, SOUND_FADE_SECONDS_MAX, SOUND_DEFAULT_FADE_OUT_SECONDS),
  };
}

/**
 * Live settings if the game is reachable, defaults otherwise.
 * `__cuttle.audio.soundSettings` IS main.js's soundSettingsState Map, so this
 * picks up any volume/fade the sound-check panel changed mid-session.
 */
function soundSettings(api, soundId) {
  const fallback = defaultSettings(clipById.get(soundId));
  try {
    const live = api?.()?.audio?.soundSettings?.get?.(soundId);
    if (live) return { ...fallback, ...live };
  } catch { /* game not up; defaults are correct */ }
  return fallback;
}

/** Deterministic stand-in for Math.random in the reverb impulse. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Coarse RMS-envelope fingerprint, sampled in NORMALISED TIME so it survives
 * the 44100-vs-48000 decode-rate difference between the live context and the
 * offline one. Only used when exact URL tagging was unavailable.
 */
const FINGERPRINT_WINDOWS = 32;
function bufferFingerprint(buffer) {
  const out = new Array(FINGERPRINT_WINDOWS).fill(0);
  if (!buffer || !buffer.length) return out;
  let data;
  try { data = buffer.getChannelData(0); } catch { return out; }
  const n = data.length;
  let peak = 0;
  for (let w = 0; w < FINGERPRINT_WINDOWS; w++) {
    const a = Math.floor((n * w) / FINGERPRINT_WINDOWS);
    const b = Math.max(a + 1, Math.floor((n * (w + 1)) / FINGERPRINT_WINDOWS));
    const stride = Math.max(1, Math.floor((b - a) / 96));
    let sum = 0; let count = 0;
    for (let i = a; i < b; i += stride) { sum += data[i] * data[i]; count++; }
    const rms = Math.sqrt(sum / Math.max(1, count));
    out[w] = rms;
    if (rms > peak) peak = rms;
  }
  if (peak > 0) for (let w = 0; w < FINGERPRINT_WINDOWS; w++) out[w] /= peak;
  return out;
}

function fingerprintDistance(a, b) {
  if (!a || !b) return Infinity;
  let d = 0;
  for (let i = 0; i < FINGERPRINT_WINDOWS; i++) d += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return d / FINGERPRINT_WINDOWS;
}

const clipIdForUrl = (url) => {
  if (!url) return null;
  const clean = String(url).split('?')[0];
  return SOUND_CLIPS.find((c) => clean.endsWith(c.path))?.id
    // env falls back to a different file than the clip registry lists.
    ?? (clean.endsWith(ENV_AUDIO_FALLBACK_PATH) ? 'env' : null);
};

// ===========================================================================
// The probe.
//
// installAudioProbe() SHOULD run before main.js evaluates (same rule as
// clock.js), because the decode tagging can only see decodes that happen after
// it is installed and scheduleSoundPackPreload (main.js:8998-9022) decodes the
// whole pack during boot. If it is installed late, clip identity falls back to
// duration + envelope fingerprint, resolved at render time.
// ===========================================================================

const probe = {
  installed: false,
  urlForBytes: new WeakMap(),   // ArrayBuffer -> request URL
  pathForBuffer: new WeakMap(), // AudioBuffer -> request URL
  sink: null,                   // the active recorder, if any
  originals: null,
  alignClock: true,
};

/** Is this an offline (rendering) context? Those are OURS — never record them. */
const isOfflineContext = (ctx) => Boolean(ctx && typeof ctx.startRendering === 'function');

export function installAudioProbe({ alignClock = true } = {}) {
  if (probe.installed) return probe;
  probe.installed = true;
  probe.alignClock = alignClock;

  const originals = {};
  probe.originals = originals;

  // --- 1. fetch: remember which URL produced which ArrayBuffer -------------
  // loadSoundCheckBuffer (main.js:8925-8943) does fetch(path) ->
  // response.arrayBuffer() -> context.decodeAudioData(arrayBuffer). Tagging
  // the ArrayBuffer here is what makes clip identity EXACT rather than
  // heuristic.
  if (typeof window.fetch === 'function') {
    originals.fetch = window.fetch;
    window.fetch = function patchedFetch(...args) {
      // .call(window, ...) — a detached `fetch` reference is an illegal
      // invocation in some engines.
      return originals.fetch.call(window, ...args).then((res) => {
        try {
          const url = res?.url || String(args[0] ?? '');
          if (/\.wav(\?|$)/i.test(url) && typeof res?.arrayBuffer === 'function') {
            const origArrayBuffer = res.arrayBuffer.bind(res);
            // Own-property shadow of the prototype method; the Response is
            // otherwise untouched.
            res.arrayBuffer = () => origArrayBuffer().then((ab) => {
              try { probe.urlForBytes.set(ab, url); } catch { /* non-object key */ }
              return ab;
            });
          }
        } catch { /* never break a fetch over bookkeeping */ }
        return res;
      });
    };
  }

  // --- 2. decodeAudioData: carry the tag onto the decoded AudioBuffer ------
  const BaseCtx = window.BaseAudioContext ?? window.AudioContext;
  if (BaseCtx?.prototype?.decodeAudioData) {
    originals.decodeAudioData = BaseCtx.prototype.decodeAudioData;
    BaseCtx.prototype.decodeAudioData = function patchedDecode(data, onOk, onErr) {
      // Read the tag BEFORE the call: decodeAudioData detaches `data`.
      let url = null;
      try { url = probe.urlForBytes.get(data) ?? null; } catch { url = null; }
      const tag = (buffer) => {
        try { if (buffer && url) probe.pathForBuffer.set(buffer, url); } catch { /* ignore */ }
        return buffer;
      };
      const wrappedOk = typeof onOk === 'function' ? (buf) => onOk(tag(buf)) : onOk;
      const result = originals.decodeAudioData.call(this, data, wrappedOk, onErr);
      // Modern browsers return a promise as well as honouring the callbacks.
      return result && typeof result.then === 'function' ? result.then(tag) : result;
    };
  }

  // --- 3. getOutputTimestamp: keep perf<->ctx mapping on the SAME clock ----
  // Trap #1 in the header. Without this the whole scheduled-lead mechanism in
  // performanceMsToAudioContextTime (main.js:8749-8760) collapses under the
  // virtual clock. In live mode this only trades the ~10-20 ms output latency
  // for zero, which is inaudible; the probe is dev-only anyway.
  if (alignClock && window.AudioContext?.prototype) {
    originals.getOutputTimestamp = window.AudioContext.prototype.getOutputTimestamp;
    window.AudioContext.prototype.getOutputTimestamp = function patchedTimestamp() {
      return { contextTime: this.currentTime, performanceTime: performance.now() };
    };
  }

  // --- 4. resume: never stall the trigger chain ---------------------------
  // playSoundCheckOneShot awaits ensureSoundCheckAudioContext (main.js:9445),
  // which awaits context.resume() (8919-8921). An automated ?render load has
  // no user gesture, so under the autoplay policy that promise can hang
  // forever and NO sound event is ever produced. Resolving immediately lets
  // the rest of the chain run and reach source.start(); the context staying
  // suspended is fine because nothing here reads its currentTime as an
  // absolute — only as the origin a lead is measured from.
  if (window.AudioContext?.prototype?.resume) {
    originals.resume = window.AudioContext.prototype.resume;
    window.AudioContext.prototype.resume = function patchedResume() {
      try { originals.resume.call(this).catch(() => {}); } catch { /* ignore */ }
      return Promise.resolve();
    };
  }

  // --- 5. THE SEAM --------------------------------------------------------
  const SourceProto =
    (window.AudioBufferSourceNode?.prototype
      && Object.prototype.hasOwnProperty.call(window.AudioBufferSourceNode.prototype, 'start')
      ? window.AudioBufferSourceNode.prototype
      : window.AudioScheduledSourceNode?.prototype) ?? null;
  if (SourceProto) {
    probe.sourceProto = SourceProto;
    originals.start = SourceProto.start;
    SourceProto.start = function patchedStart(...args) {
      const result = originals.start.apply(this, args);
      // Report only after the real start() succeeded, so a rejected schedule
      // never leaves a phantom event.
      try {
        if (probe.sink && !isOfflineContext(this.context)) {
          probe.sink.onSourceStart(this, args);
        }
      } catch (err) {
        console.warn('[replay/audio] seam failed', err);
      }
      return result;
    };
  }

  return probe;
}

export function uninstallAudioProbe() {
  if (!probe.installed) return;
  const o = probe.originals ?? {};
  if (o.fetch) window.fetch = o.fetch;
  const BaseCtx = window.BaseAudioContext ?? window.AudioContext;
  if (o.decodeAudioData && BaseCtx) BaseCtx.prototype.decodeAudioData = o.decodeAudioData;
  if (window.AudioContext && 'getOutputTimestamp' in o) {
    // The original may legitimately be undefined (older engines) — in that
    // case remove the shim rather than reinstating `undefined` as a method.
    if (o.getOutputTimestamp) window.AudioContext.prototype.getOutputTimestamp = o.getOutputTimestamp;
    else delete window.AudioContext.prototype.getOutputTimestamp;
  }
  if (o.resume && window.AudioContext) window.AudioContext.prototype.resume = o.resume;
  if (o.start && probe.sourceProto) probe.sourceProto.start = o.start;
  probe.installed = false;
  probe.sink = null;
  probe.originals = null;
}

// ===========================================================================
// Recorder
// ===========================================================================

/** A rising edge on a loop's `running` flag with no start() seen is suspicious. */
const LOOP_START_GRACE_TICKS = 45;

/**
 * Capture sound-trigger intents through the single AudioBufferSourceNode.start
 * seam, stamped with the tick they belong to and the lead they were scheduled
 * with.
 *
 * Usage mirrors createRecorder in recorder.js:
 *
 *     const arec = createAudioRecorder({ api });
 *     arec.hook();
 *     for (...) { arec.sample(tick); step(dtMs); }
 *     arec.unhook();
 *     const audio = await renderSessionAudio({ api, events: arec.events, ... });
 *
 * TICK ATTRIBUTION CAVEAT — read this.
 *
 * playSoundCheckOneShot is `async` and awaits the context and the decoded
 * buffer (main.js:9445-9448) before it reaches source.start(). Microtasks only
 * drain when the JS stack empties, so inside a fully synchronous stepping loop
 * (`for (t...) { step(dtMs); }` with no await) EVERY continuation is deferred
 * past the end of the loop and every one-shot would be stamped with the last
 * tick. Two mitigations, in order of importance:
 *
 *   a) The driver must yield once per output frame — replayToVideo already
 *      does (`await enc.addFrame(f)`), recordSession does NOT (see the
 *      integration notes).
 *   b) Absolute time is `tick/simHz + leadMs/1000`, and BOTH halves are read
 *      at the same instant. So for any trigger that carries an explicit
 *      startAtPerformanceMs — intro (6130), ending camouflage (6522), oat
 *      reveal (7127), tumble loop start (17544) — a deferred continuation
 *      still resolves to the correct ABSOLUTE time, because the lead grows by
 *      exactly as much as the tick stamp slipped. Only the two fire-and-forget
 *      triggers (slime-fuse start click at 6097, slime-appear-stretch at
 *      17601) depend on (a).
 */
const MAX_PLAUSIBLE_LEAD_MS = 3500;

export function createAudioRecorder({ api, simHz = 60 } = {}) {
  let clampedLeads = 0;
  const state = {
    tick: 0,
    events: [],
    hooked: false,
    // loop run tracking
    envRunning: false,
    envStartRecorded: false,
    envRunningSinceTick: -1,
    tumbleRunning: false,
    tumbleStartRecorded: false,
    tumbleRunningSinceTick: -1,
    unresolved: 0,
  };

  const call = (fn, fallback = null) => {
    try { return fn(); } catch { return fallback; }
  };

  function clipInfo(buffer) {
    const url = call(() => probe.pathForBuffer.get(buffer) ?? null);
    if (url) return { clipId: clipIdForUrl(url), path: url, idMethod: 'url' };
    // Probe installed late (after the sound pack decoded). Record enough for
    // renderSessionAudio to identify the clip against its own decodes.
    // NOTE: duration alone is NOT sufficient — slime-appear/slime-fuse and
    // intro/game-complete are pairwise identical in length.
    return {
      clipId: null,
      path: null,
      idMethod: 'fingerprint',
      signature: {
        durationSeconds: buffer?.duration ?? 0,
        sampleRate: buffer?.sampleRate ?? 0,
        channels: buffer?.numberOfChannels ?? 0,
        fingerprint: bufferFingerprint(buffer),
      },
    };
  }

  function push(event) {
    state.events.push(event);
    return event;
  }

  function onSourceStart(node, args) {
    const ctx = node.context;
    const ctxNow = Number.isFinite(ctx?.currentTime) ? ctx.currentTime : 0;
    const when = Number.isFinite(args[0]) ? args[0] : ctxNow;
    // Lead is measured against the SAME context clock the game measured it
    // against, so the getOutputTimestamp shim makes this the virtual lead.
    let leadMs = Math.max(0, (when - ctxNow) * 1000);

    // Clamp implausible leads.
    //
    // The lead is measured on the AudioContext clock, which advances in REAL
    // time, while the sim advances on the virtual clock. During an offline
    // render those two drift apart, so a schedule that was "0.1s from now" in
    // the game reads as several seconds of lead here and the cue lands far too
    // late in the movie. Observed: the slime-tumble loop picking up 11.8s of
    // lead on a 15s render.
    //
    // The largest lead the game legitimately uses is the intro's
    // INTRO_START_CLICK_SOUND_PEAK_MS-derived ~2.83s, so anything past 3.5s is
    // a clock-domain artefact rather than intent. Clamp it and count it, so a
    // wrong mix shows up in status.json instead of just sounding odd.
    if (leadMs > MAX_PLAUSIBLE_LEAD_MS) {
      clampedLeads++;
      leadMs = 0;
    }
    const info = clipInfo(node.buffer);

    // arg count classifies the stream; see the header.
    const argc = args.length;
    if (argc >= 3) return onTumbleCopy(info, leadMs, args);
    if (argc === 2) return onEnvCopy(info, leadMs);
    return onOneShot(info, leadMs, node);
  }

  function onOneShot(info, leadMs, node) {
    const clipId = info.clipId;
    const settings = clipId ? soundSettings(api, clipId) : null;
    if (!clipId) state.unresolved++;
    push({
      type: 'oneshot',
      tick: state.tick,
      leadMs,
      clipId,
      path: info.path,
      idMethod: info.idMethod,
      signature: info.signature,
      gain: settings?.volume ?? null,
      fadeInSeconds: settings?.fadeInSeconds ?? null,
      fadeOutSeconds: settings?.fadeOutSeconds ?? null,
      // `audition` loops only happen from the sound-check panel (main.js:9455).
      loop: Boolean(node.loop),
    });
  }

  function onEnvCopy(info, leadMs, opts = {}) {
    // Only the FIRST copy of a run is kept. The rest are regenerated offline:
    // the live pump is a wall-clock setInterval (main.js:9319) whose firing
    // pattern has nothing to do with media time, and under a synchronous
    // stepping loop it never fires at all — only the copies scheduled inside
    // startEnvAudio's 12 s lookahead exist.
    if (state.envStartRecorded) return;
    state.envStartRecorded = true;
    state.envRunning = true;
    const settings = soundSettings(api, 'env');
    push({
      type: 'env-start',
      tick: state.tick,
      leadMs,                    // includes ENV_AUDIO_START_DELAY_SECONDS (9317)
      clipId: 'env',
      path: info.path,
      idMethod: info.idMethod,
      gain: settings.volume,
      fadeInSeconds: opts.preexisting ? 0 : settings.fadeInSeconds,
      fadeOutSeconds: settings.fadeOutSeconds,
      preexisting: !!opts.preexisting,
    });
  }

  function onTumbleCopy(info, leadMs, args, opts = {}) {
    if (state.tumbleStartRecorded) return;
    state.tumbleStartRecorded = true;
    state.tumbleRunning = true;
    const settings = soundSettings(api, 'slime-tumble');
    // Sampled ONCE, here: the L1.5 static tone. See getSlimeTumbleLoopState,
    // main.js:9651-9682.
    const live = call(() => api()?.audio?.getSlimeTumbleLoopState?.(), null) ?? {};
    // startSlimeTumbleLoop's fade-in is beginInitialAgentSeeding's durationMs
    // (main.js:17544-17546), not the panel's fade setting.
    const seedMs = call(() => api()?.getInitialAgentSeedState?.()?.durationMs, null);
    push({
      type: 'tumble-start',
      tick: state.tick,
      leadMs,
      clipId: 'slime-tumble',
      path: info.path,
      idMethod: info.idMethod,
      gain: Number.isFinite(live.baseVolume) ? live.baseVolume : settings.volume,
      fadeInSeconds: (Number.isFinite(seedMs) && seedMs > 0 ? seedMs : INITIAL_AGENT_SEED_DURATION_MS) / 1000,
      fadeOutSeconds: settings.fadeOutSeconds,
      loopStartSeconds: Number.isFinite(args[1]) ? args[1] : SLIME_TUMBLE_LOOP_START_SECONDS,
      // static tone, sampled at loop start
      lowpassHz: Number.isFinite(live.lowpassHz) ? live.lowpassHz : SLIME_TUMBLE_LOWPASS_NEAR_HZ,
      reverbWet: Number.isFinite(live.reverbWet) ? live.reverbWet : 0,
      pannerDistanceGain: Number.isFinite(live.pannerDistanceGain) ? live.pannerDistanceGain : 1,
      cameraDistance: Number.isFinite(live.cameraDistance) ? live.cameraDistance : null,
      referenceDistance: Number.isFinite(live.referenceDistance) ? live.referenceDistance : null,
    });
  }

  /**
   * Per-tick poll. Catches what the start() seam cannot see: the loops being
   * STOPPED (stopEnvAudio 9323, stopSlimeTumbleLoop 9225, both called from
   * completeEndingSequence at 6552-6553), and — as a safety net — a loop that
   * came up without the seam observing a copy.
   */
  function sample(tick) {
    if (Number.isFinite(tick)) state.tick = tick;
    else state.tick++;
    if (!state.hooked) return;

    const env = call(() => api()?.audio?.getEnvAudioState?.(), null);
    if (env) trackLoop('env', Boolean(env.running));
    const tumble = call(() => api()?.audio?.getSlimeTumbleLoopState?.(), null);
    if (tumble) trackLoop('tumble', Boolean(tumble.running));
  }

  function trackLoop(kind, running) {
    const isEnv = kind === 'env';
    const wasRunning = isEnv ? state.envRunning : state.tumbleRunning;
    const started = isEnv ? state.envStartRecorded : state.tumbleStartRecorded;

    if (running && !wasRunning) {
      if (isEnv) state.envRunningSinceTick = state.tick;
      else state.tumbleRunningSinceTick = state.tick;
    }

    // Safety net: running for a while, but the seam never reported a copy
    // (probe installed mid-run, or a browser without the patched prototype).
    if (running && !started) {
      const since = isEnv ? state.envRunningSinceTick : state.tumbleRunningSinceTick;
      if (since >= 0 && state.tick - since >= LOOP_START_GRACE_TICKS) {
        if (isEnv) onEnvCopy({ clipId: 'env', path: null, idMethod: 'synthetic' }, 0);
        else onTumbleCopy({ clipId: 'slime-tumble', path: null, idMethod: 'synthetic' }, 0, []);
        const last = state.events[state.events.length - 1];
        if (last) { last.synthetic = true; last.tick = since; }
      }
    }

    if (!running && wasRunning && started) {
      const settings = soundSettings(api, isEnv ? 'env' : 'slime-tumble');
      push({
        type: isEnv ? 'env-stop' : 'tumble-stop',
        tick: state.tick,
        leadMs: 0,
        clipId: isEnv ? 'env' : 'slime-tumble',
        // stopEnvAudio uses getSoundFadeOutSeconds('env') = 2.5 (9330);
        // completeEndingSequence overrides the tumble's to 1.2 (main.js:6553),
        // which is NOT observable from here — see uncertainties.
        fadeOutSeconds: isEnv ? settings.fadeOutSeconds : 1.2,
      });
      if (isEnv) { state.envStartRecorded = false; state.envRunningSinceTick = -1; }
      else { state.tumbleStartRecorded = false; state.tumbleRunningSinceTick = -1; }
    }

    if (isEnv) state.envRunning = running;
    else state.tumbleRunning = running;
  }

  const recorder = {
    onSourceStart,
    get events() { return state.events; },
    get tick() { return state.tick; },
    get hooked() { return state.hooked; },

    hook() {
      if (state.hooked) return recorder;
      installAudioProbe();
      probe.sink = recorder;
      state.hooked = true;
      // Both beds are ALREADY RUNNING by the time we hook.
      //
      // Every render path uses ?dev, and DEV_MODE boot calls skipIntroSequence()
      // -> startEnvAudio() and replayInitialAgentSeed() ->
      // beginInitialAgentSeeding() -> startSlimeTumbleLoop(). Boot takes ~45s,
      // so by the time the render pass hooks, both loops have been running for
      // a long time and their wall-clock pumps (window.setInterval, which the
      // clock shim does not touch) are scheduling copies up to 12s ahead.
      //
      // If we wait for a rising edge, the first thing the seam sees is one of
      // those mid-run pump copies, which gets misclassified as the loop START
      // and carries a ~12s scheduling lead — putting the ambience bed past the
      // end of a 15s render, and sorting after its own stop so it never stops.
      //
      // So treat "already running at hook time" as an explicit pre-existing run:
      // emit the start at tick 0 with no lead and no fade-in, because the fade
      // already completed off-camera. Copies arriving later for a run that is
      // already open are then ignored rather than latching a bogus start.
      const env = call(() => api()?.audio?.getEnvAudioState?.(), null);
      state.envRunning = Boolean(env?.running);
      state.envRunningSinceTick = state.envRunning ? state.tick : -1;
      if (state.envRunning) {
        onEnvCopy({ clipId: 'env', idMethod: 'preexisting' }, 0, { preexisting: true });
      }

      const tumble = call(() => api()?.audio?.getSlimeTumbleLoopState?.(), null);
      state.tumbleRunning = Boolean(tumble?.running);
      state.tumbleRunningSinceTick = state.tumbleRunning ? state.tick : -1;
      if (state.tumbleRunning) {
        onTumbleCopy({ clipId: 'slime-tumble', idMethod: 'preexisting' }, 0, [0, 0, 0], { preexisting: true });
      }
      return recorder;
    },

    unhook() {
      if (!state.hooked) return recorder;
      if (probe.sink === recorder) probe.sink = null;
      state.hooked = false;
      return recorder;
    },

    sample,

    reset() {
      state.events = [];
      state.tick = 0;
      state.envStartRecorded = false;
      state.tumbleStartRecorded = false;
      state.unresolved = 0;
    },

    stats() {
      const byType = {};
      for (const e of state.events) byType[e.type] = (byType[e.type] ?? 0) + 1;
      return {
        events: state.events.length,
        byType,
        unresolvedClips: state.unresolved,
        simHz,
        // >0 means cues carried an implausible scheduling lead (AudioContext
        // time advancing in real time while the sim runs on the virtual clock)
        // and were pulled back to their tick. Non-zero is a correctness smell,
        // not a crash — the mix is still usable, just less precisely placed.
        clampedLeads,
        // A run with zero events usually means the seam never fired, i.e. the
        // AudioContext never came up. Worth surfacing loudly.
        looksEmpty: state.events.length === 0,
      };
    },

    toJSON() {
      return { simHz, events: state.events };
    },
  };

  return recorder;
}

// ===========================================================================
// Offline render
// ===========================================================================

/** Automation times must be >= 0 in an OfflineAudioContext. */
const T = (t) => Math.max(0, t);

async function fetchDecode(ctx, path) {
  const url = new URL(path, document.baseURI).href;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const bytes = await res.arrayBuffer();
  // Decoded BY the OfflineAudioContext, so every buffer is already at the
  // render sample rate. This is what defuses the 44100/48000 trap.
  return ctx.decodeAudioData(bytes);
}

/**
 * env.wav is not in the repo; loadEnvAudioBuffer (main.js:8945-8971) 404s and
 * falls back. Ask the live game which path it landed on, but verify — the
 * `path` field starts life as the primary (main.js:8153) and is only rewritten
 * after a successful load, so a session that never played ambience reports a
 * path that does not exist.
 */
async function loadEnvBuffer(ctx, api) {
  const reported = (() => {
    try { return api?.()?.audio?.getEnvAudioState?.()?.path ?? null; } catch { return null; }
  })();
  const candidates = [...new Set([reported, ENV_AUDIO_PATH, ENV_AUDIO_FALLBACK_PATH].filter(Boolean))];
  const errors = [];
  for (const path of candidates) {
    try { return { path, buffer: await fetchDecode(ctx, path) }; }
    catch (err) { errors.push(`${path}: ${err.message}`); }
  }
  throw new Error(`no usable ambience file (${errors.join('; ')})`);
}

/** main.js:9059-9072, with Math.random (line 9068) replaced by a seeded PRNG. */
function makeTumbleReverbImpulse(ctx, seed = 0x5EED1E) {
  const rnd = mulberry32(seed);
  const length = Math.max(1, Math.floor(ctx.sampleRate * SLIME_TUMBLE_REVERB_SECONDS));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const t = i / Math.max(1, length - 1);
      const envelope = Math.pow(1 - t, SLIME_TUMBLE_REVERB_DECAY);
      const earlyLift = 0.36 + 0.64 * Math.min(1, i / (ctx.sampleRate * 0.035));
      data[i] = (rnd() * 2 - 1) * envelope * earlyLift * 0.22;
    }
  }
  return impulse;
}

/** Pair each `-start` with the next `-stop`, so restarts are handled. */
function pairRuns(events, startType, stopType, endSec) {
  const runs = [];
  let open = null;
  for (const e of events) {
    if (e.type === startType) {
      // A second start with no stop in between means the loop was restarted;
      // close the previous run there rather than letting two beds overlap.
      if (open) { open.stopSec = e.mediaSec; runs.push(open); }
      open = { start: e, stopSec: null, stopFadeOut: 0 };
    } else if (e.type === stopType && open) {
      open.stopSec = e.mediaSec;
      open.stopFadeOut = Math.max(0, Number(e.fadeOutSeconds) || 0);
      runs.push(open);
      open = null;
    }
  }
  if (open) runs.push(open);
  for (const r of runs) if (r.stopSec == null) r.stopSec = Infinity;
  return runs.filter((r) => r.start.mediaSec < endSec);
}

/**
 * Rebuild the session's soundtrack in an OfflineAudioContext.
 *
 * @param {object}   opts
 * @param {function} opts.api          () => window.__cuttle (optional; used for
 *                                     live volumes, the compressor state and
 *                                     the resolved ambience path)
 * @param {Array}    opts.events       from createAudioRecorder().events
 * @param {number}   opts.totalTicks   ticks the video covers
 * @param {number}   opts.simHz        ticks per SECOND OF MEDIA TIME (60)
 * @param {number}   opts.sampleRate   48000 (verified AAC path, FINDINGS.md)
 * @returns {Promise<AudioBuffer>}
 */
export async function renderSessionAudio({
  api = null,
  events = [],
  totalTicks = 0,
  simHz = 60,
  sampleRate = 48000,
  channels = 2,
  durationSeconds = null,
  reverbSeed = 0x5EED1E,
  onWarning = null,
  speed = 1,
} = {}) {
  const warn = (msg, extra) => {
    if (onWarning) onWarning(msg, extra);
    else console.warn('[replay/audio]', msg, extra ?? '');
  };

  // Media time. NOT tick/outputFps — the video's frame rate is irrelevant to
  // where a sound sits on the timeline.
  const mediaDuration = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds
    : Math.max(1 / simHz, totalTicks / simHz);

  const frames = Math.max(1, Math.ceil(mediaDuration * sampleRate));
  const ctx = new OfflineAudioContext({ numberOfChannels: channels, length: frames, sampleRate });

  // --- resolve clips ------------------------------------------------------
  // Media time must account for playback speed: replayToVideo scales the
  // tick->frame schedule by `speed`, so at 2x the video is half as long while
  // cues placed at tick/simHz would all land twice as late and fall past the
  // end. Pitch is deliberately NOT time-scaled — correct for music, and the
  // loops would otherwise chirp.
  const cues = events.map((e) => ({ ...e, mediaSec: (e.tick / (simHz * speed)) + ((Number(e.leadMs) || 0) / 1000) }))
    .sort((a, b) => a.mediaSec - b.mediaSec);

  const needed = new Set();
  for (const c of cues) if (c.clipId) needed.add(c.clipId);
  const needsFingerprintMatch = cues.some((c) => !c.clipId && c.signature);
  if (needsFingerprintMatch) for (const clip of SOUND_CLIPS) needed.add(clip.id);

  const buffers = new Map(); // clipId -> AudioBuffer
  let envPath = null;
  await Promise.all([...needed].map(async (id) => {
    try {
      if (id === 'env') {
        const { path, buffer } = await loadEnvBuffer(ctx, api);
        envPath = path;
        buffers.set('env', buffer);
      } else {
        buffers.set(id, await fetchDecode(ctx, clipById.get(id).path));
      }
    } catch (err) {
      warn(`could not load clip "${id}" — it will be silent`, err);
    }
  }));

  // Late identification for events the probe could not tag exactly.
  if (needsFingerprintMatch) {
    const refs = [...buffers.entries()].map(([id, buf]) => ({
      id, duration: buf.duration, fp: bufferFingerprint(buf),
    }));
    for (const c of cues) {
      if (c.clipId || !c.signature) continue;
      const near = refs.filter((r) => Math.abs(r.duration - c.signature.durationSeconds) < 0.05);
      const pool = near.length ? near : refs;
      let best = null; let bestD = Infinity;
      for (const r of pool) {
        const d = fingerprintDistance(r.fp, c.signature.fingerprint);
        if (d < bestD) { bestD = d; best = r; }
      }
      if (best && bestD < 0.25) {
        c.clipId = best.id;
        c.idMethod = 'fingerprint';
        c.fingerprintDistance = bestD;
      } else {
        warn('unidentified sound event; dropped', { tick: c.tick, bestD });
      }
    }
  }

  // --- master chain: mirrors connectSoundOutputGraph (main.js:8842-8855) ---
  const master = ctx.createGain();
  master.gain.value = 1;
  const compressorState = (() => {
    try { return { ...SOUND_COMPRESSOR_DEFAULTS, ...(api?.()?.audio?.soundCompressorState ?? {}) }; }
    catch { return { ...SOUND_COMPRESSOR_DEFAULTS }; }
  })();
  if (compressorState.enabled) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = clampFinite(compressorState.threshold, -100, 0, -24);
    comp.knee.value = clampFinite(compressorState.knee, 0, 40, 30);
    comp.ratio.value = clampFinite(compressorState.ratio, 1, 20, 12);
    comp.attack.value = clampFinite(compressorState.attack, 0, 1, 0.003);
    comp.release.value = clampFinite(compressorState.release, 0, 1, 0.25);
    master.connect(comp);
    comp.connect(ctx.destination);
  } else {
    master.connect(ctx.destination);
  }

  const report = { oneShots: 0, envCopies: 0, tumbleCopies: 0, dropped: 0, envPath };

  // --- one-shots: mirrors playSoundCheckOneShot (main.js:9463-9487) --------
  for (const cue of cues) {
    if (cue.type !== 'oneshot') continue;
    const buffer = cue.clipId ? buffers.get(cue.clipId) : null;
    if (!buffer) { report.dropped++; continue; }
    if (cue.mediaSec >= mediaDuration) { report.dropped++; continue; }

    const settings = soundSettings(api, cue.clipId);
    const volume = Number.isFinite(cue.gain) ? cue.gain : settings.volume;
    const startTime = cue.mediaSec;

    // main.js:9456-9462
    const fadeInSeconds = Math.min(
      Number.isFinite(cue.fadeInSeconds) ? cue.fadeInSeconds : settings.fadeInSeconds,
      Math.max(0, buffer.duration - 0.001),
    );
    const shouldLoop = Boolean(cue.loop);
    const fadeOutSeconds = shouldLoop ? 0 : Math.min(
      Number.isFinite(cue.fadeOutSeconds) ? cue.fadeOutSeconds : settings.fadeOutSeconds,
      Math.max(0, buffer.duration - fadeInSeconds - 0.001),
    );

    const source = ctx.createBufferSource();
    const envelopeGain = ctx.createGain();
    const gain = ctx.createGain();
    source.buffer = buffer;
    source.loop = shouldLoop;
    source.connect(envelopeGain);
    envelopeGain.connect(gain);
    gain.connect(master);

    gain.gain.setValueAtTime(volume, T(startTime));
    envelopeGain.gain.setValueAtTime(fadeInSeconds > 0 ? 0.0001 : 1, T(startTime));
    if (fadeInSeconds > 0) envelopeGain.gain.linearRampToValueAtTime(1, T(startTime + fadeInSeconds));
    if (fadeOutSeconds > 0) {
      const fadeStart = startTime + Math.max(fadeInSeconds, buffer.duration - fadeOutSeconds);
      envelopeGain.gain.setValueAtTime(1, T(fadeStart));
      envelopeGain.gain.linearRampToValueAtTime(0.0001, T(startTime + buffer.duration));
    }
    source.start(T(startTime));
    // The live one-shot is never explicitly stopped (it ends naturally); an
    // auditioned loop would run forever, so bound it at the render length.
    if (shouldLoop) source.stop(mediaDuration);
    report.oneShots++;
  }

  // --- ambience bed: startEnvAudio (9302-9321) + scheduleEnvAudioCopy ------
  //     (9266-9288) + stopEnvAudio (9323-9346)
  const envBuffer = buffers.get('env');
  if (envBuffer) {
    const envSettings = soundSettings(api, 'env');
    // main.js:8510-8513 / 9030-9033, computed from the OFFLINE-decoded duration
    const duration = envBuffer.duration;
    const maxCrossfade = Math.max(0, Math.min(SOUND_FADE_SECONDS_MAX, duration - 0.001));
    const crossfade = clampFinite(envSettings.fadeOutSeconds, 0, maxCrossfade, Math.min(ENV_AUDIO_CROSSFADE_SECONDS, maxCrossfade));
    const interval = Math.max(0.001, duration - crossfade);

    for (const run of pairRuns(cues.filter((c) => c.type.startsWith('env-')), 'env-start', 'env-stop', mediaDuration)) {
      const ev = run.start;
      const volume = Number.isFinite(ev.gain) ? ev.gain : envSettings.volume;
      const fadeIn = Number.isFinite(ev.fadeInSeconds) ? ev.fadeInSeconds : envSettings.fadeInSeconds;
      const stopAt = run.stopSec;
      const stopFade = run.stopFadeOut;

      // envAudioState.output — one gain for the whole bed (main.js:8772-8779).
      const envOut = ctx.createGain();
      envOut.connect(master);
      // startEnvAudio ramps this from the moment it ran, which is
      // ENV_AUDIO_START_DELAY_SECONDS before the first copy (main.js:9317).
      const anchor = Math.max(0, ev.mediaSec - ENV_AUDIO_START_DELAY_SECONDS);
      if (fadeIn > 0) {
        envOut.gain.setValueAtTime(0.0001, T(anchor));
        envOut.gain.linearRampToValueAtTime(volume, T(anchor + fadeIn));
      } else {
        envOut.gain.setValueAtTime(volume, T(anchor));
      }

      const lastStart = Math.min(stopAt, mediaDuration);
      if (interval < 0.25) { warn('ambience loop interval is absurdly short; bed skipped', { interval }); break; }
      for (let t = ev.mediaSec; t < lastStart; t += interval) {
        const fadeStart = t + interval;
        const naturalStop = t + duration;
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = envBuffer;
        source.connect(gain);
        gain.connect(envOut);

        // main.js:9279-9283 — fade-OUT only; the next copy comes in at full
        // gain over the outgoing tail.
        gain.gain.setValueAtTime(1, T(t));
        if (crossfade > 0) {
          gain.gain.setValueAtTime(1, T(fadeStart));
          gain.gain.linearRampToValueAtTime(0.0001, T(naturalStop));
        }

        let stopTime = naturalStop + 0.05;
        if (Number.isFinite(stopAt) && stopAt < naturalStop && stopAt >= t) {
          // stopEnvAudio ramps each live source from its CURRENT value
          // (main.js:9334). We can evaluate that value analytically because we
          // wrote the envelope above.
          const v = stopAt <= fadeStart
            ? 1
            : Math.max(0.0001, 1 + ((0.0001 - 1) * ((stopAt - fadeStart) / Math.max(1e-6, naturalStop - fadeStart))));
          gain.gain.cancelScheduledValues(T(stopAt));
          gain.gain.setValueAtTime(v, T(stopAt));
          if (stopFade > 0) gain.gain.linearRampToValueAtTime(0.0001, T(stopAt + stopFade));
          else gain.gain.setValueAtTime(0.0001, T(stopAt));
          stopTime = stopAt + stopFade + 0.02;
        }
        source.start(T(t), 0);
        source.stop(Math.min(stopTime, mediaDuration + 0.5));
        report.envCopies++;
        if (report.envCopies > 4096) { warn('ambience copy cap hit'); break; }
      }
    }
  }

  // --- slime tumble loop: ensureSlimeTumbleLoopOutput (9074-9118) minus the
  //     PannerNode, + scheduleSlimeTumbleLoopCopy (9129-9155) + the fade
  //     envelope from startSlimeTumbleLoop (9196-9202).
  const tumbleBuffer = buffers.get('slime-tumble');
  const tumbleRuns = pairRuns(cues.filter((c) => c.type.startsWith('tumble-')), 'tumble-start', 'tumble-stop', mediaDuration);
  if (tumbleBuffer && tumbleRuns.length) {
    const tumbleSettings = soundSettings(api, 'slime-tumble');
    // main.js:9040-9055, from the offline-decoded duration
    const duration = tumbleBuffer.duration;
    const loopStartSeconds = clampFinite(SLIME_TUMBLE_LOOP_START_SECONDS, 0, Math.max(0, duration - 0.001), SLIME_TUMBLE_LOOP_START_SECONDS);
    const loopDuration = Math.max(0.001, duration - loopStartSeconds);
    const maxCrossfade = Math.max(0, Math.min(SOUND_FADE_SECONDS_MAX, loopDuration * 0.5));
    const crossfade = clampFinite(SLIME_TUMBLE_LOOP_CROSSFADE_SECONDS, 0, maxCrossfade, Math.min(SLIME_TUMBLE_LOOP_CROSSFADE_SECONDS, maxCrossfade));
    const interval = Math.max(0.001, loopDuration - crossfade);
    const impulse = makeTumbleReverbImpulse(ctx, reverbSeed);

    for (const run of tumbleRuns) {
      const ev = run.start;
      const startAt = ev.mediaSec;
      const stopAt = run.stopSec;
      const stopFade = run.stopFadeOut;
      const fadeIn = Math.max(0, Number(ev.fadeInSeconds) || 0);
      const volume = Number.isFinite(ev.gain) ? ev.gain : tumbleSettings.volume;

      // STATIC stand-in for the PannerNode's inverse-distance gain. The panner
      // itself (HRTF, moving anchor) is out of scope for L1.5.
      const distanceGain = ctx.createGain();
      distanceGain.gain.value = Number.isFinite(ev.pannerDistanceGain) ? ev.pannerDistanceGain : 1;

      const fadeGain = ctx.createGain();
      const distanceFilter = ctx.createBiquadFilter();
      const volumeGain = ctx.createGain();
      const dryGain = ctx.createGain();
      const reverbSendGain = ctx.createGain();
      const reverbWetGain = ctx.createGain();
      const reverbConvolver = ctx.createConvolver();
      reverbConvolver.buffer = impulse;

      distanceFilter.type = 'lowpass';
      distanceFilter.frequency.value = Number.isFinite(ev.lowpassHz) ? ev.lowpassHz : SLIME_TUMBLE_LOWPASS_NEAR_HZ;
      distanceFilter.Q.value = SLIME_TUMBLE_LOWPASS_Q;
      volumeGain.gain.value = volume;
      dryGain.gain.value = 1;
      reverbSendGain.gain.value = 1;
      reverbWetGain.gain.value = Number.isFinite(ev.reverbWet) ? ev.reverbWet : 0;

      // main.js:9103-9111, with distanceGain where the panner was.
      distanceGain.connect(fadeGain);
      fadeGain.connect(distanceFilter);
      distanceFilter.connect(volumeGain);
      volumeGain.connect(dryGain);
      volumeGain.connect(reverbSendGain);
      reverbSendGain.connect(reverbConvolver);
      reverbConvolver.connect(reverbWetGain);
      dryGain.connect(master);
      reverbWetGain.connect(master);

      // main.js:9196-9202
      fadeGain.gain.setValueAtTime(0.0001, T(startAt));
      if (fadeIn > 0) fadeGain.gain.linearRampToValueAtTime(1, T(startAt + fadeIn));
      else fadeGain.gain.setValueAtTime(1, T(startAt));

      if (Number.isFinite(stopAt)) {
        // main.js:9238-9245 — ramp from the fade's current value.
        const v = fadeIn > 0 && stopAt < startAt + fadeIn
          ? Math.max(0.0001, (stopAt - startAt) / fadeIn)
          : 1;
        fadeGain.gain.cancelScheduledValues(T(stopAt));
        fadeGain.gain.setValueAtTime(v, T(stopAt));
        if (stopFade > 0) fadeGain.gain.linearRampToValueAtTime(0.0001, T(stopAt + stopFade));
        else fadeGain.gain.setValueAtTime(0.0001, T(stopAt));
      }

      const lastStart = Math.min(Number.isFinite(stopAt) ? stopAt : Infinity, mediaDuration);
      for (let t = startAt; t < lastStart; t += interval) {
        const naturalStop = t + loopDuration;
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = tumbleBuffer;
        source.connect(gain);
        gain.connect(distanceGain);

        // main.js:9144-9151 — symmetric crossfade, unlike the env bed's.
        if (crossfade > 0) {
          gain.gain.setValueAtTime(0.0001, T(t));
          gain.gain.linearRampToValueAtTime(1, T(Math.min(naturalStop, t + crossfade)));
          gain.gain.setValueAtTime(1, T(Math.max(t, naturalStop - crossfade)));
          gain.gain.linearRampToValueAtTime(0.0001, T(naturalStop));
        } else {
          gain.gain.setValueAtTime(1, T(t));
        }

        source.start(T(t), loopStartSeconds, loopDuration);
        const hardStop = Number.isFinite(stopAt) && stopAt + stopFade + 0.02 < naturalStop + 0.05
          ? stopAt + stopFade + 0.02
          : naturalStop + 0.05;
        source.stop(Math.min(hardStop, mediaDuration + 0.5));
        report.tumbleCopies++;
        if (report.tumbleCopies > 4096) { warn('tumble copy cap hit'); break; }
      }
    }
  }

  const rendered = await ctx.startRendering();
  rendered.replayReport = report; // non-standard, but handy for status.json
  return rendered;
}

/** Convenience: summary of what a set of events will produce, without rendering. */
export function describeAudioEvents(events = [], simHz = 60) {
  return events.map((e) => ({
    tick: e.tick,
    at: +((e.tick / simHz) + ((e.leadMs || 0) / 1000)).toFixed(3),
    type: e.type,
    clipId: e.clipId,
    leadMs: +Number(e.leadMs || 0).toFixed(1),
    idMethod: e.idMethod,
  }));
}

