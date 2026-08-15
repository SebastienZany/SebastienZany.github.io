import { fillGutters, transposeInnerProducts } from '../src/atlas/fill.js';
import { GUTTER_RECORD_OFFSET, WEIGHT_QUANTIZATION_SUM } from './atlas-constants.mjs';
import { applyFrame } from './seams.mjs';
import { walkSurfaceOffset } from './surface-walk.mjs';

const NO_TRIANGLE = 0xffffffff;

export function verifyCoverage(mesh, repack, raster, sampleCount = 100_000, seed = 0x5ea_2ba5) {
  const areas = triangleAreas(mesh);
  const cumulative = new Float64Array(areas.length);
  for (let index = 0; index < areas.length; index += 1) cumulative[index] = areas[index] + (cumulative[index - 1] ?? 0);
  const random = mulberry32(seed);
  let wrongChartSamples = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const triangle = lowerBound(cumulative, random() * cumulative.at(-1));
    const rootFirst = Math.sqrt(random()); const second = random();
    const barycentric = [1 - rootFirst, rootFirst * (1 - second), rootFirst * second];
    const uv = interpolateTriangle(mesh.indices, repack.uv1, triangle, barycentric, 2);
    const x = clamp(Math.floor(uv[0] * repack.fieldSize), 0, repack.fieldSize - 1);
    const y = clamp(Math.floor(uv[1] * repack.fieldSize), 0, repack.fieldSize - 1);
    if (raster.authoritativeOwner[y * repack.fieldSize + x] !== mesh.triangleChartIds[triangle]) wrongChartSamples += 1;
  }
  let missingTriangleTexels = 0; let wrongTriangleChartTexels = 0; let authoritativeTexels = 0;
  for (let texel = 0; texel < raster.authoritativeOwner.length; texel += 1) {
    const chartId = raster.authoritativeOwner[texel];
    if (!chartId) continue;
    authoritativeTexels += 1;
    const triangle = raster.triangleMap[texel];
    if (triangle === NO_TRIANGLE) missingTriangleTexels += 1;
    else if (mesh.triangleChartIds[triangle] !== chartId) wrongTriangleChartTexels += 1;
  }
  if (wrongChartSamples || missingTriangleTexels || wrongTriangleChartTexels) {
    throw new Error(
      `coverage: ${wrongChartSamples} sampled points, ${missingTriangleTexels} missing triangles, `
      + `${wrongTriangleChartTexels} wrong triangle charts`,
    );
  }
  return { sampleCount, authoritativeTexels, wrongChartSamples, missingTriangleTexels, wrongTriangleChartTexels };
}

export function verifyStencilTable(mesh, repack, raster) {
  const { gutter } = raster;
  let signedCount = 0; let nonnegativeQuantizedCount = 0;
  let maxWeightSumError = 0; let maxAbsoluteWeight = 0; let maxEndpointMomentErrorTexels = 0;
  for (let record = 0; record < gutter.recordCount; record += 1) {
    const texel = gutter.coords[record];
    if (raster.ownership[texel] !== record + GUTTER_RECORD_OFFSET) {
      throw new Error(`stencil: reverse lookup mismatch at record ${record}`);
    }
    const destinationChart = mesh.triangleChartIds[gutter.walkTriangles[record]];
    let sum = 0; let momentX = 0; let momentY = 0; let hasNegative = false;
    for (let tap = 0; tap < 4; tap += 1) {
      const offset = record * 4 + tap;
      const tapIndex = gutter.tapIndices[offset]; const weight = gutter.weights[offset];
      if (raster.authoritativeOwner[tapIndex] !== destinationChart) {
        throw new Error(`stencil: record ${record} tap ${tap} is not authoritative on its endpoint chart`);
      }
      sum += weight; hasNegative ||= weight < -1e-12;
      maxAbsoluteWeight = Math.max(maxAbsoluteWeight, Math.abs(weight));
      momentX += weight * (tapIndex % repack.fieldSize + 0.5);
      momentY += weight * (Math.floor(tapIndex / repack.fieldSize) + 0.5);
    }
    maxWeightSumError = Math.max(maxWeightSumError, Math.abs(sum - 1));
    const targetX = gutter.walkEndpointUv[record * 2] * repack.fieldSize;
    const targetY = gutter.walkEndpointUv[record * 2 + 1] * repack.fieldSize;
    maxEndpointMomentErrorTexels = Math.max(maxEndpointMomentErrorTexels, Math.hypot(momentX - targetX, momentY - targetY));
    if (hasNegative) signedCount += 1;
    else {
      nonnegativeQuantizedCount += 1;
      let quantizedSum = 0;
      for (let tap = 0; tap < 4; tap += 1) quantizedSum += gutter.partialQuantizedWeights[record * 4 + tap];
      if (quantizedSum !== WEIGHT_QUANTIZATION_SUM) throw new Error(`stencil: record ${record} quantized sum is ${quantizedSum}`);
    }
  }
  if (maxWeightSumError > 1e-7) throw new Error(`stencil: weight sum error ${maxWeightSumError}`);
  if (maxAbsoluteWeight > 2 + 1e-7) throw new Error(`stencil: bounded weight gate failed at ${maxAbsoluteWeight}`);
  if (signedCount !== gutter.census.signedDegraded) throw new Error('stencil: signed census mismatch');
  return {
    recordCount: gutter.recordCount,
    signedCount,
    nonnegativeQuantizedCount,
    maxWeightSumError,
    maxAbsoluteWeight,
    maxEndpointMomentErrorTexels,
  };
}

