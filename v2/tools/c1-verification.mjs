import { fillGutters } from '../src/atlas/fill.js';
import { smoothWorldField } from './seam-verification.mjs';
import { triangleJacobian } from './seams.mjs';
import { closestPointOnSegment, walkRay, walkSurfaceOffset } from './surface-walk.mjs';

// Five percent is reconstruction headroom, not a value tolerance: the absolute f32 floor below
// still applies when the seamless grid happens to reconstruct the analytic field almost exactly.
export const C1_RELATIVE_EPSILON = 0.05;
export const C1_VALUE_F32_FLOOR = 2e-4;
export const C1_GRADIENT_F32_FLOOR = 4e-4;
// Two 8-bit field levels plus one quarter of the local front change implements the brief's
// pointwise epsilon_abs + k*|gradient| form without using a global worst-step escape hatch.
export const SHARP_ABSOLUTE_EPSILON = 2 / 255;
export const SHARP_GRADIENT_FACTOR = 0.25;

const SHARP_FIELDS = [
  sharpField([0.67, 0.43, -0.31], 0.1),
  sharpField([-0.21, 0.91, 0.36], -0.07),
  sharpField([0.45, -0.52, 0.72], 0.04),
];

export function verifyC1Reconstruction(mesh, repack, raster, frameTable) {
  const fields = [
    prepareField('smooth', smoothWorldField, false, raster),
    ...SHARP_FIELDS.map((field, index) => prepareField(`sharp-${index}`, field, true, raster)),
  ];
  const smooth = metricRow();
  const sharp = metricRow();
  const radiusUv = repack.target.directTapClampTexels / repack.fieldSize;
  let pathCount = 0;

  for (const frame of frameTable.frames) {
    const pair = mesh.seamPairs[frame.pairIndex];
    const source = pair.sides[frame.direction]; const destination = pair.sides[1 - frame.direction];
    const mapper = sideMapper(mesh, repack.uv1, raster.surfaceTopology, source, destination);
    const samplesOnEdge = Math.min(3, Math.max(1, Math.ceil(frame.sourceLengthTexels / 16)));
    for (let sample = 0; sample < samplesOnEdge; sample += 1) {
      const fraction = (sample + 1) / (samplesOnEdge + 1);
      const inCornerZone = Math.min(fraction, 1 - fraction) * frame.sourceLengthTexels <= repack.target.gutterTexels;
      const centerUv = edgePoint(repack.uv1, source, fraction);
      const points = [
        centerUv,
        [centerUv[0] + radiusUv, centerUv[1]],
        [centerUv[0] - radiusUv, centerUv[1]],
        [centerUv[0], centerUv[1] + radiusUv],
        [centerUv[0], centerUv[1] - radiusUv],
      ];
      const samples = points.map((uv) => sampleReconstructions(uv, mapper, repack.fieldSize, fields));
      for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
        const field = fields[fieldIndex]; const row = field.sharp ? sharp : smooth;
        const center = samples[0][fieldIndex];
        const atlasGradient = finiteDifference(samples, fieldIndex, 'atlas');
        const disabledGradient = finiteDifference(samples, fieldIndex, 'disabled');
        const seamlessGradient = finiteDifference(samples, fieldIndex, 'seamless');
        const truthGradient = finiteDifference(samples, fieldIndex, 'truth');
        const atlasValueError = Math.abs(center.atlas - center.truth);
        const disabledValueError = Math.abs(center.disabled - center.truth);
        const seamlessValueError = Math.abs(center.seamless - center.truth);
        const atlasGradientError = distance2(atlasGradient, truthGradient);
        const disabledGradientError = distance2(disabledGradient, truthGradient);
        const seamlessGradientError = distance2(seamlessGradient, truthGradient);
        row.sampleCount += 1;
        row.maxAtlasValueError = Math.max(row.maxAtlasValueError, atlasValueError);
        row.maxSeamlessValueError = Math.max(row.maxSeamlessValueError, seamlessValueError);
        row.maxAtlasGradientError = Math.max(row.maxAtlasGradientError, atlasGradientError);
        row.maxSeamlessGradientError = Math.max(row.maxSeamlessGradientError, seamlessGradientError);

        if (field.sharp) {
          const localGradient = Math.max(Math.abs(truthGradient[0]), Math.abs(truthGradient[1]));
          const tolerance = SHARP_ABSOLUTE_EPSILON + SHARP_GRADIENT_FACTOR * localGradient;
          if (Math.abs(center.atlas - center.seamless) > tolerance) addViolation(
            row, 'value', inCornerZone, Math.min(fraction, 1 - fraction) * frame.sourceLengthTexels,
          );
          if (Math.abs(center.disabled - center.seamless) > tolerance) row.negativeControlValueViolations += 1;
        } else {
          const valueTolerance = seamlessValueError * (1 + C1_RELATIVE_EPSILON) + C1_VALUE_F32_FLOOR;
          const gradientTolerance = seamlessGradientError * (1 + C1_RELATIVE_EPSILON) + C1_GRADIENT_F32_FLOOR;
          const endpointDistanceTexels = Math.min(fraction, 1 - fraction) * frame.sourceLengthTexels;
          if (atlasValueError > valueTolerance) addViolation(row, 'value', inCornerZone, endpointDistanceTexels);
          if (atlasGradientError > gradientTolerance) addViolation(row, 'gradient', inCornerZone, endpointDistanceTexels);
          if (disabledValueError > valueTolerance) row.negativeControlValueViolations += 1;
          if (disabledGradientError > gradientTolerance) row.negativeControlGradientViolations += 1;
        }
      }
      smooth[inCornerZone ? 'cornerSampleCount' : 'interiorSampleCount'] += 1;
      sharp[inCornerZone ? 'cornerSampleCount' : 'interiorSampleCount'] += SHARP_FIELDS.length;
      pathCount += 1;
    }
  }
  if (!smooth.negativeControlValueViolations || !smooth.negativeControlGradientViolations || !sharp.negativeControlValueViolations) {
    throw new Error('C1: disabled-fill negative control did not trip every operative gate');
  }
  return { pathCount, directTapClampTexels: repack.target.directTapClampTexels, smooth, sharp };
}

