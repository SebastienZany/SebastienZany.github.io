import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bakeSurfaceFieldTexels,
  surfaceFieldValueAtWorld,
} from '../../src/render/surface-field.js';

test('surface field evaluates one deterministic continuous function in world-space', () => {
  const value = surfaceFieldValueAtWorld(0.25, -0.5, 0.75);
  assert.equal(value, surfaceFieldValueAtWorld(0.25, -0.5, 0.75));
  assert.ok(value >= 0);
  assert.notEqual(value, surfaceFieldValueAtWorld(0.75, -0.5, 0.25));
});

test('surface field rasterizes uv0 texel centres through mesh world positions', () => {
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0.5,
    1, 1, 1,
    0, 1, 0.5,
  ]);
  const uv0 = new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const size = 4;
  const bake = bakeSurfaceFieldTexels({ positions, uv0, indices, size });

  assert.equal(bake.paintedTexelCount, size * size);
  assert.equal(bake.degenerateTriangleCount, 0);
  for (let texelY = 0; texelY < size; texelY += 1) {
    for (let texelX = 0; texelX < size; texelX += 1) {
      const worldX = (texelX + 0.5) / size;
      const worldY = (texelY + 0.5) / size;
      const worldZ = (worldX + worldY) * 0.5;
      assert.ok(Math.abs(
        bake.values[texelY * size + texelX]
          - surfaceFieldValueAtWorld(worldX, worldY, worldZ),
      ) < 1e-6);
    }
  }
});