export function verifyTransposeIdentity(raster) {
  const authoritativeValues = Float64Array.from(raster.ownership, (_, index) => Math.sin(index * 0.017) * 0.5 + 0.5);
  const gutterValues = Float64Array.from({ length: raster.gutter.recordCount }, (_, index) => Math.cos(index * 0.031));
  const result = transposeInnerProducts(
    authoritativeValues,
    gutterValues,
    raster.gutter,
    raster.ownership.length,
  );
  const scale = Math.max(1, Math.abs(result.gatherDot), Math.abs(result.scatterDot));
  result.relativeError = result.error / scale;
  if (result.relativeError > 2e-12) throw new Error(`stencil: transpose identity relative error ${result.relativeError}`);
  return result;
}

export function measureWalkReconstruction(mesh, repack, raster, fieldFunction = smoothWorldField) {
  const source = new Float64Array(raster.ownership.length);
  for (let texel = 0; texel < raster.authoritativeOwner.length; texel += 1) {
    if (raster.authoritativeOwner[texel]) source[texel] = fieldFunction(raster.worldPos.subarray(texel * 3, texel * 3 + 3));
  }
  const filled = fillGutters(source, raster.gutter);
  const disabled = fillGutters(source, raster.gutter, { disabled: true });
  const bands = Array.from({ length: 3 }, () => ({ count: 0, maxValueError: 0, sumSquaredValueError: 0, maxPositionErrorTexels: 0 }));
  let disabledMaxValueError = 0;
  for (let record = 0; record < raster.gutter.recordCount; record += 1) {
    const triangle = raster.gutter.walkTriangles[record];
    const endpointUv = raster.gutter.walkEndpointUv.subarray(record * 2, record * 2 + 2);
    const barycentric = uvBarycentric(mesh, repack.uv1, triangle, endpointUv);
    const trueWorld = interpolateTriangle(mesh.indices, mesh.positions, triangle, barycentric, 3);
    const reference = fieldFunction(trueWorld);
    const texel = raster.gutter.coords[record];
    const valueError = Math.abs(filled[texel] - reference);
    const disabledError = Math.abs(disabled[texel] - reference);
    const positionErrorWorld = distance3(raster.worldPos.subarray(texel * 3, texel * 3 + 3), trueWorld);
    const chartId = mesh.triangleChartIds[triangle];
    const characteristicTexelWorld = Math.sqrt(repack.chartTable[chartId - 1].worldAreaPerTexel);
    const band = bands[raster.gutter.stencilClass[record]];
    band.count += 1;
    band.maxValueError = Math.max(band.maxValueError, valueError);
    band.sumSquaredValueError += valueError ** 2;
    band.maxPositionErrorTexels = Math.max(band.maxPositionErrorTexels, positionErrorWorld / characteristicTexelWorld);
    disabledMaxValueError = Math.max(disabledMaxValueError, disabledError);
  }
  for (const band of bands) band.rmsValueError = Math.sqrt(band.sumSquaredValueError / Math.max(1, band.count));
  return { bands, disabledMaxValueError };
}

export function measureAffineWalkBands(mesh, repack, frameTable, topology) {
  const rows = Array.from({ length: repack.target.gutterTexels }, (_, index) => ({
    distanceTexels: index + 1,
    sampleCount: 0,
    maxAffineErrorTexels: 0,
    maxLegacyErrorTexels: 0,
    sumAffineErrorTexels: 0,
    sumLegacyErrorTexels: 0,
  }));
  for (const frame of frameTable.frames) {
    const pair = mesh.seamPairs[frame.pairIndex]; const source = pair.sides[frame.direction];
    const outward = sourceOutwardUv(mesh, repack.uv1, source);
    for (const fraction of [0.25, 0.5, 0.75]) {
      const boundaryUvPos = edgePointUv(repack.uv1, source, fraction);
      for (const row of rows) {
        const offsetUv = outward.map((value) => value * row.distanceTexels / repack.fieldSize);
        const candidateUv = boundaryUvPos.map((value, axis) => value + offsetUv[axis]);
        const walked = walkSurfaceOffset({
          mesh,
          uv1: repack.uv1,
          topology,
          sourceSide: source,
          destinationSide: pair.sides[1 - frame.direction],
          boundaryUvPos,
          edgeFraction: fraction,
          offsetUv,
        });
        const affineError = distance2(applyFrame(frame, candidateUv), walked.uvPos) * repack.fieldSize;
        const legacyError = distance2(applyLegacyFrame(frame, candidateUv), walked.uvPos) * repack.fieldSize;
        row.sampleCount += 1;
        row.maxAffineErrorTexels = Math.max(row.maxAffineErrorTexels, affineError);
        row.maxLegacyErrorTexels = Math.max(row.maxLegacyErrorTexels, legacyError);
        row.sumAffineErrorTexels += affineError;
        row.sumLegacyErrorTexels += legacyError;
      }
    }
  }
  for (const row of rows) {
    row.meanAffineErrorTexels = row.sumAffineErrorTexels / row.sampleCount;
    row.meanLegacyErrorTexels = row.sumLegacyErrorTexels / row.sampleCount;
  }
  return rows;
}

