import assert from 'node:assert/strict';
import test from 'node:test';
import {
  float16ToFloat32,
  float32ToFloat16,
  measureFloat16WorldError,
} from '../../tools/float16.mjs';

test('float16 conversion preserves finite representative values within half precision', () => {
  for (const value of [0, -0, 1, -2.5, 0.001, 4.8]) {
    const restored = float16ToFloat32(float32ToFloat16(value));
    assert.ok(Math.abs(restored - value) <= Math.max(1e-6, Math.abs(value) / 1_000));
  }
});

test('world precision decision compares vector error with one eighth of the kernel', () => {
  const worldPos = Float32Array.of(1.0001, 2.0001, 3.0001, 0, 0, 0);
  const result = measureFloat16WorldError(worldPos, Uint32Array.of(1, 0), 0.1);
  assert.equal(result.storage, 'f16');
  assert.ok(result.worstPositionError < result.threshold);
});
