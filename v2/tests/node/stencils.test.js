import assert from 'node:assert/strict';
import test from 'node:test';
import { WEIGHT_QUANTIZATION_SUM } from '../../tools/atlas-constants.mjs';
import {
  buildDonorStencil,
  quantizeNonnegativeWeights,
} from '../../tools/stencils.mjs';

test('full authoritative footprint produces the exact bilinear stencil', () => {
  const fieldSize = 8;
  const owner = new Uint32Array(fieldSize ** 2).fill(1);
  const stencil = buildDonorStencil([3 / fieldSize, 4 / fieldSize], 1, owner, fieldSize);
  assert.equal(stencil.stencilClass, 'exact-bilinear');
  assert.deepEqual([...stencil.weights], [0.25, 0.25, 0.25, 0.25]);
  assert.ok([...stencil.tapIndices].every((index) => owner[index] === 1));
});

test('u16 nonnegative quantization absorbs its residual and sums exactly', () => {
  const quantized = quantizeNonnegativeWeights([0.1, 0.2, 0.3, 0.4]);
  assert.equal(quantized.reduce((sum, value) => sum + value, 0), WEIGHT_QUANTIZATION_SUM);
});

test('outside-hull moment reconstruction is censused and refuses unsigned deployment', () => {
  const fieldSize = 8;
  const owner = new Uint32Array(fieldSize ** 2);
  for (const [x, y] of [[2, 2], [3, 2], [2, 3], [3, 3]]) owner[y * fieldSize + x] = 1;
  const stencil = buildDonorStencil([4.2 / fieldSize, 3 / fieldSize], 1, owner, fieldSize);
  assert.equal(stencil.stencilClass, 'degraded');
  assert.equal(stencil.hasNegativeWeight, true);
  assert.throws(() => quantizeNonnegativeWeights(stencil.weights), /no deployed u16 encoding/);
});