function prepareField(name, evaluate, sharp, raster) {
  const source = new Float32Array(raster.authoritativeOwner.length);
  for (let texel = 0; texel < source.length; texel += 1) {
    if (raster.authoritativeOwner[texel]) source[texel] = evaluate(raster.worldPos.subarray(texel * 3, texel * 3 + 3));
  }
  return { name, evaluate, sharp, source, filled: fillGutters(source, raster.gutter) };
}

function sampleReconstructions(uv, mapper, fieldSize, fields) {
  const truthWorld = mapper.worldAt(uv);
  const sampleX = uv[0] * fieldSize - 0.5; const sampleY = uv[1] * fieldSize - 0.5;
  const x0 = Math.floor(sampleX); const y0 = Math.floor(sampleY);
  const fractionX = sampleX - x0; const fractionY = sampleY - y0;
  const taps = [[x0, y0], [x0 + 1, y0], [x0, y0 + 1], [x0 + 1, y0 + 1]];
  const weights = [(1 - fractionX) * (1 - fractionY), fractionX * (1 - fractionY), (1 - fractionX) * fractionY, fractionX * fractionY];
  const seamlessWorld = taps.map(([x, y]) => mapper.worldAtTexel(x, y, fieldSize));
  return fields.map((field) => {
    let atlas = 0; let disabled = 0; let seamless = 0;
    for (let tap = 0; tap < 4; tap += 1) {
      const [x, y] = taps[tap]; const index = y * fieldSize + x;
      atlas += weights[tap] * (x >= 0 && y >= 0 && x < fieldSize && y < fieldSize ? field.filled[index] : 0);
      disabled += weights[tap] * (x >= 0 && y >= 0 && x < fieldSize && y < fieldSize ? field.source[index] : 0);
      seamless += weights[tap] * field.evaluate(seamlessWorld[tap]);
    }
    return { atlas, disabled, seamless, truth: field.evaluate(truthWorld) };
  });
}

