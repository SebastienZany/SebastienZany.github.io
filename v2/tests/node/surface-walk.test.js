import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSurfaceTopology,
  walkSurfaceOffset,
} from '../../tools/surface-walk.mjs';

test('surface walk preserves transverse distance through an 80-degree hinge', () => {
  const fixture = foldedPair(80);
  const topology = buildSurfaceTopology(fixture.mesh, { allowBoundary: true });
  const result = walkSurfaceOffset({
    ...fixture,
    topology,
    sourceSide: fixture.pair.sides[0],
    destinationSide: fixture.pair.sides[1],
    boundaryUvPos: [0.25, 0],
    edgeFraction: 0.25,
    offsetUv: [0, -0.2],
  });
  nearVector(result.uvPos, [0.25, 0.2], 1e-6);
  assert.equal(result.triangleIndex, 1);
});

test('surface walk crosses as many adjacent triangles as the distance requires', () => {
  const fixture = planarStrip();
  const topology = buildSurfaceTopology(fixture.mesh, { allowBoundary: true });
  const result = walkSurfaceOffset({
    ...fixture,
    topology,
    sourceSide: fixture.pair.sides[0],
    destinationSide: fixture.pair.sides[1],
    boundaryUvPos: [0.25, 0],
    edgeFraction: 0.25,
    offsetUv: [0, -1.5],
  });
  nearVector(result.uvPos, [0.25, 1.5], 1e-6);
  assert.ok(result.triangleHopCount >= 2);
});

function foldedPair(angleDegrees) {
  const angle = angleDegrees * Math.PI / 180;
  const mesh = {
    positions: Float32Array.of(
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0, 1, 0, 0, 0, -Math.cos(angle), Math.sin(angle),
    ),
    indices: Uint32Array.of(0, 1, 2, 4, 3, 5),
    triangleChartIds: Uint32Array.of(1, 2),
  };
  const uv1 = Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
  const pair = { sides: [
    { triangleIndex: 0, vertex0: 0, vertex1: 1, chartId: 1 },
    { triangleIndex: 1, vertex0: 3, vertex1: 4, chartId: 2 },
  ] };
  return { mesh, uv1, pair };
}

function planarStrip() {
  const mesh = {
    positions: Float32Array.of(
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0, 1, 0, 0, 0, -1, 0, 1, -1, 0, 0, -2, 0, 1, -2, 0,
    ),
    indices: Uint32Array.of(
      0, 1, 2,
      4, 3, 5, 4, 5, 6,
      6, 5, 7, 6, 7, 8,
    ),
    triangleChartIds: Uint32Array.of(1, 2, 2, 2, 2),
  };
  const uv1 = Float32Array.of(
    0, 0, 1, 0, 0, 1,
    0, 0, 1, 0, 0, 1, 1, 1, 0, 2, 1, 2,
  );
  const pair = { sides: [
    { triangleIndex: 0, vertex0: 0, vertex1: 1, chartId: 1 },
    { triangleIndex: 1, vertex0: 3, vertex1: 4, chartId: 2 },
  ] };
  return { mesh, uv1, pair };
}

function nearVector(actual, expected, epsilon) {
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= epsilon, `${index}: ${value}`));
}
