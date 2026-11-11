// Can the camera see the patch of surface a story box belongs to? Returns a
// 0..1 opacity that falls as the patch turns away from the camera, and eases
// to 0 while the body itself is in the way.
//
// The ray test against the body is the costly part, so its yes/no answer is
// cached and only refreshed every so often (staggered per oat), and the
// opacity glides toward the answer instead of snapping.

import { BOX_VISIBILITY as V } from './stories.config.js';

export function createSpotVisibility({ point, normal, recheckPhaseMs, now }) {
  let occlusionTarget = null; // 0 or 1 from the last ray test; null = never tested
  let occlusionOpacity = 1;
  let updatedAtMs = now;
  let nextCheckAtMs = 0;

  function update(now, camera, surface) {
    const facing = smoothstep(facingDot(camera.position), V.facingHiddenDot, V.facingShownDot);

    if (facing <= V.skipOcclusionBelowFacing) {
      occlusionTarget = 0; // turned away: nothing to test
    } else if (occlusionTarget === null || now >= nextCheckAtMs) {
      occlusionTarget = surface.isOccluded(camera.position, point) ? 0 : 1;
      nextCheckAtMs = now + V.occlusionRecheckMs + recheckPhaseMs;
    }

    const dtSec = Math.max(0, (now - updatedAtMs) / 1000);
    const response = 1 - Math.exp(-dtSec * V.occlusionResponsePerSec);
    occlusionOpacity += (occlusionTarget - occlusionOpacity) * response;
    updatedAtMs = now;
    return facing * occlusionOpacity;
  }

  // dot(surface normal, unit direction from the patch to the camera)
  function facingDot(cameraPosition) {
    const dx = cameraPosition.x - point.x;
    const dy = cameraPosition.y - point.y;
    const dz = cameraPosition.z - point.z;
    const length = Math.hypot(dx, dy, dz) || 1;
    return (normal.x * dx + normal.y * dy + normal.z * dz) / length;
  }

  return { update };
}

function smoothstep(x, min, max) {
  if (x <= min) return 0;
  if (x >= max) return 1;
  const t = (x - min) / (max - min);
  return t * t * (3 - 2 * t);
}
