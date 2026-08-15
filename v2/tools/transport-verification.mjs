import { resolveAtlasStep } from '../src/atlas/fill.js';
import { applyFrame, triangleJacobian } from './seams.mjs';
import { walkSurfaceOffset } from './surface-walk.mjs';

export const TRANSPORT_HEADING_LIMIT_DEGREES = 2;
export const TRANSPORT_POSITION_STEP_FRACTION = 0.05;
export const TRANSPORT_CROSS_BACK_TEXELS = 0.25;

export function verifySeamConditionedTransport(
  mesh,
  repack,
  raster,
  boundaryIndex,
  frameTable,
  sampleCount = 100_000,
  seed = 0x7a6_5eab,
) {
  const parameterScale = repack.target.role === 'fixture' ? 1 : repack.target.densityScale;
  const maximumStepTexels = 0.003 * parameterScale * repack.fieldSize;
  const minimumStepTexels = maximumStepTexels * 0.85;
  const eligibleFrames = frameTable.frames.filter((frame) => frame.sourceLengthTexels > maximumStepTexels * 2.5);
  if (!eligibleFrames.length) throw new Error('transport: no seam has a corner-free legal step interval');
  const random = mulberry32(seed);
  let acceptedSamples = 0; let attempts = 0; let resolverFailures = 0;
  let expectedGroupAbsentFailures = 0; let expectedGroupPresentFailures = 0;
  let wrongFrameResolves = 0; let wrongGroupResolves = 0;
  let positionViolations = 0; let headingViolations = 0; let crossBackViolations = 0; let crossBackEligible = 0;
  let maxPositionErrorTexels = 0; let maxHeadingErrorDegrees = 0; let maxCrossBackErrorTexels = 0;
  const failureTexels = new Set();
  while (acceptedSamples < sampleCount && attempts < sampleCount * 40) {
    attempts += 1;
    const frame = eligibleFrames[Math.floor(random() * eligibleFrames.length)];
    const pair = mesh.seamPairs[frame.pairIndex]; const source = pair.sides[frame.direction];
    const destination = pair.sides[1 - frame.direction];
    const stepTexels = minimumStepTexels + random() * (maximumStepTexels - minimumStepTexels);
    const endpointMargin = Math.min(0.45, stepTexels * 1.25 / frame.sourceLengthTexels);
    const fraction = endpointMargin + random() * (1 - endpointMargin * 2);
    const boundaryUv = edgePoint(repack.uv1, source, fraction);
    const outward = sourceOutwardUv(mesh, repack.uv1, source);
    const tangent = normalize2(subtract2(vertex2(repack.uv1, source.vertex1), vertex2(repack.uv1, source.vertex0)));
    const direction = normalize2(outward.map((value, axis) => value + tangent[axis] * (random() - 0.5) * 0.5));
    const insideTexels = stepTexels * (0.5 + (random() - 0.5) * 0.08);
    const outsideTexels = stepTexels - insideTexels;
    const baseUv = boundaryUv.map((value, axis) => value - direction[axis] * insideTexels / repack.fieldSize);
    const candidateUv = boundaryUv.map((value, axis) => value + direction[axis] * outsideTexels / repack.fieldSize);
    const baseTexel = uvTexel(baseUv, repack.fieldSize);
    const candidateTexel = uvTexel(candidateUv, repack.fieldSize);
    const expectedUv = applyFrame(frame, candidateUv);
    const expectedTexel = uvTexel(expectedUv, repack.fieldSize);
    if (baseTexel < 0 || expectedTexel < 0
      || raster.authoritativeOwner[baseTexel] !== frame.sourceChart
      || (candidateTexel >= 0 && raster.authoritativeOwner[candidateTexel] === frame.sourceChart)
      || raster.authoritativeOwner[expectedTexel] !== frame.destinationChart) continue;

    const result = resolveAtlasStep({
      baseUv,
      candidateUv,
      heading: direction,
      fieldSize: repack.fieldSize,
      authoritativeOwner: raster.authoritativeOwner,
      boundaryIndex,
      frameTable,
    });
    acceptedSamples += 1;
    const expectedGroup = boundaryIndex.frameGroupIds[frame.id];
    const listedFrameIds = Array.from(
      boundaryIndex.frameLists.subarray(baseTexel * 4, baseTexel * 4 + boundaryIndex.frameListCounts[baseTexel]),
    );
    const expectedGroupListed = listedFrameIds.some((frameId) => boundaryIndex.frameGroupIds[frameId] === expectedGroup);
    if (!result.valid || !result.frameId) {
      resolverFailures += 1;
      if (expectedGroupListed) expectedGroupPresentFailures += 1;
      else expectedGroupAbsentFailures += 1;
      failureTexels.add(baseTexel);
      continue;
    }
    if (result.frameId !== frame.id) wrongFrameResolves += 1;
    if (boundaryIndex.frameGroupIds[result.frameId] !== expectedGroup) wrongGroupResolves += 1;
    const walked = walkSurfaceOffset({
      mesh,
      uv1: repack.uv1,
      topology: raster.surfaceTopology,
      sourceSide: source,
      destinationSide: destination,
      boundaryUvPos: boundaryUv,
      edgeFraction: fraction,
      offsetUv: candidateUv.map((value, axis) => value - boundaryUv[axis]),
    });
    const positionError = distance2(result.uv, walked.uvPos) * repack.fieldSize;
    const positionLimit = stepTexels * TRANSPORT_POSITION_STEP_FRACTION;
    maxPositionErrorTexels = Math.max(maxPositionErrorTexels, positionError);
    if (positionError > positionLimit) { positionViolations += 1; failureTexels.add(baseTexel); }

    const expectedHeading = transportedWorldHeading(mesh, repack.uv1, source, destination, boundaryUv, fraction, direction, raster.surfaceTopology);
    const resultFrame = frameTable.frames[result.frameId - 1];
    const destinationJacobian = triangleJacobian(mesh, repack.uv1, resultFrame
      ? mesh.seamPairs[resultFrame.pairIndex].sides[1 - resultFrame.direction].triangleIndex
      : destination.triangleIndex);
    const resultWorldHeading = normalize3(combine3(destinationJacobian.dU, result.heading[0], destinationJacobian.dV, result.heading[1]));
    const headingError = angleDegrees(expectedHeading, resultWorldHeading);
    maxHeadingErrorDegrees = Math.max(maxHeadingErrorDegrees, headingError);
    if (headingError > TRANSPORT_HEADING_LIMIT_DEGREES) { headingViolations += 1; failureTexels.add(baseTexel); }

    const mappedBaseUv = applyFrame(frame, baseUv);
    const mappedBaseTexel = uvTexel(mappedBaseUv, repack.fieldSize);
    if (mappedBaseTexel >= 0 && raster.authoritativeOwner[mappedBaseTexel] === frame.destinationChart) continue;
    crossBackEligible += 1;
    const back = resolveAtlasStep({
      baseUv: result.uv,
      candidateUv: mappedBaseUv,
      heading: result.heading.map((value) => -value),
      fieldSize: repack.fieldSize,
      authoritativeOwner: raster.authoritativeOwner,
      boundaryIndex,
      frameTable,
    });
    const crossBackError = back.valid ? distance2(back.uv, baseUv) * repack.fieldSize : Infinity;
    maxCrossBackErrorTexels = Math.max(maxCrossBackErrorTexels, crossBackError);
    if (crossBackError > TRANSPORT_CROSS_BACK_TEXELS) { crossBackViolations += 1; failureTexels.add(baseTexel); }
  }
  if (acceptedSamples !== sampleCount) throw new Error(`transport: only ${acceptedSamples}/${sampleCount} conditioned walks were sampleable`);
  return {
    sampleCount,
    attempts,
    eligibleFrameCount: eligibleFrames.length,
    resolverFailures,
    expectedGroupAbsentFailures,
    expectedGroupPresentFailures,
    wrongFrameResolves,
    wrongGroupResolves,
    positionViolations,
    headingViolations,
    crossBackEligible,
    crossBackViolations,
    maxPositionErrorTexels,
    maxHeadingErrorDegrees,
    maxCrossBackErrorTexels,
    failureTexels: Uint32Array.from([...failureTexels].sort((left, right) => left - right)),
  };
}

