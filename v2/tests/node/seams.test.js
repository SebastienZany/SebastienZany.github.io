import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FRAME_FLOATS,
  applyFrame,
  buildDirectionalFrames,
  directionalFrame,
  transportHeading,
} from '../../tools/seams.mjs';

for (const angleDegrees of [45, 80]) {
  test(`hinge affine unfolds a ${angleDegrees}-degree seam transversely`, () => {
    const { mesh, uv1, pair } = foldedPair(angleDegrees);
    const frame = directionalFrame(mesh, uv1, pair, 0, 0, 128);
    // Fixture attributes are f32; 1e-6 is below one 128-wide fixture texel by five orders.
    nearVector(applyFrame(frame, [0.25, -0.2]), [0.25, 0.2], 1e-6);
    nearVector(transportHeading(frame, [0, -1]), [0, 1], 1e-6);
    const legacyTransverse = frame.legacyMatrix.m11 * -0.2;
    assert.ok(Math.abs(legacyTransverse - 0.2) > 0.05, 'the negative control must expose fold collapse');
  });
}

test('coplanar hinge affine reduces to the legacy projection matrix', () => {
  const { mesh, uv1, pair } = foldedPair(0, { destinationUvScale: [1.7, 0.6] });
  const frame = directionalFrame(mesh, uv1, pair, 0, 0, 128);
  for (const key of ['m00', 'm01', 'm10', 'm11']) {
    assert.ok(Math.abs(frame.matrix[key] - frame.legacyMatrix[key]) < 1e-12, key);
  }
  nearVector(applyFrame(frame, frame.srcRef), frame.dstRef, 1e-6);
  nearVector(applyFrame(frame, [1, 0]), [1.7, 0], 1e-6);
});

test('frame table is directional, size-bound, and reserves record zero', () => {
  const { mesh, uv1, pair } = foldedPair(45);
  mesh.seamPairs = [pair];
  const table = buildDirectionalFrames(mesh, { uv1, fieldSize: 64 });
  assert.equal(table.frameCount, 2);
  assert.equal(table.frameData.length, 3 * FRAME_FLOATS);
  assert.ok(table.frameData.subarray(0, FRAME_FLOATS).every((value) => value === 0));
  assert.equal(table.frames[0].sourceChart, 1);
  assert.equal(table.frames[1].sourceChart, 2);
  assert.equal(table.frames[0].sourceLengthTexels, 64);
});

function foldedPair(angleDegrees, { destinationUvScale = [1, 1] } = {}) {
  const angle = angleDegrees * Math.PI / 180;
  const positions = Float32Array.of(
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 0, 1, 0, 0, 0, -Math.cos(angle), Math.sin(angle),
  );
  const mesh = {
    positions,
    indices: Uint32Array.of(0, 1, 2, 4, 3, 5),
  };
  const uv1 = Float32Array.of(
    0, 0, 1, 0, 0, 1,
    0, 0, destinationUvScale[0], 0, 0, destinationUvScale[1],
  );
  const pair = {
    sides: [
      { triangleIndex: 0, vertex0: 0, vertex1: 1, chartId: 1 },
      { triangleIndex: 1, vertex0: 3, vertex1: 4, chartId: 2 },
    ],
    foldAngleRadians: angle,
    sourcePairIndex: 0,
  };
  return { mesh, uv1, pair };
}

function nearVector(actual, expected, epsilon) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= epsilon, `${index}: ${value}`));
}
