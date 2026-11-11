// Where the falling intro oat is, how big and how bright, as functions of its
// progress (0..1 over its 10 s life), plus the one piece of back-solving the
// intro needs: how long before the oat's lower edge crosses the top of the
// screen, so its entrance can be pinned to the music.

import { Vector3 } from 'three';
import { clamp01, inverseSmoothUnit, smoothUnit } from './easing.js';

// The oat comes to rest hovering just off the body at the initial oat.
export function introOatTarget(oat, config) {
  if (!oat?.point) return null;
  const normal = oat.normal ? oat.normal.clone() : oat.point.clone();
  if (normal.lengthSq() < 1e-8) normal.set(0, 1, 0);
  normal.normalize();
  return oat.point.clone().addScaledVector(normal, config.hoverAboveSurfaceWorld);
}

// It starts above the top of the screen, at the same screen x and the same
// depth as its target, so on screen it falls in a straight vertical line.
export function introOatStart(target, camera, config) {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const ndc = target.clone().project(camera);
  if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || !Number.isFinite(ndc.z)) {
    return target.clone().add(new Vector3(0, config.fallbackRiseWorld, 0));
  }
  return new Vector3(ndc.x, config.startNdcY, ndc.z).unproject(camera);
}

// The progress at which the brightening ends and the final fade begins.
function brightenEndProgress(config) {
  return 1 - config.fadeOutMs / config.fallMs;
}

// Three overlapping movements over progress 0..1:
//   descent  0 -> 1 until landing (eased), then stays 1
//   glow     0 -> 1 from landing until the final fade starts
//   fade     0 -> 1 over the final fade
export function introOatPose(progress, config) {
  const landAt = config.landAtProgress;
  const brightenEnd = brightenEndProgress(config);
  const descent = smoothUnit(Math.min(1, progress / landAt));
  const glow = progress <= landAt
    ? 0
    : smoothUnit((Math.min(progress, brightenEnd) - landAt) / Math.max(0.001, brightenEnd - landAt));
  const fade = progress <= brightenEnd
    ? 0
    : smoothUnit((progress - brightenEnd) / Math.max(0.001, 1 - brightenEnd));
  return {
    descent, // lerp factor from start to target
    scaleWorld: introOatScale(descent, glow, config),
    opacity: (1 + glow * config.glowOpacityGain) * (1 - fade),
  };
}

// Slightly larger while high up, shrinking as it nears the body, then
// swelling as it brightens.
function introOatScale(descent, glow, config) {
  return config.baseScaleWorld * (
    config.scaleAtStart -
    clamp01(descent) * config.scaleDescentShrink +
    clamp01(glow) * config.scaleGlowGrow
  );
}

// Screen-space y of the sprite's lower edge when it is `descent` of the way down.
function spriteBottomNdcY(start, target, descent, camera, config) {
  const center = new Vector3().lerpVectors(start, target, descent);
  const centerNdcY = center.clone().project(camera).y;
  if (!Number.isFinite(centerNdcY)) return Infinity;
  const cameraUp = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  const halfHeightWorld = introOatScale(descent, 0, config) / 2;
  const topNdcY = center.addScaledVector(cameraUp, halfHeightWorld).project(camera).y;
  const halfHeightNdc = Math.abs(topNdcY - centerNdcY);
  return centerNdcY - (Number.isFinite(halfHeightNdc) ? halfHeightNdc : 0);
}

// How long after the fall starts the sprite's lower edge crosses the top of
// the screen. The intro starts the fall this much early, so the oat appears
// exactly on cue whatever the camera and aspect ratio.
export function introOatTopEdgeLeadMs(start, target, camera, config) {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const edge = config.topEdgeNdcY;
  const startsOnScreen = spriteBottomNdcY(start, target, 0, camera, config) <= edge;
  const endsOffScreen = spriteBottomNdcY(start, target, 1, camera, config) > edge;
  if (startsOnScreen || endsOffScreen) return 0;

  // Bisect for the descent at which the lower edge sits on the screen edge...
  let low = 0;
  let high = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) / 2;
    if (spriteBottomNdcY(start, target, mid, camera, config) > edge) low = mid;
    else high = mid;
  }
  // ...then undo the easing to turn that descent into a time.
  const progress = inverseSmoothUnit((low + high) / 2) * config.landAtProgress;
  return Math.max(0, Math.min(config.fallMs, progress * config.fallMs));
}
