import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBoundaryFrameIndex } from '../../tools/boundary-index.mjs';

test('boundary index keeps nearest four and explicitly censuses overflow', () => {
  const fieldSize = 64;
  const uv1 = [];
  const seamPairs = Array.from({ length: 5 }, (_, pairIndex) => {
    const vertex = pairIndex * 4;
    uv1.push(0.1, 8.5 / fieldSize, 0.9, 8.5 / fieldSize, 0.1, 0.8, 0.9, 0.8);
    return { sides: [
      { vertex0: vertex, vertex1: vertex + 1, chartId: 1 },
      { vertex0: vertex + 2, vertex1: vertex + 3, chartId: 2 },
    ] };
  });
  const frames = seamPairs.map((_, pairIndex) => ({
    id: pairIndex + 1,
    pairIndex,
    direction: 0,
    sourceChart: 1,
  }));
  const owner = new Uint32Array(fieldSize ** 2).fill(1);
  const result = buildBoundaryFrameIndex(
    { seamPairs },
    { fieldSize, uv1: Float32Array.from(uv1), target: { densityScale: 1 } },
    { frames },
    owner,
  );
  const texelIndex = 8 * fieldSize + 32;
  assert.equal(result.candidateCounts[texelIndex], 5);
  assert.equal(result.frameListCounts[texelIndex], 4);
  assert.deepEqual([...result.frameLists.subarray(texelIndex * 4, texelIndex * 4 + 4)], [1, 2, 3, 4]);
  assert.equal(result.nearestFrame[texelIndex], 1);
  assert.ok(result.overflowTexels.includes(texelIndex));
});
