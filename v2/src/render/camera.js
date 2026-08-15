import { MOUSE, Matrix4, PerspectiveCamera } from '../../vendor/three.module.js';
import { OrbitControls } from '../../vendor/controls/OrbitControls.js';

export const LOOK_CAMERA_CONSTANTS = Object.freeze({
  fovDegrees: 42.8571,
  nearWorld: 0.04,
  farWorld: 1200,
  initialWorldPosition: Object.freeze([1.893468, 5.498426, -5.633916]),
  targetWorldPosition: Object.freeze([0, 0, 0]),
  dampingFactor: 0.07,
  rotateSpeed: 0.65,
  zoomSpeed: 0.7,
  shiftSpeedMultiplier: 1 / 3,
  minDistanceWorld: 3.2,
  maxDistanceWorld: 22.4,
  maxPolarAngleRadians: Math.PI / 2 - 0.04,
});

export function createLookCamera({ device, registry, canvas }) {
  const constants = LOOK_CAMERA_CONSTANTS;
  const camera = new PerspectiveCamera(
    constants.fovDegrees,
    Math.max(canvas.clientWidth, 1) / Math.max(canvas.clientHeight, 1),
    constants.nearWorld,
    constants.farWorld,
  );
  camera.position.set(...constants.initialWorldPosition);
  camera.lookAt(...constants.targetWorldPosition);
  camera.updateMatrixWorld(true);

  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = constants.dampingFactor;
  controls.rotateSpeed = constants.rotateSpeed;
  controls.zoomSpeed = constants.zoomSpeed;
  controls.minDistance = constants.minDistanceWorld;
  controls.maxDistance = constants.maxDistanceWorld;
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = constants.maxPolarAngleRadians;
  controls.target.set(...constants.targetWorldPosition);
  controls.update();
  const disposeSpeedModifiers = installOrbitSpeedModifiers(canvas, controls, constants);

  const uniformBuffer = registry.createBuffer({
    label: 'look-camera-uniforms',
    size: 80,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const uniformValues = new Float32Array(20);
  const viewProjection = new Matrix4();
  let lastAspect = camera.aspect;

  function update(width, height) {
    const aspect = Math.max(width, 1) / Math.max(height, 1);
    if (aspect !== lastAspect) {
      lastAspect = aspect;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
    controls.update();
    camera.updateMatrixWorld(true);
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    uniformValues.set(viewProjection.elements, 0);
    uniformValues[16] = camera.position.x;
    uniformValues[17] = camera.position.y;
    uniformValues[18] = camera.position.z;
    uniformValues[19] = 1;
    device.queue.writeBuffer(uniformBuffer, 0, uniformValues);
  }

  update(canvas.clientWidth, canvas.clientHeight);
  return {
    camera,
    controls,
    uniformBuffer,
    update,
    dispose() {
      disposeSpeedModifiers();
      controls.dispose();
    },
  };
}

function installOrbitSpeedModifiers(canvas, controls, constants) {
  const defaultLeftAction = controls.mouseButtons.LEFT;
  const inputMultiplier = (event) => (event.shiftKey ? constants.shiftSpeedMultiplier : 1);

  const handlePointerDown = (event) => {
    controls.rotateSpeed = constants.rotateSpeed * inputMultiplier(event);
    // OrbitControls normally interprets Shift+left as pan. Selecting its PAN action here makes
    // that same branch choose rotate, while enablePan remains false (parity checklist §4).
    if (event.button === 0 && event.shiftKey) controls.mouseButtons.LEFT = MOUSE.PAN;
  };
  const handlePointerMove = (event) => {
    controls.rotateSpeed = constants.rotateSpeed * inputMultiplier(event);
  };
  const handlePointerEnd = () => {
    controls.rotateSpeed = constants.rotateSpeed;
    controls.mouseButtons.LEFT = defaultLeftAction;
  };
  const handleWheel = (event) => {
    controls.zoomSpeed = constants.zoomSpeed * inputMultiplier(event);
    queueMicrotask(() => {
      controls.zoomSpeed = constants.zoomSpeed;
    });
  };

  canvas.addEventListener('pointerdown', handlePointerDown, { capture: true });
  canvas.addEventListener('pointermove', handlePointerMove, { capture: true });
  canvas.addEventListener('pointerup', handlePointerEnd, { capture: true });
  canvas.addEventListener('pointercancel', handlePointerEnd, { capture: true });
  canvas.addEventListener('wheel', handleWheel, { capture: true, passive: true });
  return () => {
    canvas.removeEventListener('pointerdown', handlePointerDown, { capture: true });
    canvas.removeEventListener('pointermove', handlePointerMove, { capture: true });
    canvas.removeEventListener('pointerup', handlePointerEnd, { capture: true });
    canvas.removeEventListener('pointercancel', handlePointerEnd, { capture: true });
    canvas.removeEventListener('wheel', handleWheel, { capture: true });
  };
}
