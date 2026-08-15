import { WEIGHT_QUANTIZATION_SUM } from './atlas-constants.mjs';

export function buildDonorStencil(endpointUv, chartId, owner, fieldSize) {
  const bilinear = bilinearStencil(endpointUv, chartId, owner, fieldSize);
  if (bilinear) return { ...bilinear, stencilClass: 'exact-bilinear', positionErrorTexels: 0 };
  const taps = nearestAuthoritative(endpointUv, chartId, owner, fieldSize);
  if (!taps.length) throw new Error(`stencil: chart ${chartId} has no authoritative texel`);
  const point = [endpointUv[0] * fieldSize, endpointUv[1] * fieldSize];
  const solution = solveMomentWeights(taps.map((tap) => tap.center), point);
  const paddedIndices = taps.map((tap) => tap.index);
  const paddedWeights = [...solution.weights];
  while (paddedIndices.length < 4) {
    paddedIndices.push(paddedIndices[0]);
    paddedWeights.push(0);
  }
  return {
    tapIndices: Uint32Array.from(paddedIndices),
    weights: Float64Array.from(paddedWeights),
    stencilClass: solution.nonnegative && solution.positionErrorTexels <= 1e-6
      ? 'nonnegative-moment'
      : 'degraded',
    positionErrorTexels: solution.positionErrorTexels,
    hasNegativeWeight: solution.weights.some((weight) => weight < -1e-12),
  };
}

export function quantizeNonnegativeWeights(weights) {
  if (weights.some((weight) => weight < -1e-12)) {
    throw new Error('stencil: signed degraded weights have no deployed u16 encoding (see BLOCKERS.md)');
  }
  const normalized = [...weights].map((weight) => Math.max(0, weight));
  const sum = normalized.reduce((total, weight) => total + weight, 0);
  if (!(sum > 0)) throw new Error('stencil: zero weight sum');
  const quantized = Uint16Array.from(normalized, (weight) => Math.round(weight / sum * WEIGHT_QUANTIZATION_SUM));
  const largestIndex = normalized.reduce((best, weight, index) => weight > normalized[best] ? index : best, 0);
  const residual = WEIGHT_QUANTIZATION_SUM - quantized.reduce((total, weight) => total + weight, 0);
  const corrected = quantized[largestIndex] + residual;
  if (corrected < 0 || corrected > WEIGHT_QUANTIZATION_SUM) throw new Error('stencil: quantization residual overflow');
  quantized[largestIndex] = corrected;
  return quantized;
}

function bilinearStencil(endpointUv, chartId, owner, fieldSize) {
  const sampleX = endpointUv[0] * fieldSize - 0.5;
  const sampleY = endpointUv[1] * fieldSize - 0.5;
  const x0 = Math.floor(sampleX); const y0 = Math.floor(sampleY);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= fieldSize || y0 + 1 >= fieldSize) return null;
  const coordinates = [[x0, y0], [x0 + 1, y0], [x0, y0 + 1], [x0 + 1, y0 + 1]];
  const tapIndices = coordinates.map(([x, y]) => y * fieldSize + x);
  if (tapIndices.some((index) => owner[index] !== chartId)) return null;
  const fractionX = sampleX - x0; const fractionY = sampleY - y0;
  return {
    tapIndices: Uint32Array.from(tapIndices),
    weights: Float64Array.of(
      (1 - fractionX) * (1 - fractionY),
      fractionX * (1 - fractionY),
      (1 - fractionX) * fractionY,
      fractionX * fractionY,
    ),
    hasNegativeWeight: false,
  };
}

function nearestAuthoritative(endpointUv, chartId, owner, fieldSize) {
  const point = [endpointUv[0] * fieldSize, endpointUv[1] * fieldSize];
  const centerX = Math.floor(point[0]); const centerY = Math.floor(point[1]);
  const candidates = [];
  for (let radius = 0; radius <= 32 && candidates.length < 4; radius += 1) {
    for (let y = centerY - radius; y <= centerY + radius; y += 1) {
      for (let x = centerX - radius; x <= centerX + radius; x += 1) {
        if (Math.max(Math.abs(x - centerX), Math.abs(y - centerY)) !== radius) continue;
        if (x < 0 || y < 0 || x >= fieldSize || y >= fieldSize) continue;
        const index = y * fieldSize + x;
        if (owner[index] !== chartId) continue;
        const center = [x + 0.5, y + 0.5];
        candidates.push({ index, center, distanceSquared: distanceSquared2(center, point) });
      }
    }
  }
  return candidates.sort((left, right) => left.distanceSquared - right.distanceSquared || left.index - right.index).slice(0, 4);
}

