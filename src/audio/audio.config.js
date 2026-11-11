// Every tunable number of the audio engine, as data.
// Names carry their unit: Sec = seconds (WebAudio's clock), Ms = milliseconds
// (the game's clock), Hz, World = world units. Gains are linear multipliers.

export const SOUNDS_DIR = 'assets/sounds';

// A gain of exactly 0 cannot be the end of a ramp that later rises again
// without clicks on some browsers, so "silent" is this small value instead.
export const SILENT_GAIN = 0.0001;

// Clip names are the wav basenames in assets/sounds/.
//   gain          default playback volume (1 when omitted)
//   maxGain       peak-safe ceiling: the loudest gain that will not clip the file
//   fadeInSec     envelope at the start of a one-shot (0 when omitted)
//   fadeOutSec    envelope at the end of a one-shot, and its default stop fade
//   usedByGame    false = shipped in the sound pack but never played by the game
export const CLIPS = Object.freeze({
  'intro':                 { maxGain: 2.1809, usedByGame: true },
  'env-under-25mb':        { gain: 2, maxGain: 15.5816, fadeOutSec: 2.5, usedByGame: true },
  'slime-appear':          { maxGain: 3.4979, usedByGame: false },
  'slime-appear-stretch':  { gain: 2, maxGain: 4.1431, usedByGame: true },
  'slime-tumble':          { gain: 0.5, maxGain: 1.9959, usedByGame: true },
  'slime-tumble-complete': { maxGain: 3.0304, usedByGame: false },
  'slime-fuse':            { maxGain: 1.7083, usedByGame: true },
  'cuttlefish-reveal':     { gain: 0.5, maxGain: 2.2347, usedByGame: true },
  'cuttlefish-camouflage': { maxGain: 1.6634, usedByGame: true },
  'text-reveal':           { maxGain: 5.2462, usedByGame: false },
  'game-complete':         { maxGain: 2.4264, usedByGame: false },
});

export const ONE_SHOT = Object.freeze({
  maxVoicesPerClip: 16,      // a 17th overlapping play steals the oldest voice
  stealFadeSec: 0.025,       // how fast a stolen voice is faded out
  defaultFadeInSec: 0,
  defaultFadeOutSec: 0.08,
  maxFadeSec: 30,            // clamp for any per-clip fade
  stopTailSec: 0.02,         // a source is stopped this long after its fade ends
});

export const MASTER = Object.freeze({
  gain: 1,
  // Time constant of setTargetAtTime when a gain / filter value is retargeted.
  paramSmoothingSec: 0.035,
});

// Optional limiter between the master gain and the speakers. Off in the game.
export const COMPRESSOR = Object.freeze({
  enabled: false,
  thresholdDb: -24,
  kneeDb: 30,
  ratio: 12,
  attackSec: 0.003,
  releaseSec: 0.25,
});

// The ambience bed: copies of one long file, overlapped so the join is hidden.
export const ENV_LOOP = Object.freeze({
  clip: 'env-under-25mb',
  crossfadeSec: 2.5,         // tail of each copy that fades under the next one
  lookaheadSec: 12,          // copies are scheduled this far ahead of the audio clock
  pumpMs: 1000,              // how often the scheduler tops the queue up
  startDelaySec: 0.05,       // head start when no explicit start time is given
  fadeInSec: 0,
  stopFadeSec: 2.5,
});

// The slime's "tumble" texture: the file's first seconds are a one-off attack,
// so only the remainder is looped.
export const TUMBLE_LOOP = Object.freeze({
  clip: 'slime-tumble',
  cropStartSec: 8,           // loop region starts here
  crossfadeSec: 2,           // each copy fades in AND out over this long
  lookaheadSec: 12,
  pumpMs: 1000,
  startDelaySec: 0.02,
  defaultFadeInMs: 3460,     // the colony's seeding duration in the old game
  stopFadeSec: 0.08,
  sourceStopTailSec: 0.05,   // safety margin after a copy's scheduled end
});

// How the tumble loop sits in space. The listener is the camera.
export const TUMBLE_SPATIAL = Object.freeze({
  panningModel: 'HRTF',
  distanceModel: 'inverse',
  rolloffFactor: 4.8,
  coneAngleDeg: 360,                 // omnidirectional source
  lowpassNearHz: 18000,              // at the reference distance: fully open
  lowpassFarHz: 900,                 // at the far distance: muffled
  lowpassQ: 0.55,
  lowpassMinChangeHz: 8,             // smaller changes are not sent to the audio thread
  reverbLengthSec: 3.8,
  reverbDecayPower: 3.2,             // envelope = (1 - t)^power
  reverbEarlyLiftSec: 0.035,         // the impulse swells in over this long
  reverbEarlyLiftFloor: 0.36,        // ...starting from this fraction
  reverbNoiseGain: 0.22,
  reverbMaxWet: 0.58,                // wet level at the far distance (0 at reference)
  positionSmoothingSec: 0.045,       // setTargetAtTime constant for positions/orientation
  syncIntervalMs: 66,                // spatial params are retargeted at ~15 Hz at most
  positionEpsilonWorld: 0.048,       // moves smaller than this are ignored
  directionEpsilon: 0.0008,          // 1 - cos(angle) below this is ignored
  minGainChangeFraction: 0.002,      // of the target value
  minGainChangeAbsolute: 0.0005,
  farDistanceFallbackFactor: 2,      // far = reference * this when the orbit has no max
});
