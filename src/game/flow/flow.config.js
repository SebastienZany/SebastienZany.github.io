// Timings and looks of the start screen, intro and ending.
// Times are milliseconds, distances are world units (the body is 9.6 across),
// "Ndc" values are normalised device coordinates (-1 bottom .. +1 top of screen).

export const flowConfig = {
  startScreen: {
    // One shared fade length: "loading..." out, Begin in, Begin out, title
    // out, intro line in/out and the final fade of the whole black screen.
    uiFadeMs: 1000,
    // Begin only accepts clicks once it is at least this visible.
    beginClickableAboveOpacity: 0.18,
    loadingText: 'loading...',
    fallbackErrorText: 'loading failed',
  },

  beginButton: {
    hoverFadeMs: 500,
    // Border alpha = base + hover * gain; fill alpha = hover (white fill,
    // text goes from white to black as it fills).
    borderAlphaBase: 0.62,
    borderAlphaHoverGain: 0.28,
    glowRgb: '188, 255, 236',
    // Resting hover glow.
    hoverGlowAlpha: 0.14,
    hoverGlowRadiusPx: 10,
    hoverInsetAlpha: 0.05,
    // Glow after the click: swells until the click sound's peak, then fades.
    clickGlowAlphaBase: 0.16,
    clickGlowAlphaGain: 0.52,
    clickGlowRadiusBasePx: 8,
    clickGlowRadiusGainPx: 30,
    clickInsetAlphaBase: 0.08,
    clickInsetAlphaGain: 0.22,
    insetRadiusFactor: 0.42,
    // The click snaps the fill to at least this much, then it rises to full.
    clickFillFloor: 0.35,
  },

  intro: {
    // slime-fuse.wav peaks this long after it starts; the screen holds still
    // until then, so the fade-out begins on the peak.
    clickSoundPeakMs: 826.23,
    // Silence between the title's fade-out and the intro sound.
    silentBeatMs: 1000,
    // From the intro sound's start to the oat crossing the top of the screen
    // (also when the black screen has fully cleared and the ambience starts).
    oatTopEdgeDelayMs: 5500,
    // If intro.wav is not decoded at the click, hold the timeline this long at most.
    introSoundWaitMaxMs: 4000,
    // Fade used when S cuts the intro sound short.
    introSoundSkipFadeMs: 80,
  },

  introOat: {
    fallMs: 10000,            // whole life of the sprite
    landAtProgress: 0.68,     // fraction of fallMs at which it reaches the body
    fadeOutMs: 1000,          // final fade; it brightens from landing until this starts
    startNdcY: 1.55,          // starts this far above the screen, straight over its target
    topEdgeNdcY: 1,
    baseScaleWorld: 0.96,
    // scale = baseScaleWorld * (scaleAtStart - descent * scaleDescentShrink + glow * scaleGlowGrow)
    scaleAtStart: 1.12,
    scaleDescentShrink: 0.16,
    scaleGlowGrow: 0.38,
    glowOpacityGain: 0.72,    // opacity = (1 + glow * gain) * (1 - fade); above 1 on purpose (additive)
    hoverAboveSurfaceWorld: 0.14,
    fallbackRiseWorld: 2.8,   // start height if the target cannot be projected
    renderOrder: 20,
    textureSizePx: 96,
    // Radial ramp, centre to rim: [position 0..1, red, green, blue, alpha].
    glowStops: [
      [0.0, 255, 255, 120, 1.0],
      [0.2, 255, 235, 36, 0.5],
      [0.52, 255, 210, 0, 0.14],
      [1.0, 255, 210, 0, 0.0],
    ],
  },

  seed: {
    durationMs: 3460,   // the colony grows in over this long
    soundLeadMs: 1000,  // slime-appear-stretch starts this long before seeding
  },

  ending: {
    timeLimitMs: 120000,          // time-limit ending: Begin click to back-on-start-screen
    idleTimeoutMs: 120000,        // idle ending: no input for this long
    camouflageFadeDelayMs: 7000,  // black fade starts this long into the camouflage sound
    fallbackFadeMs: 3000,         // plain fade when the camouflage sound is unavailable
    soundStopFadeMs: 80,
    envLoopStopFadeMs: 2500,
    tumbleLoopStopFadeMs: 1200,
    // Any of these, anywhere on the page, counts as "the player is here".
    activityEvents: ['pointerdown', 'pointermove', 'click', 'wheel', 'keydown'],
  },

  sounds: {
    click: 'slime-fuse',
    intro: 'intro',
    seed: 'slime-appear-stretch',
    camouflage: 'cuttlefish-camouflage',
    // Warmed as soon as the intro is under way, so nothing later starts late.
    preloadAfterBegin: ['slime-appear-stretch', 'slime-tumble', 'cuttlefish-camouflage'],
  },
};

// Dev-panel toggles. The flow keeps the state; the panel calls
// flow.setEndingEnabled / flow.setIdleEndingEnabled when these change.
export const paramSchema = [
  { section: 'Ending', items: [
    { key: 'endingTimeLimitEnabled', label: 'Time limit', type: 'toggle', default: false,
      help: 'End the game two minutes after Begin, with corner countdowns.' },
    { key: 'endingIdleEnabled', label: 'Idle ending (2 min)', type: 'toggle', default: true,
      help: 'End the game after two minutes without any input. Ignored while the time limit is on.' },
  ] },
];

export function defaultParams() {
  const params = {};
  for (const section of paramSchema) {
    for (const item of section.items) params[item.key] = item.default;
  }
  return params;
}
