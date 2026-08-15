import assert from 'node:assert/strict';
import test from 'node:test';
import { childId64, counterRandomFloat, counterRandomU32, pcgHash32 } from '../../src/sim/rng.js';

test('PCG hash fixed vectors agree with an independent u32 transcription', () => {
  const inputs = [0, 1, 0x1234_5678, 0xffff_ffff, 0x9e37_79b9];
  const expected = inputs.map(referencePcg);
  assert.deepEqual(inputs.map(pcgHash32), expected);
  assert.deepEqual(expected, [129708002, 2831084092, 2572358369, 3861530882, 2419168863]);
});

test('counter streams and child ids depend on the full persistent identity', () => {
  const vectors = [
    [0, 0, 0, 0],
    [7, 11, 13, 17],
    [0x1_0000, 1, 13, 17],
    [0xffff_ffff, 0xffff_fffe, 0xffff_fffd, 0xffff_fffc],
  ];
  const expected = [811119263, 820823597, 2092974929, 1899254783];
  assert.deepEqual(vectors.map((vector) => counterRandomU32(...vector)), expected);
  assert.deepEqual(vectors.map(referenceCounter), expected);
  assert.notEqual(counterRandomU32(7, 11, 13, 17), counterRandomU32(7, 12, 13, 17));
  // These identities collapsed to the same key under idLo ^ rotl(idHi, 16).
  assert.notEqual(counterRandomU32(0, 0, 13, 17), counterRandomU32(0x1_0000, 1, 13, 17));
  assert.notEqual(counterRandomU32(7, 11, 13, 17), counterRandomU32(7, 11, 14, 17));
  assert.notEqual(counterRandomU32(7, 11, 13, 17), counterRandomU32(7, 11, 13, 18));
  assert.notDeepEqual(childId64(7, 11, 13, 0), childId64(7, 11, 13, 1));
  for (let stream = 0; stream < 10_000; stream += 1) {
    assert.ok(counterRandomFloat(0xffff_ffff, 0xffff_fffe, 0xffff_fffd, stream) < 1);
  }
});

function referencePcg(input) {
  const state = (Math.imul(input >>> 0, 747796405) + 2891336453) >>> 0;
  const shifted = ((state >>> (((state >>> 28) + 4) >>> 0)) ^ state) >>> 0;
  const word = Math.imul(shifted, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

function referenceCounter([idLo, idHi, stepIndex, streamId]) {
  const loLane = referencePcg((idLo
    ^ Math.imul(stepIndex, 0x9e37_79b9)
    ^ Math.imul(streamId, 0x85eb_ca6b)) >>> 0);
  const hiLane = referencePcg((idHi
    ^ Math.imul(stepIndex, 0x7f4a_7c15)
    ^ Math.imul(streamId, 0xc2b2_ae35)) >>> 0);
  const rotatedHi = ((hiLane << 16) | (hiLane >>> 16)) >>> 0;
  return referencePcg((loLane ^ rotatedHi) >>> 0);
}
