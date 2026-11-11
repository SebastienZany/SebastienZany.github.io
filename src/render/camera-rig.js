// The camera and how the player moves it: drag to orbit, wheel or pinch to
// zoom, arrow keys to orbit, Shift to do any of it slowly.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const CAMERA = Object.freeze({
  // The view the game opens on, looking down at the body from behind.
  initialPosition: [1.893468, 5.498426, -5.633916],
  initialTarget: [0, 0, 0],
  fovDeg: 42.8571,
  near: 0.04,
  far: 1200,
  minDistanceWorld: 3.2,
  maxDistanceWorld: 22.4,
  // From straight overhead to 30 degrees below the horizon: enough to peek
  // under the body without rolling over the bottom pole.
  maxPolarDeg: 120,
  dampingFactor: 0.07,
  rotateSpeed: 0.65,
  zoomSpeed: 0.7,
  shiftSpeedMultiplier: 1 / 3,
  keyboardSpeedRadPerSec: 0.68,
  keyboardResponseMs: 120, // time constant while a key is held
  keyboardDecayMs: 520,    // time constant after release
});

const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

export function createCameraRig({ canvas }) {
  const camera = new THREE.PerspectiveCamera(CAMERA.fovDeg, 1, CAMERA.near, CAMERA.far);
  const initialPose = Object.freeze({
    position: new THREE.Vector3(...CAMERA.initialPosition),
    target: new THREE.Vector3(...CAMERA.initialTarget),
    fovDeg: CAMERA.fovDeg,
  });

  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = CAMERA.dampingFactor;
  controls.minDistance = CAMERA.minDistanceWorld;
  controls.maxDistance = CAMERA.maxDistanceWorld;
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(CAMERA.maxPolarDeg);

  const held = { left: false, right: false, up: false, down: false, shift: false };
  const keyboardVelocity = { theta: 0, phi: 0 };
  let lastUpdateMs = null;
  const offset = new THREE.Vector3();
  const spherical = new THREE.Spherical();

  function setPose(pose) {
    camera.position.copy(pose.position);
    controls.target.copy(pose.target);
    if (pose.fovDeg) camera.fov = pose.fovDeg;
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
    controls.update();
  }
  function getPose() {
    return { position: camera.position.clone(), target: controls.target.clone(), fovDeg: camera.fov };
  }

  function applySpeed() {
    const multiplier = held.shift ? CAMERA.shiftSpeedMultiplier : 1;
    controls.rotateSpeed = CAMERA.rotateSpeed * multiplier;
    controls.zoomSpeed = CAMERA.zoomSpeed * multiplier;
  }

  function orbitBy(deltaTheta, deltaPhi) {
    offset.copy(camera.position).sub(controls.target);
    spherical.setFromVector3(offset);
    spherical.theta += deltaTheta;
    spherical.phi = THREE.MathUtils.clamp(spherical.phi + deltaPhi, Math.max(controls.minPolarAngle, 1e-4), controls.maxPolarAngle);
    camera.position.copy(controls.target).add(offset.setFromSpherical(spherical));
    camera.lookAt(controls.target);
  }

  const isTyping = (event) => /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName ?? '');
  function onKey(event, down) {
    if (event.key === 'Shift') {
      held.shift = down;
      applySpeed();
      return;
    }
    const direction = ARROWS[event.key];
    if (!direction || isTyping(event)) return;
    held[direction] = down;
    event.preventDefault();
  }
  const onKeyDown = (event) => onKey(event, true);
  const onKeyUp = (event) => onKey(event, false);
  const onBlur = () => {
    for (const key of Object.keys(held)) held[key] = false;
    applySpeed();
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  setPose(initialPose);
  applySpeed();

  return {
    camera,
    controls,
    initialPose,
    getPose,
    setPose,
    reset() { setPose(initialPose); },
    setAspect(aspect) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },

    update(now) {
      const dtMs = lastUpdateMs === null ? 0 : Math.max(0, Math.min(100, now - lastUpdateMs));
      lastUpdateMs = now;
      const horizontal = (held.right ? 1 : 0) - (held.left ? 1 : 0);
      const vertical = (held.down ? 1 : 0) - (held.up ? 1 : 0);
      const anyHeld = horizontal !== 0 || vertical !== 0;
      const speed = CAMERA.keyboardSpeedRadPerSec
        * (horizontal !== 0 && vertical !== 0 ? Math.SQRT1_2 : 1)
        * (held.shift ? CAMERA.shiftSpeedMultiplier : 1);
      // Ease toward the commanded speed; quickly on press, slowly on release.
      const ease = 1 - Math.exp(-dtMs / (anyHeld ? CAMERA.keyboardResponseMs : CAMERA.keyboardDecayMs));
      keyboardVelocity.theta += (horizontal * speed - keyboardVelocity.theta) * ease;
      keyboardVelocity.phi += (vertical * speed - keyboardVelocity.phi) * ease;
      if (Math.abs(keyboardVelocity.theta) > 1e-5 || Math.abs(keyboardVelocity.phi) > 1e-5) {
        orbitBy(keyboardVelocity.theta * dtMs / 1000, keyboardVelocity.phi * dtMs / 1000);
      }
      controls.update();
    },

    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      controls.dispose();
    },
  };
}
