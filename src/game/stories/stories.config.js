// Tunable numbers for the story system. Times are milliseconds, sizes are CSS
// pixels unless the name says otherwise.

export const STORY_LIBRARY = {
  url: 'assets/stories.json', // relative to the page
  // Shown in place of a story when the file could not be loaded.
  placeholderText: 'stories.json did not load; serve this page locally and check the story file.',
};

// When does a story start: slime coverage near its oat reaches the threshold.
export const STORY_TRIGGER = {
  pollIntervalMs: 220,
  maxOatsPerPass: 4, // waiting oats are checked a few at a time, round-robin
  soundName: 'cuttlefish-reveal',
  markerFadeOutMs: 1800, // the oat's glow fades out first; the box starts after
};

// The life of one story box, counted from the moment its text is laid out
// (which is `markerFadeOutMs` after the trigger).
export const STORY_TIMING = {
  glassFadeInMs: 2600, // the frosted box fades in; the first line starts after
  glassFadeOutMs: 2600, // after the text has left
  // Each line is wiped in left to right. The wipe is paced per grapheme:
  graphemeStepMs: 190,
  graphemeFadeMs: 1560, // extra travel for the soft edge of the wipe
  minLineMs: 240,
  nextLineStartFraction: 2 / 3, // a line starts when the previous is 2/3 done
  // After the last line is revealed the text keeps rolling up and out, for
  // the time it takes to reveal `exitLineCount` average lines.
  exitLineCount: 5,
  minExitMs: 2400,
};

// The left-to-right wipe is a mask gradient wider than the line, slid across
// it. `solidStop` is where the gradient stops being fully opaque.
export const LINE_WIPE = {
  maskScale: 2.6, // mask width as a multiple of the line width
  solidStop: 0.48,
  maskImage: 'linear-gradient(90deg, #000 0%, #000 48%, rgba(0, 0, 0, 0.72) 51%, ' +
    'rgba(0, 0, 0, 0.28) 54%, transparent 58%, transparent 100%)',
  startPositionPercent: 100, // mask-position x with the line fully hidden
};
// The wipe stops at the first position where the whole line is opaque (15.5%);
// sliding the mask on to 0% would change nothing on screen.
export const LINE_WIPE_END_PERCENT =
  ((LINE_WIPE.maskScale * LINE_WIPE.solidStop - 1) / (LINE_WIPE.maskScale - 1)) * 100;
// Fraction of the full mask travel that is actually used (0.845).
export const LINE_WIPE_ACTIVE_FRACTION = (100 - LINE_WIPE_END_PERCENT) / 100;

export const STORY_BOX = {
  widthPx: 230, // story.css uses the same width and height
  heightPx: 126,
  viewMarginPx: 14, // the box never comes closer than this to the screen edge
  minGapPx: 8, // least distance between the oat and the box's bottom edge
  strokeWidthPx: 1.5,
  tailOverlapPx: 2, // the tail starts this far inside the box border
  zIndexRange: 100000, // nearer oats get a higher z-index within the layer
  hiddenBelowGlassOpacity: 0.005,
  fallbackLineHeightPx: 16,
  minTextWidthPx: 20,
};

// How a box fades as its oat's patch of surface turns away or is hidden.
export const BOX_VISIBILITY = {
  facingHiddenDot: -0.14, // dot(surface normal, direction to camera)
  facingShownDot: 0.2,
  skipOcclusionBelowFacing: 0.002,
  occlusionRecheckMs: 120, // plus a per-oat phase, see recheckPhaseStepMs
  recheckPhaseStepMs: 19, // phase = (nth story oat * step) % occlusionRecheckMs
  // See NOTES.md: the old code says 10 for boxes but in practice ran at the
  // markers' 14 because both shared one cache.
  occlusionResponsePerSec: 14,
};

// Colour used when a hex colour string cannot be parsed.
export const FALLBACK_RGB = '14, 38, 56';
export const TEXT_COLOR_DEFAULT = '#ffffff';
