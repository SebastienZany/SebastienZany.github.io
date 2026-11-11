// Tunable numbers for the oat markers (the glow at each oat) and the fizzle
// (the puff shown where an oat placement was rejected).
// World units are the scene's own: the body's longest extent is 9.6.

export const GLOW_TEXTURE = {
  sizePx: 96,
  // Radial ramp from the centre (0) to the edge of the square (1).
  // Colour channels are 0..255, alpha is 0..1.
  stops: [
    { at: 0.0, r: 255, g: 255, b: 120, a: 1.0 },
    { at: 0.2, r: 255, g: 235, b: 36, a: 0.5 },
    { at: 0.52, r: 255, g: 210, b: 0, a: 0.14 },
    { at: 1.0, r: 255, g: 210, b: 0, a: 0.0 },
  ],
};

export const MARKER = {
  sizeWorld: 0.408, // sprite width and height
  opacity: 1.0,
  tint: 0xffffff,
  renderOrder: 8, // after the body and the slime film; the sprite ignores depth
  fadeInMs: 900,
  hiddenBelowOpacity: 0.01, // the sprite is switched off entirely below this
};

// How a marker fades as its patch of surface turns away from the camera or
// goes behind the body.
export const MARKER_VISIBILITY = {
  // dot(surface normal, direction to camera): fully hidden at or below
  // `hiddenDot`, fully shown at or above `shownDot`, smoothstep between.
  facingHiddenDot: -0.18,
  facingShownDot: 0.14,
  // Below this facing value the marker cannot be seen, so the ray test is skipped.
  skipOcclusionBelowFacing: 0.002,
  // Each marker re-tests occlusion every `occlusionRecheckMs` plus its own
  // phase, so the ray tests of many oats do not all land on the same frame.
  occlusionRecheckMs: 120,
  recheckPhaseStepMs: 19, // phase = (nth story oat * step) % occlusionRecheckMs
  // The on/off ray test result is eased: opacity moves toward it at this rate.
  occlusionResponsePerSec: 14,
};

export const FIZZLE = {
  durationMs: 1050,
  sizeWorld: 0.364,
  opacity: 0.95,
  envelopePower: 1.55, // overall fade: (1 - t) ^ power
  // Flicker: a base level plus three sines of t (0..1 over the fizzle's life).
  flutterBase: 0.62,
  flutterWaves: [
    { amount: 0.28, phaseScale: 1.0, frequency: 94 },
    { amount: 0.18, phaseScale: 0.47, frequency: 211 },
    { amount: 0.12, phaseScale: 1.83, frequency: 397 },
  ],
  // Late in its life the flame cuts out in bursts.
  sputterAfter: 0.46,
  sputterPhaseScale: 2.7,
  sputterFrequency: 61,
  sputterCutoffBase: -0.36,
  sputterCutoffSlope: 0.42,
  sputterLevel: 0.18,
  // One last flare just before it dies.
  lastGaspAt: 0.82,
  lastGaspWidth: 0.075,
  lastGaspAmount: 0.32,
  maxFlame: 1.25,
  // Size: shrinks as (1 - t) ^ power, never below `minShrink`, with a wobble.
  shrinkPower: 0.72,
  minShrink: 0.08,
  sizeJitterAmount: 0.16,
  sizeJitterFrequency: 173,
};
