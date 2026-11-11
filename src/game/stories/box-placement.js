// Where a story box sits on screen relative to its oat, and the thin "tail"
// line from the box to the oat. Pure geometry in CSS pixels, y down.

import { STORY_BOX } from './stories.config.js';

// The box is centred above the oat, `tailLengthVh` of the viewport height
// away, then pushed back inside the screen margins if it would leave them.
// anchorPx: the oat's position on screen. Returns the box rectangle.
export function placeBox(anchorPx, viewport, tailLengthVh) {
  const margin = STORY_BOX.viewMarginPx;
  const width = Math.min(STORY_BOX.widthPx, Math.max(1, viewport.widthPx - margin * 2));
  const height = STORY_BOX.heightPx;
  const gap = Math.max(STORY_BOX.minGapPx, Math.max(0, tailLengthVh ?? 0) * viewport.heightPx);
  return {
    left: clamp(anchorPx.x - width / 2, margin, viewport.widthPx - width - margin),
    top: clamp(anchorPx.y - height - gap, margin, viewport.heightPx - height - margin),
    width,
    height,
  };
}

// The tail runs from the box edge toward the oat. Returns null when there is
// nothing to draw (the oat is under the box, or right at its edge); otherwise
// the line as a start point relative to the box, a length and an angle.
export function tailFor(box, tipPx) {
  const inside = tipPx.x >= box.left && tipPx.x <= box.left + box.width &&
    tipPx.y >= box.top && tipPx.y <= box.top + box.height;
  if (inside) return null;

  const start = edgePointToward(box, tipPx);
  const dx = tipPx.x - start.x;
  const dy = tipPx.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return null;

  // Start a little inside the border so no gap shows where line meets box.
  const overlap = STORY_BOX.tailOverlapPx;
  return {
    leftPx: start.x - (dx / length) * overlap - box.left,
    topPx: start.y - (dy / length) * overlap - box.top - STORY_BOX.strokeWidthPx / 2,
    lengthPx: length + overlap,
    angleRad: Math.atan2(dy, dx),
  };
}

// Where the line from the box centre to `target` crosses the box edge.
function edgePointToward(box, target) {
  const centreX = box.left + box.width / 2;
  const centreY = box.top + box.height / 2;
  const dx = target.x - centreX;
  const dy = target.y - centreY;
  const scale = Math.max(
    Math.abs(dx) / Math.max(1, box.width / 2),
    Math.abs(dy) / Math.max(1, box.height / 2),
    1e-6,
  );
  return {
    x: clamp(centreX + dx / scale, box.left, box.left + box.width),
    y: clamp(centreY + dy / scale, box.top, box.top + box.height),
  };
}

// Like THREE.MathUtils.clamp: when the range is inverted (a screen narrower
// than the box plus margins) the lower bound wins.
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