function solveMomentWeights(points, target) {
  const candidates = [];
  if (points.length >= 3) {
    const full = minimumNormAffine(points, target);
    if (full) candidates.push(full);
    for (const combination of combinations(points.length, 3)) {
      const subset = combination.map((index) => points[index]);
      const weights = minimumNormAffine(subset, target);
      if (!weights) continue;
      const expanded = new Array(points.length).fill(0);
      combination.forEach((pointIndex, index) => { expanded[pointIndex] = weights[index]; });
      candidates.push(expanded);
    }
  }
  const exact = candidates.map((weights) => describeWeights(points, target, weights))
    .filter((entry) => entry.positionErrorTexels <= 1e-7 && entry.weights.every((weight) => weight >= -1e-10))
    .sort(compareSolutions)[0];
  if (exact) return exact;
  const extrapolated = candidates.map((weights) => describeWeights(points, target, weights))
    .filter((entry) => entry.positionErrorTexels <= 1e-7 && entry.weights.every((weight) => Math.abs(weight) <= 2 + 1e-10))
    .sort(compareSolutions)[0];
  if (extrapolated) return extrapolated;
  return lineFallback(points, target);
}

function minimumNormAffine(points, target) {
  const count = points.length;
  const sx = points.reduce((sum, point) => sum + point[0], 0);
  const sy = points.reduce((sum, point) => sum + point[1], 0);
  const matrix = [
    [count, sx, sy],
    [sx, points.reduce((sum, point) => sum + point[0] ** 2, 0), points.reduce((sum, point) => sum + point[0] * point[1], 0)],
    [sy, points.reduce((sum, point) => sum + point[0] * point[1], 0), points.reduce((sum, point) => sum + point[1] ** 2, 0)],
  ];
  const inverse = inverse3(matrix);
  if (!inverse) return null;
  const lambda = multiply3(inverse, [1, target[0], target[1]]);
  return points.map((point) => lambda[0] + lambda[1] * point[0] + lambda[2] * point[1]);
}

function lineFallback(points, target) {
  let pair = [0, 0]; let bestDistance = -1;
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      const distance = distanceSquared2(points[first], points[second]);
      if (distance > bestDistance) { bestDistance = distance; pair = [first, second]; }
    }
  }
  const weights = new Array(points.length).fill(0);
  if (!(bestDistance > 0)) weights[0] = 1;
  else {
    const start = points[pair[0]]; const end = points[pair[1]];
    const fraction = ((target[0] - start[0]) * (end[0] - start[0]) + (target[1] - start[1]) * (end[1] - start[1])) / bestDistance;
    weights[pair[0]] = 1 - clamp(fraction, -1, 2);
    weights[pair[1]] = clamp(fraction, -1, 2);
  }
  return describeWeights(points, target, weights);
}

function describeWeights(points, target, weights) {
  const reproduced = [0, 1].map((axis) => weights.reduce((sum, weight, index) => sum + weight * points[index][axis], 0));
  return {
    weights,
    nonnegative: weights.every((weight) => weight >= -1e-10),
    positionErrorTexels: Math.hypot(reproduced[0] - target[0], reproduced[1] - target[1]),
    normSquared: weights.reduce((sum, weight) => sum + weight ** 2, 0),
  };
}

function compareSolutions(left, right) {
  return left.normSquared - right.normSquared || left.positionErrorTexels - right.positionErrorTexels;
}

function combinations(count, choose) {
  const output = [];
  const visit = (start, values) => {
    if (values.length === choose) { output.push(values); return; }
    for (let index = start; index < count; index += 1) visit(index + 1, [...values, index]);
  };
  visit(0, []);
  return output;
}

function inverse3(matrix) {
  const [a, b, c] = matrix[0]; const [d, e, f] = matrix[1]; const [g, h, i] = matrix[2];
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(determinant) < 1e-12) return null;
  const scale = 1 / determinant;
  return [
    [(e * i - f * h) * scale, (c * h - b * i) * scale, (b * f - c * e) * scale],
    [(f * g - d * i) * scale, (a * i - c * g) * scale, (c * d - a * f) * scale],
    [(d * h - e * g) * scale, (b * g - a * h) * scale, (a * e - b * d) * scale],
  ];
}

function multiply3(matrix, vector) { return matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0)); }
function distanceSquared2(a, b) { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2; }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
