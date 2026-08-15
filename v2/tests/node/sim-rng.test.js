import assert from 'node:assert/strict';
import test from 'node:test';
import { childId64, counterRandomU32, pcgHash32 } from '../../src/sim/rng.js';

test('PCG hash fixed vectors agree with an independent u32 transcription', () => {
  const inputs = [0, 1, 0x1234_5678, 0xffff_ffff, 0x9e37_79b9];
  const expected = inputs.map(referencePcg);
  assert.deepEqual(inputs.map(pcgHash32), expected);
  assert.deepEqual(expected, [129708002, 2831084092, 2572358369, 3861530882, 2419168863]);
});

test('counter streams and child ids depend on the full persistent identity', () => {
  assert.notEqual(counterRandomU32(7, 11, 13, 17), counterRandomU32(7, 12, 13, 17));
  assert.notEqual(counterRandomU32(7, 11, 13, 17), counterRandomU32(7, 11, 14, 17));
  assert.notEqual(counterRandomU32(7, 11, 13, 17), counterRandomU32(7, 11, 13, 18));
  assert.notDeepEqual(childId64(7, 11, 13, 0), childId64(7, 11, 13, 1));
});

function referencePcg(input) {
  const state = (Math.imul(input >>> 0, 747796405) + 2891336453) >>> 0;
  const shifted = ((state >>> (((state >>> 28) + 4) >>> 0)) ^ state) >>> 0;
  const word = Math.imul(shifted, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}
