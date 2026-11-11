// What the player's pointer does on the canvas: wherever it rests on the body
// it pushes the slime away, and a click (a press released without dragging)
// drops an oat. Dragging orbits the camera; that is the camera rig's business.

import * as THREE from 'three';

export const POINTER = Object.freeze({
  disturbRadiusWorld: 0.4546,   // at slime size 1
  disturbStrength: 3.0,
  // Finding the body under the pointer costs a raycast; do it at most this often while moving.
  raycastIntervalMs: 45,
  clickMaxTravelPx: 4,
});

/**
 * @param onDisturb(disturbance | null)  the pointer moved onto / off the body
 * @param onClick(hit, now)              a click landed on the body
 */
export function createPointerInput({ canvas, camera, surface, sizeScale = 1 }, { onDisturb, onClick }) {
  const ndc = new THREE.Vector2();
  let press = null;
  let lastRaycastMs = -Infinity;

  function hitUnder(event) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
    return surface.raycast(ndc, camera);
  }

  function disturb(event, { force = false } = {}) {
    const now = performance.now();
    if (!force && now - lastRaycastMs < POINTER.raycastIntervalMs) return null;
    lastRaycastMs = now;
    const hit = hitUnder(event);
    onDisturb(hit && surface.isOnBody(hit.uv)
      ? { uv: hit.uv, radiusWorld: POINTER.disturbRadiusWorld * sizeScale, strength: POINTER.disturbStrength }
      : null);
    return hit;
  }

  const onDown = (event) => {
    press = { x: event.clientX, y: event.clientY, id: event.pointerId };
    disturb(event, { force: true });
  };
  const onMove = (event) => disturb(event);
  const onUp = (event) => {
    const hit = disturb(event, { force: true });
    const pressed = press;
    press = null;
    if (!pressed || pressed.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) >= POINTER.clickMaxTravelPx) return;
    if (hit) onClick(hit, performance.now());
  };
  const onLeave = () => onDisturb(null);
  const onCancel = () => {
    press = null;
    onDisturb(null);
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointercancel', onCancel);

  return {
    dispose() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointercancel', onCancel);
    },
  };
}
