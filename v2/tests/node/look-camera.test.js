import assert from 'node:assert/strict';
import test from 'node:test';
import { LOOK_CAMERA_CONSTANTS } from '../../src/render/camera.js';
import { MAX_BUMP_TAP_RADIUS_TEXELS } from '../../src/render/material-uniforms.js';

test('look camera carries every anchored parity constant', () => {
  assert.equal(LOOK_CAMERA_CONSTANTS.fovDegrees, 42.8571);
  assert.equal(LOOK_CAMERA_CONSTANTS.nearWorld, 0.04);
  assert.equal(LOOK_CAMERA_CONSTANTS.farWorld, 1200);
  assert.deepEqual(LOOK_CAMERA_CONSTANTS.initialWorldPosition, [1.893468, 5.498426, -5.633916]);
  assert.deepEqual(LOOK_CAMERA_CONSTANTS.targetWorldPosition, [0, 0, 0]);
  assert.equal(LOOK_CAMERA_CONSTANTS.dampingFactor, 0.07);
  assert.equal(LOOK_CAMERA_CONSTANTS.rotateSpeed, 0.65);
  assert.equal(LOOK_CAMERA_CONSTANTS.zoomSpeed, 0.7);
  assert.equal(LOOK_CAMERA_CONSTANTS.shiftSpeedMultiplier, 1 / 3);
  assert.equal(LOOK_CAMERA_CONSTANTS.minDistanceWorld, 3.2);
  assert.equal(LOOK_CAMERA_CONSTANTS.maxDistanceWorld, 22.4);
  assert.equal(LOOK_CAMERA_CONSTANTS.maxPolarAngleRadians, Math.PI / 2 - 0.04);
  assert.equal(MAX_BUMP_TAP_RADIUS_TEXELS, 2.33);
});
