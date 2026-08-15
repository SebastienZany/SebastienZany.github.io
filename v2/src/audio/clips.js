/**
 * Audio constants are data so parity values can be audited without reading the engine.
 * Paths are relative to pages served from /v2/.
 */

export const CLIP_DEFAULTS = Object.freeze({
  fadeInSeconds: 0,
  fadeOutSeconds: 0.08,
  maximumFadeSeconds: 30,
  legacyAnchor: 'main.js:216-221',
});

export const AUDIO_NUMERICS = Object.freeze({
  silenceGain: 0.0001,
  minimumSegmentSeconds: 0.001,
  minimumDistanceWorld: 0.001,
  legacyAnchor: 'main.js:9026-9057,9132-9147,9271-9285,9392-9410',
});

export const ENV_LOOP = Object.freeze({
  crossfadeSeconds: 2.5,
  lookaheadSeconds: 12,
  pumpIntervalMilliseconds: 1000,
  startDelaySeconds: 0.05,
  sourceStopTailSeconds: 0.05,
  legacyAnchor: 'main.js:193-198,8945-8971,9266-9321',
});

export const TUMBLE_LOOP = Object.freeze({
  cropStartSeconds: 8,
  crossfadeSeconds: 2,
  lookaheadSeconds: 12,
  pumpIntervalMilliseconds: 1000,
  startDelaySeconds: 0.02,
  defaultGameFadeInSeconds: 3.46,
  sourceStopTailSeconds: 0.05,
  legacyAnchor: 'main.js:199-205,9037-9170',
});

export const PRELOAD_POLICY = Object.freeze({
  priorityClipIds: Object.freeze(['slime-fuse', 'intro']),
  idleTimeoutMilliseconds: 1500,
  fallbackDelayMilliseconds: 250,
  legacyAnchor: 'main.js:8988-9011',
});

export const TUMBLE_SPATIAL = Object.freeze({
  reverbSeconds: 3.8,
  reverbDecay: 3.2,
  reverbMaximumWet: 0.58,
  reverbEarlyLiftSeconds: 0.035,
  reverbEarlyBase: 0.36,
  reverbEarlyRange: 0.64,
  reverbAmplitude: 0.22,
  reverbChannels: 2,
  spatialSmoothSeconds: 0.045,
  syncIntervalMilliseconds: 66,
  positionEpsilonWorld: 0.012 * 4,
  directionEpsilon: 0.0008,
  panningModel: 'HRTF',
  distanceModel: 'inverse',
  pannerRolloff: 4.8,
  coneInnerAngleDegrees: 360,
  coneOuterAngleDegrees: 360,
  lowpassNearHz: 18000,
  lowpassFarHz: 900,
  lowpassQ: 0.55,
  volumeEpsilonMinimum: 0.0005,
  volumeEpsilonRatio: 0.002,
  lowpassEpsilonHz: 8,
  wetEpsilonMinimum: 0.0005,
  wetEpsilonRatio: 0.002,
  stubCameraZWorld: 4,
  stubMaximumDistanceWorld: 5.6 * 4,
  legacyAnchor: 'main.js:158,199-215,8545-8721,9059-9118',
});

export const AUDIO_RAMP = Object.freeze({
  targetTimeConstantSeconds: 0.035,
  legacyAnchor: 'main.js:216,8428-8480,8719-8734',
});

export const ONE_SHOT_POLICY = Object.freeze({
  maximumVoicesPerClip: 16,
  stealFadeSeconds: 0.025,
  sourceStopTailSeconds: 0.02,
  legacyAnchor: 'main.js:217-218,9413-9454',
});

export const COMPRESSOR_DEFAULTS = Object.freeze({
  enabled: false,
  threshold: -24,
  knee: 30,
  ratio: 12,
  attack: 0.003,
  release: 0.25,
  legacyAnchor: 'main.js:222-236,8842-8876',
});

