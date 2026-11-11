// The timing of one story box, as plain numbers. Nothing here touches the
// DOM: story-box.js asks "where is everything at this many ms" each frame.
//
// All times are ms since the text was laid out:
//   0 .. glassFadeIn          the glass fades in, no text yet
//   textStart .. +reveal      lines wipe in one after another while the text
//                             rolls up one line per new line
//   .. textEnd                the text keeps rolling up until it has left
//   textEnd .. total          glass and text fade out

import {
  STORY_TIMING as T,
  LINE_WIPE,
  LINE_WIPE_END_PERCENT,
  LINE_WIPE_ACTIVE_FRACTION,
} from './stories.config.js';

// lineGraphemeCounts: one number per wrapped line (0 for an empty line).
// viewportHeightPx: height of the clipped area the text rolls through.
// textFadePx: height of the soft fade at the top and bottom of that area.
export function buildStoryTimeline({ lineGraphemeCounts, lineHeightPx, viewportHeightPx, textFadePx }) {
  const lines = [];
  let nextStartMs = 0;
  let revealEndMs = 0;
  let durationSumMs = 0;
  for (const graphemeCount of lineGraphemeCounts) {
    const fullTravelMs = graphemeCount * T.graphemeStepMs + T.graphemeFadeMs;
    const durationMs = Math.max(T.minLineMs, fullTravelMs * LINE_WIPE_ACTIVE_FRACTION);
    lines.push({ startMs: nextStartMs, durationMs });
    revealEndMs = Math.max(revealEndMs, nextStartMs + durationMs);
    nextStartMs += durationMs * T.nextLineStartFraction;
    durationSumMs += durationMs;
  }

  const revealMs = Math.max(1, revealEndMs);
  const averageLineMs = durationSumMs / Math.max(1, lines.length);
  const exitMs = Math.max(T.minExitMs, averageLineMs * T.exitLineCount);
  const textStartMs = T.glassFadeInMs;
  const textEndMs = textStartMs + revealMs + exitMs;
  const totalMs = textEndMs + T.glassFadeOutMs;

  // The roll starts with the first line at the lower edge of the fully
  // opaque zone, moves up one line height as each line begins, and ends with
  // everything above the top.
  const firstOffsetPx = Math.max(0, viewportHeightPx - textFadePx);
  const lastOffsetPx = -((lines.length + 1) * lineHeightPx);
  const scrollKeys = [
    { atMs: 0, offsetPx: firstOffsetPx },
    { atMs: textStartMs, offsetPx: firstOffsetPx },
  ];
  lines.forEach((line, index) => {
    if (index === 0) return;
    scrollKeys.push({ atMs: textStartMs + line.startMs, offsetPx: firstOffsetPx - lineHeightPx * index });
  });
  scrollKeys.push({ atMs: textStartMs + revealMs, offsetPx: firstOffsetPx - lineHeightPx * lines.length });
  scrollKeys.push({ atMs: textEndMs, offsetPx: lastOffsetPx });
  scrollKeys.push({ atMs: totalMs, offsetPx: lastOffsetPx });

  return { lines, scrollKeys, textStartMs, revealMs, exitMs, textEndMs, totalMs };
}

// Opacity of the glass and of the text, each 0..1.
export function envelopeAt(timeline, elapsedMs) {
  if (elapsedMs >= timeline.totalMs) return { glass: 0, text: 0 };
  const fadeIn = smoothUnit(elapsedMs / Math.max(1, timeline.textStartMs));
  const text = elapsedMs >= timeline.textStartMs ? 1 : 0; // lines bring their own wipe
  if (elapsedMs <= timeline.textEndMs) return { glass: fadeIn, text };
  const fadeOut = smoothUnit((elapsedMs - timeline.textEndMs) / Math.max(1, T.glassFadeOutMs));
  return { glass: fadeIn * (1 - fadeOut), text: text * (1 - fadeOut) };
}

// Vertical offset of the rolling text, in px (positive = pushed down).
export function scrollOffsetAt(timeline, elapsedMs) {
  const keys = timeline.scrollKeys;
  if (elapsedMs <= keys[0].atMs) return keys[0].offsetPx;
  for (let i = 1; i < keys.length; i++) {
    const from = keys[i - 1];
    const to = keys[i];
    if (elapsedMs > to.atMs) continue;
    const spanMs = to.atMs - from.atMs;
    const f = spanMs > 0 ? (elapsedMs - from.atMs) / spanMs : 1;
    return from.offsetPx + (to.offsetPx - from.offsetPx) * f;
  }
  return keys[keys.length - 1].offsetPx;
}

// How far line `index` has wiped in: 0 = hidden, 1 = fully shown.
export function lineProgressAt(timeline, index, elapsedMs) {
  const line = timeline.lines[index];
  const t = (elapsedMs - timeline.textStartMs - line.startMs) / line.durationMs;
  return Math.max(0, Math.min(1, t));
}

// The mask-position x (in %) that shows a line at the given wipe progress.
export function wipePositionPercent(progress) {
  const start = LINE_WIPE.startPositionPercent;
  return start + (LINE_WIPE_END_PERCENT - start) * progress;
}

export function smoothUnit(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}
