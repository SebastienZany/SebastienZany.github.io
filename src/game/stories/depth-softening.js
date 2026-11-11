// Depth softening: how much each story box is obscured by nearer boxes.
//
// Boxes are stacked nearest-first. If a nearer box simply covered a farther
// one at full strength, then turning the view until two boxes swap places would
// make one snap from clear to frosted and the other from frosted to clear. So
// the amount a box is obscured grows smoothly with how far behind the nearer
// box it is: at the moment two boxes pass each other in depth, neither
// obscures the other.

const smoothstep = (edge0, edge1, x) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// A box counts as fully under another once this fraction of it is covered.
const FULL_OVERLAP_FRACTION = 0.4;

/**
 * @param placements  one per box on screen:
 *   { rect: { left, top, width, height } in px, distanceWorld: camera-to-oat, presence: 0..1 how visible the box is }
 * @param softnessWorld  depth separation at which a nearer box obscures a farther one completely
 * @returns {number[]}   0..1 per box: 0 = clear, 1 = fully behind another box's glass
 */
export function obscuredAmounts(placements, softnessWorld) {
  const softness = Math.max(softnessWorld, 1e-4);
  return placements.map((mine, i) => {
    let obscured = 0;
    for (let j = 0; j < placements.length; j++) {
      const other = placements[j];
      if (j === i || other.distanceWorld >= mine.distanceWorld) continue;
      const overlapX = Math.min(mine.rect.left + mine.rect.width, other.rect.left + other.rect.width) - Math.max(mine.rect.left, other.rect.left);
      const overlapY = Math.min(mine.rect.top + mine.rect.height, other.rect.top + other.rect.height) - Math.max(mine.rect.top, other.rect.top);
      if (overlapX <= 0 || overlapY <= 0) continue;
      const covered = (overlapX * overlapY) / (mine.rect.width * mine.rect.height);
      const behind = smoothstep(0, softness, mine.distanceWorld - other.distanceWorld);
      obscured = Math.max(obscured, smoothstep(0, FULL_OVERLAP_FRACTION, covered) * behind * other.presence);
    }
    return obscured;
  });
}
