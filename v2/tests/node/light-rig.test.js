import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ICOSA_FACE_VERTEX_INDICES,
  ICOSA_LIGHTS,
  ICOSA_LIGHT_CONSTANTS,
  ICOSA_LIGHT_VARIANTS,
  makeIcosaLightUniformData,
  selectIcosaLightVariant,
} from '../../src/render/light-rig.js';

test('icosa light table matches the 12 anchored vertices and 20 face centres', () => {
  assert.equal(ICOSA_LIGHTS.length, 32);
  assert.equal(ICOSA_LIGHTS.filter(({ kind }) => kind === 'vertex').length, 12);
  assert.equal(ICOSA_LIGHTS.filter(({ kind }) => kind === 'face-centre').length, 20);
  assert.deepEqual(ICOSA_FACE_VERTEX_INDICES[0], [0, 1, 8]);
  assert.deepEqual(ICOSA_FACE_VERTEX_INDICES.at(-1), [7, 9, 11]);

  const expectedRadius = ICOSA_LIGHT_CONSTANTS.surfaceWorldSize
    * ICOSA_LIGHT_CONSTANTS.radiusMultiplier;
  for (const light of ICOSA_LIGHTS) {
    assert.ok(Math.abs(Math.hypot(...light.unitDirection) - 1) < 1e-12);
    assert.equal(light.baseRadiance, 1);
    if (light.kind === 'vertex') {
      assert.ok(Math.abs(Math.hypot(...light.worldPosition) - expectedRadius) < 1e-12);
    }
  }

  const firstFace = ICOSA_LIGHTS[12];
  const expectedFirstFace = [0, 1, 8].map((_, axis) => (
    (ICOSA_LIGHTS[0].worldPosition[axis]
      + ICOSA_LIGHTS[1].worldPosition[axis]
      + ICOSA_LIGHTS[8].worldPosition[axis]) / 3
  ));
  assert.deepEqual(firstFace.worldPosition, expectedFirstFace);
});

test('12-light and 32-light variants preserve the anchored total radiance', () => {
  assert.deepEqual(selectIcosaLightVariant(false), ICOSA_LIGHT_VARIANTS.vertices);
  assert.deepEqual(selectIcosaLightVariant(true), ICOSA_LIGHT_VARIANTS.verticesAndFaces);
  for (const variant of Object.values(ICOSA_LIGHT_VARIANTS)) {
    assert.equal(variant.activeCount * variant.radianceScale, 12);
  }
  const uniformData = makeIcosaLightUniformData();
  assert.equal(uniformData.length, 32 * 4);
  assert.ok(Array.from({ length: 32 }, (_, index) => uniformData[index * 4 + 3]).every((w) => w === 1));
});