function sideMapper(mesh, uv, topology, source, destination) {
  const startUv = vertex2(uv, source.vertex0); const endUv = vertex2(uv, source.vertex1);
  const edge = subtract2(endUv, startUv); const length = Math.hypot(...edge);
  let outward = [-edge[1] / length, edge[0] / length];
  const opposite = [...mesh.indices.subarray(source.triangleIndex * 3, source.triangleIndex * 3 + 3)]
    .find((vertex) => vertex !== source.vertex0 && vertex !== source.vertex1);
  const midpointUv = startUv.map((value, axis) => (value + endUv[axis]) * 0.5);
  if (dot2(outward, subtract2(vertex2(uv, opposite), midpointUv)) > 0) outward = outward.map((value) => -value);
  const jacobian = triangleJacobian(mesh, uv, source.triangleIndex);
  const texelCache = new Map();
  const worldAt = (pointUv) => {
    const closest = closestPointOnSegment(pointUv, startUv, endUv);
    const offsetUv = subtract2(pointUv, closest.point);
    if (dot2(offsetUv, outward) >= -1e-12) {
      return walkSurfaceOffset({
        mesh, uv1: uv, topology, sourceSide: source, destinationSide: destination,
        boundaryUvPos: closest.point, edgeFraction: closest.t, offsetUv,
      }).worldPos;
    }
    const offsetWorld = combine3(jacobian.dU, offsetUv[0], jacobian.dV, offsetUv[1]);
    const distanceWorld = Math.hypot(...offsetWorld);
    const boundaryWorld = edgePoint(mesh.positions, source, closest.t, 3);
    if (distanceWorld <= 1e-15) return boundaryWorld;
    return walkRay(
      mesh, uv, topology, source.triangleIndex, boundaryWorld,
      offsetWorld.map((value) => value / distanceWorld), distanceWorld,
    ).worldPos;
  };
  return {
    worldAt,
    worldAtTexel(x, y, fieldSize) {
      const key = y * fieldSize + x;
      let world = texelCache.get(key);
      if (!world) { world = worldAt([(x + 0.5) / fieldSize, (y + 0.5) / fieldSize]); texelCache.set(key, world); }
      return world;
    },
  };
}

function metricRow() {
  return {
    sampleCount: 0,
    valueViolations: 0,
    gradientViolations: 0,
    interiorSampleCount: 0,
    cornerSampleCount: 0,
    interiorValueViolations: 0,
    cornerValueViolations: 0,
    interiorGradientViolations: 0,
    cornerGradientViolations: 0,
    maxCornerValueViolationRadiusTexels: 0,
    maxCornerGradientViolationRadiusTexels: 0,
    negativeControlValueViolations: 0,
    negativeControlGradientViolations: 0,
    maxAtlasValueError: 0,
    maxSeamlessValueError: 0,
    maxAtlasGradientError: 0,
    maxSeamlessGradientError: 0,
  };
}

function addViolation(row, kind, inCornerZone, endpointDistanceTexels) {
  row[`${kind}Violations`] += 1;
  row[`${inCornerZone ? 'corner' : 'interior'}${kind[0].toUpperCase()}${kind.slice(1)}Violations`] += 1;
  if (inCornerZone) {
    const radiusName = `maxCorner${kind[0].toUpperCase()}${kind.slice(1)}ViolationRadiusTexels`;
    row[radiusName] = Math.max(row[radiusName], endpointDistanceTexels);
  }
}

function finiteDifference(samples, fieldIndex, property) {
  return [
    samples[1][fieldIndex][property] - samples[2][fieldIndex][property],
    samples[3][fieldIndex][property] - samples[4][fieldIndex][property],
  ];
}

function sharpField(sourceNormal, offset) {
  const length = Math.hypot(...sourceNormal); const normal = sourceNormal.map((value) => value / length);
  return (world) => {
    const signedDistance = dot3(normal, world) - offset;
    const value = clamp(signedDistance / 0.08 * 0.5 + 0.5, 0, 1);
    return value * value * (3 - 2 * value);
  };
}

function edgePoint(values, side, fraction, width = 2) {
  return Array.from({ length: width }, (_, axis) => values[side.vertex0 * width + axis] * (1 - fraction) + values[side.vertex1 * width + axis] * fraction);
}
function vertex2(values, vertex) { return [values[vertex * 2], values[vertex * 2 + 1]]; }
function subtract2(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function combine3(a, aScale, b, bScale) { return a.map((value, axis) => value * aScale + b[axis] * bScale); }
function dot2(a, b) { return a[0] * b[0] + a[1] * b[1]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function distance2(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
