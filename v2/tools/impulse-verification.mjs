import { diffuseWithLedger } from '../src/atlas/fill.js';
import { triangleJacobian } from './seams.mjs';

export const IMPULSE_SPREAD_RELATIVE_LIMIT = 0.25;

export function verifyImpulseSpread(mesh, repack, raster, requestedSamples = 8, stepCount = 4) {
  const atlas = {
    fieldSize: repack.fieldSize,
    authoritativeOwner: raster.authoritativeOwner,
    gutter: raster.gutter,
    chartTable: repack.chartTable,
  };
  const candidates = impulseCandidates(mesh, repack, raster);
  if (!candidates.length && mesh.fixtureSeamPairIndices?.length === 0) {
    return {
      sampleCount: 0,
      stepCount,
      traceViolations: 0,
      ellipticityViolations: 0,
      maximumTraceMismatch: 0,
      maximumEllipticityMismatch: 0,
      rows: [],
      skippedReason: 'fixture declares no connected surface seam',
    };
  }
  if (!candidates.length) throw new Error('impulse: no seam-interior authoritative source texel');
  const selected = evenlySpaced(candidates, Math.min(requestedSamples, candidates.length));
  const rows = selected.map((candidate) => measureOneImpulse(mesh, repack, raster, atlas, candidate, stepCount));
  const traceViolations = rows.filter(({ traceRatio }) => Math.abs(traceRatio - 1) > IMPULSE_SPREAD_RELATIVE_LIMIT).length;
  const ellipticityViolations = rows.filter(({ ellipticityRatio }) => Math.abs(ellipticityRatio - 1) > IMPULSE_SPREAD_RELATIVE_LIMIT).length;
  return {
    sampleCount: rows.length,
    stepCount,
    traceViolations,
    ellipticityViolations,
    maximumTraceMismatch: maximum(rows.map(({ traceRatio }) => Math.abs(traceRatio - 1))),
    maximumEllipticityMismatch: maximum(rows.map(({ ellipticityRatio }) => Math.abs(ellipticityRatio - 1))),
    rows,
  };
}

function impulseCandidates(mesh, repack, raster) {
  const rows = [];
  const pairIndices = mesh.fixtureSeamPairIndices ?? mesh.seamPairs.map((_, pairIndex) => pairIndex);
  for (const pairIndex of pairIndices) {
    const pair = mesh.seamPairs[pairIndex]; const source = pair.sides[0];
    const start = vertex2(repack.uv1, source.vertex0); const end = vertex2(repack.uv1, source.vertex1);
    const lengthTexels = distance2(start, end) * repack.fieldSize;
    if (lengthTexels < repack.target.gutterTexels * 3) continue;
    const midpoint = start.map((value, axis) => (value + end[axis]) * 0.5);
    const inward = sourceInwardUv(mesh, repack.uv1, source);
    const sourceUv = midpoint.map((value, axis) => value + inward[axis] * 1.5 / repack.fieldSize);
    const texel = uvTexel(sourceUv, repack.fieldSize);
    if (texel < 0 || raster.authoritativeOwner[texel] !== source.chartId) continue;
    const sourceDensity = repack.chartTable[source.chartId - 1].texelDensityFactor;
    const destinationDensity = repack.chartTable[pair.sides[1].chartId - 1].texelDensityFactor;
    rows.push({ pairIndex, source, texel, lengthTexels, densityRatio: destinationDensity / sourceDensity });
  }
  return rows.sort((left, right) => Math.log(left.densityRatio) - Math.log(right.densityRatio));
}

function measureOneImpulse(mesh, repack, raster, atlas, candidate, stepCount) {
  const owner = raster.authoritativeOwner[candidate.texel];
  const texelArea = repack.chartTable[owner - 1].worldAreaPerTexel;
  let field = new Float64Array(raster.authoritativeOwner.length);
  field[candidate.texel] = 1 / texelArea;
  for (let step = 0; step < stepCount; step += 1) field = diffuseWithLedger(field, atlas).field;
  const moments = worldMoments(field, raster, repack);
  const jacobian = triangleJacobian(mesh, repack.uv1, candidate.source.triangleIndex);
  const varianceUv = stepCount * (2 / 3) / repack.fieldSize ** 2;
  const expectedMetric = metricEigenvalues(jacobian);
  const expectedTrace = varianceUv * (expectedMetric[0] + expectedMetric[1]);
  const expectedEllipticity = expectedMetric[0] / expectedMetric[1];
  const actualEllipticity = moments.eigenvalues[0] / Math.max(1e-30, moments.eigenvalues[1]);
  return {
    pairIndex: candidate.pairIndex,
    chartId: owner,
    densityRatio: candidate.densityRatio,
    traceRatio: moments.trace / expectedTrace,
    ellipticityRatio: actualEllipticity / expectedEllipticity,
    mass: moments.mass,
  };
}