export const COMPRESSOR_CONTROLS = Object.freeze([
  Object.freeze({ key: 'threshold', label: 'Threshold', min: -100, max: 0, step: 1, suffix: 'dB', digits: 0, legacyAnchor: 'main.js:227' }),
  Object.freeze({ key: 'knee', label: 'Knee', min: 0, max: 40, step: 1, suffix: 'dB', digits: 0, legacyAnchor: 'main.js:228' }),
  Object.freeze({ key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1, suffix: ':1', digits: 1, legacyAnchor: 'main.js:229' }),
  Object.freeze({ key: 'attack', label: 'Attack', min: 0, max: 1, step: 0.001, suffix: 's', digits: 3, legacyAnchor: 'main.js:230' }),
  Object.freeze({ key: 'release', label: 'Release', min: 0, max: 1, step: 0.01, suffix: 's', digits: 2, legacyAnchor: 'main.js:231' }),
]);

const SOUND_PATH = '../shen-soundpack/wav/';

function clip(row) {
  return Object.freeze({
    gain: 1,
    fadeInSeconds: CLIP_DEFAULTS.fadeInSeconds,
    fadeOutSeconds: CLIP_DEFAULTS.fadeOutSeconds,
    fallbackPath: null,
    scheduledLoop: null,
    ...row,
  });
}

export const CLIPS = Object.freeze([
  clip({
    id: 'intro', path: `${SOUND_PATH}intro.wav`, loop: false, maxGain: 2.1809,
    usedInGame: true, legacyAnchor: 'main.js:256',
  }),
  clip({
    id: 'env', path: `${SOUND_PATH}env.wav`, fallbackPath: `${SOUND_PATH}env-under-25mb.wav`,
    loop: true, gain: 2, maxGain: 15.5816, fadeOutSeconds: ENV_LOOP.crossfadeSeconds,
    scheduledLoop: Object.freeze({ kind: 'overlap-crossfade', crossfadeSeconds: ENV_LOOP.crossfadeSeconds }),
    usedInGame: true, legacyAnchor: 'main.js:257',
  }),
  clip({
    id: 'slime-appear', path: `${SOUND_PATH}slime-appear.wav`, loop: false, maxGain: 3.4979,
    usedInGame: false, legacyAnchor: 'main.js:258',
  }),
  clip({
    id: 'slime-appear-stretch', path: `${SOUND_PATH}slime-appear-stretch.wav`, loop: false,
    gain: 2, maxGain: 4.1431, usedInGame: true, legacyAnchor: 'main.js:259',
  }),
  clip({
    id: 'slime-tumble', path: `${SOUND_PATH}slime-tumble.wav`, loop: false,
    gain: 0.5, maxGain: 1.9959,
    scheduledLoop: Object.freeze({
      kind: 'crop-overlap-crossfade',
      cropStartSeconds: TUMBLE_LOOP.cropStartSeconds,
      crossfadeSeconds: TUMBLE_LOOP.crossfadeSeconds,
    }),
    usedInGame: true, legacyAnchor: 'main.js:260',
  }),
  clip({
    id: 'slime-tumble-complete', path: `${SOUND_PATH}slime-tumble-complete.wav`, loop: false,
    maxGain: 3.0304, usedInGame: false, legacyAnchor: 'main.js:261',
  }),
  clip({
    id: 'slime-fuse', path: `${SOUND_PATH}slime-fuse.wav`, loop: false, maxGain: 1.7083,
    usedInGame: true, legacyAnchor: 'main.js:262',
  }),
  clip({
    id: 'cuttlefish-reveal', path: `${SOUND_PATH}cuttlefish-reveal.wav`, loop: false,
    gain: 0.5, maxGain: 2.2347, usedInGame: true, legacyAnchor: 'main.js:263',
  }),
  clip({
    id: 'cuttlefish-camouflage', path: `${SOUND_PATH}cuttlefish-camouflage.wav`, loop: false,
    maxGain: 1.6634, usedInGame: true, legacyAnchor: 'main.js:264',
  }),
  clip({
    id: 'text-reveal', path: `${SOUND_PATH}text-reveal.wav`, loop: false, maxGain: 5.2462,
    usedInGame: false, legacyAnchor: 'main.js:265',
  }),
  clip({
    id: 'game-complete', path: `${SOUND_PATH}game-complete.wav`, loop: false, maxGain: 2.4264,
    usedInGame: false, legacyAnchor: 'main.js:266',
  }),
]);

const CLIPS_BY_ID = new Map(CLIPS.map((entry) => [entry.id, entry]));

export function getClip(clipId) {
  return CLIPS_BY_ID.get(clipId) ?? null;
}