function transportedWorldHeading(mesh, uv, source, destination, boundaryUv, fraction, direction, topology) {
  const epsilonUv = 1e-5;
  const walked = walkSurfaceOffset({
    mesh, uv1: uv, topology, sourceSide: source, destinationSide: destination,
    boundaryUvPos: boundaryUv, edgeFraction: fraction, offsetUv: direction.map((value) => value * epsilonUv),
  });
  const boundaryWorld = edgePoint(mesh.positions, source, fraction, 3);
  return normalize3(walked.worldPos.map((value, axis) => value - boundaryWorld[axis]));
}

function sourceOutwardUv(mesh, uv, side) {
  const start = vertex2(uv, side.vertex0); const end = vertex2(uv, side.vertex1);
  const edge = subtract2(end, start); let normal = normalize2([-edge[1], edge[0]]);
  const opposite = [...mesh.indices.subarray(side.triangleIndex * 3, side.triangleIndex * 3 + 3)]
    .find((vertex) => vertex !== side.vertex0 && vertex !== side.vertex1);
  const midpoint = start.map((value, axis) => (value + end[axis]) * 0.5);
  if (dot2(normal, subtract2(vertex2(uv, opposite), midpoint)) > 0) normal = normal.map((value) => -value);
  return normal;
}

function uvTexel(uv, fieldSize) {
  if (uv[0] < 0 || uv[1] < 0 || uv[0] >= 1 || uv[1] >= 1) return -1;
  return Math.floor(uv[1] * fieldSize) * fieldSize + Math.floor(uv[0] * fieldSize);
}
function edgePoint(values, side, fraction, width = 2) { return Array.from({ length: width }, (_, axis) => values[side.vertex0 * width + axis] * (1 - fraction) + values[side.vertex1 * width + axis] * fraction); }
function vertex2(values, vertex) { return [values[vertex * 2], values[vertex * 2 + 1]]; }
function subtract2(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function combine3(a, aScale, b, bScale) { return a.map((value, axis) => value * aScale + b[axis] * bScale); }
function normalize2(value) { const length = Math.hypot(...value); return value.map((axis) => axis / length); }
function normalize3(value) { const length = Math.hypot(...value); return value.map((axis) => axis / length); }
function dot2(a, b) { return a[0] * b[0] + a[1] * b[1]; }
function distance2(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function angleDegrees(a, b) { return Math.acos(Math.max(-1, Math.min(1, a.reduce((sum, value, axis) => sum + value * b[axis], 0)))) * 180 / Math.PI; }
function mulberry32(seed) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; }; }