export function verifyCorruptedDonorIsDetected(mesh, repack, raster) {
  const record = raster.gutter.stencilClass.findIndex((value) => value === 0);
  if (record < 0) throw new Error('fault injection: no exact record');
  const offset = record * 4;
  const original = raster.gutter.tapIndices[offset];
  const wrong = raster.gutter.coords[0];
  raster.gutter.tapIndices[offset] = wrong;
  let rejected = false;
  try { verifyStencilTable(mesh, repack, raster); } catch { rejected = true; }
  raster.gutter.tapIndices[offset] = original;
  if (!rejected) throw new Error('fault injection: corrupted donor passed the stencil verifier');
  return { record, rejected };
}

export function smoothWorldField([x, y, z]) {
  return Math.sin(x * 0.71 + y * 0.19) * 0.31
    + Math.sin(y * 1.13 - z * 0.23) * 0.27
    + Math.sin(z * 0.83 + x * 0.37) * 0.22;
}

export function sharpWorldField([x, y, z]) {
  const signedDistance = x * 0.67 + y * 0.43 - z * 0.31 - 0.1;
  const t = clamp(signedDistance / 0.08 * 0.5 + 0.5, 0, 1);
  return t * t * (3 - 2 * t);
}

function triangleAreas(mesh) {
  return Float64Array.from(mesh.triangleChartIds, (_, triangle) => {
    const vertices = [...mesh.indices.subarray(triangle * 3, triangle * 3 + 3)];
    const a = vertex3(mesh.positions, vertices[0]); const b = vertex3(mesh.positions, vertices[1]); const c = vertex3(mesh.positions, vertices[2]);
    return Math.hypot(...cross3(subtract3(b, a), subtract3(c, a))) * 0.5;
  });
}

function uvBarycentric(mesh, uv, triangle, point) {
  const vertices = [...mesh.indices.subarray(triangle * 3, triangle * 3 + 3)];
  const a = vertex2(uv, vertices[0]); const b = vertex2(uv, vertices[1]); const c = vertex2(uv, vertices[2]);
  const denominator = cross2(subtract2(b, a), subtract2(c, a));
  const bWeight = cross2(subtract2(point, a), subtract2(c, a)) / denominator;
  const cWeight = cross2(subtract2(b, a), subtract2(point, a)) / denominator;
  return [1 - bWeight - cWeight, bWeight, cWeight];
}

function interpolateTriangle(indices, values, triangle, barycentric, width) {
  return Array.from({ length: width }, (_, axis) => barycentric.reduce((sum, weight, corner) => (
    sum + weight * values[indices[triangle * 3 + corner] * width + axis]
  ), 0));
}

function sourceOutwardUv(mesh, uv, side) {
  const start = vertex2(uv, side.vertex0); const end = vertex2(uv, side.vertex1);
  const edge = subtract2(end, start); const length = Math.hypot(...edge);
  let normal = [-edge[1] / length, edge[0] / length];
  const opposite = [...mesh.indices.subarray(side.triangleIndex * 3, side.triangleIndex * 3 + 3)]
    .find((vertex) => vertex !== side.vertex0 && vertex !== side.vertex1);
  const midpoint = start.map((value, axis) => (value + end[axis]) * 0.5);
  if (dot2(normal, subtract2(vertex2(uv, opposite), midpoint)) > 0) normal = normal.map((value) => -value);
  return normal;
}

function applyLegacyFrame(frame, uv) {
  const offset = subtract2(uv, frame.srcRef); const matrix = frame.legacyMatrix;
  return [
    frame.dstRef[0] + matrix.m00 * offset[0] + matrix.m01 * offset[1],
    frame.dstRef[1] + matrix.m10 * offset[0] + matrix.m11 * offset[1],
  ];
}
function edgePointUv(uv, side, fraction) {
  const start = vertex2(uv, side.vertex0); const end = vertex2(uv, side.vertex1);
  return start.map((value, axis) => value * (1 - fraction) + end[axis] * fraction);
}
function lowerBound(values, target) { let low = 0; let high = values.length - 1; while (low < high) { const middle = (low + high) >>> 1; if (values[middle] < target) low = middle + 1; else high = middle; } return low; }
function mulberry32(seed) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; }; }
function vertex2(values, vertex) { return [values[vertex * 2], values[vertex * 2 + 1]]; }
function vertex3(values, vertex) { return [values[vertex * 3], values[vertex * 3 + 1], values[vertex * 3 + 2]]; }
function subtract2(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function subtract3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross2(a, b) { return a[0] * b[1] - a[1] * b[0]; }
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot2(a, b) { return a[0] * b[0] + a[1] * b[1]; }
function distance2(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function distance3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