function worldMoments(field, raster, repack) {
  let mass = 0; const mean = [0, 0, 0];
  for (let texel = 0; texel < raster.authoritativeOwner.length; texel += 1) {
    const chartId = raster.authoritativeOwner[texel];
    if (!chartId || field[texel] === 0) continue;
    const weight = field[texel] * repack.chartTable[chartId - 1].worldAreaPerTexel;
    mass += weight;
    for (let axis = 0; axis < 3; axis += 1) mean[axis] += weight * raster.worldPos[texel * 3 + axis];
  }
  for (let axis = 0; axis < 3; axis += 1) mean[axis] /= mass;
  const covariance = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let texel = 0; texel < raster.authoritativeOwner.length; texel += 1) {
    const chartId = raster.authoritativeOwner[texel];
    if (!chartId || field[texel] === 0) continue;
    const weight = field[texel] * repack.chartTable[chartId - 1].worldAreaPerTexel;
    const offset = [0, 1, 2].map((axis) => raster.worldPos[texel * 3 + axis] - mean[axis]);
    for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) {
      covariance[row][column] += weight * offset[row] * offset[column] / mass;
    }
  }
  const eigenvalues = symmetricEigenvalues3(covariance);
  return { mass, mean, covariance, eigenvalues, trace: eigenvalues.reduce((sum, value) => sum + value, 0) };
}

function metricEigenvalues(jacobian) {
  const g00 = dot3(jacobian.dU, jacobian.dU); const g01 = dot3(jacobian.dU, jacobian.dV); const g11 = dot3(jacobian.dV, jacobian.dV);
  const discriminant = Math.sqrt((g00 - g11) ** 2 + 4 * g01 ** 2);
  return [(g00 + g11 + discriminant) * 0.5, (g00 + g11 - discriminant) * 0.5];
}

function symmetricEigenvalues3(matrix) {
  const p1 = matrix[0][1] ** 2 + matrix[0][2] ** 2 + matrix[1][2] ** 2;
  if (p1 === 0) return [matrix[0][0], matrix[1][1], matrix[2][2]].sort((a, b) => b - a);
  const q = (matrix[0][0] + matrix[1][1] + matrix[2][2]) / 3;
  const p2 = (matrix[0][0] - q) ** 2 + (matrix[1][1] - q) ** 2 + (matrix[2][2] - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const normalized = matrix.map((row, y) => row.map((value, x) => (value - (x === y ? q : 0)) / p));
  const r = determinant3(normalized) / 2;
  const phi = Math.acos(Math.max(-1, Math.min(1, r))) / 3;
  const first = q + 2 * p * Math.cos(phi);
  const third = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
  return [first, 3 * q - first - third, third].sort((a, b) => b - a);
}

function sourceInwardUv(mesh, uv, side) {
  const start = vertex2(uv, side.vertex0); const end = vertex2(uv, side.vertex1);
  const edge = subtract2(end, start); let normal = normalize2([-edge[1], edge[0]]);
  const opposite = [...mesh.indices.subarray(side.triangleIndex * 3, side.triangleIndex * 3 + 3)]
    .find((vertex) => vertex !== side.vertex0 && vertex !== side.vertex1);
  const midpoint = start.map((value, axis) => (value + end[axis]) * 0.5);
  if (dot2(normal, subtract2(vertex2(uv, opposite), midpoint)) < 0) normal = normal.map((value) => -value);
  return normal;
}

function evenlySpaced(rows, count) { return Array.from({ length: count }, (_, index) => rows[Math.floor((index + 0.5) / count * rows.length)]); }
function uvTexel(uv, fieldSize) { if (uv.some((value) => value < 0 || value >= 1)) return -1; return Math.floor(uv[1] * fieldSize) * fieldSize + Math.floor(uv[0] * fieldSize); }
function determinant3(m) { return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]); }
function maximum(values) { return values.length ? Math.max(...values) : 0; }
function vertex2(values, vertex) { return [values[vertex * 2], values[vertex * 2 + 1]]; }
function subtract2(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function normalize2(value) { const length = Math.hypot(...value); return value.map((axis) => axis / length); }
function dot2(a, b) { return a[0] * b[0] + a[1] * b[1]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function distance2(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
