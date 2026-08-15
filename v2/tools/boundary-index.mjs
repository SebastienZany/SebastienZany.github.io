import { DEFAULT_PARAMETER_VALUES } from '../src/shared/params.js';
import { MAX_FRAME_LIST_LENGTH } from './atlas-constants.mjs';
import { closestPointOnSegment } from './surface-walk.mjs';

export function buildBoundaryFrameIndex(splitMesh, repack, frameTable, authoritativeOwner) {
  const { fieldSize } = repack;
  const texelCount = fieldSize ** 2;
  const frameLists = new Uint32Array(texelCount * MAX_FRAME_LIST_LENGTH);
  const distances = new Float32Array(texelCount * MAX_FRAME_LIST_LENGTH).fill(Infinity);
  const candidateCounts = new Uint16Array(texelCount);
  const sensingRangeTexels = DEFAULT_PARAMETER_VALUES.sensorDistance * repack.target.densityScale * fieldSize;

  for (const frame of frameTable.frames) {
    const pair = splitMesh.seamPairs[frame.pairIndex];
    const side = pair.sides[frame.direction];
    const start = [repack.uv1[side.vertex0 * 2] * fieldSize, repack.uv1[side.vertex0 * 2 + 1] * fieldSize];
    const end = [repack.uv1[side.vertex1 * 2] * fieldSize, repack.uv1[side.vertex1 * 2 + 1] * fieldSize];
    const minX = Math.max(0, Math.floor(Math.min(start[0], end[0]) - sensingRangeTexels));
    const maxX = Math.min(fieldSize - 1, Math.ceil(Math.max(start[0], end[0]) + sensingRangeTexels));
    const minY = Math.max(0, Math.floor(Math.min(start[1], end[1]) - sensingRangeTexels));
    const maxY = Math.min(fieldSize - 1, Math.ceil(Math.max(start[1], end[1]) + sensingRangeTexels));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const texelIndex = y * fieldSize + x;
        if (authoritativeOwner[texelIndex] !== frame.sourceChart) continue;
        const distanceSquared = closestPointOnSegment([x + 0.5, y + 0.5], start, end).distanceSquared;
        if (distanceSquared > sensingRangeTexels ** 2) continue;
        candidateCounts[texelIndex] = Math.min(0xffff, candidateCounts[texelIndex] + 1);
        insertNearest(frameLists, distances, texelIndex, frame.id, distanceSquared);
      }
    }
  }

  const nearestFrame = new Uint32Array(texelCount);
  const frameListCounts = new Uint8Array(texelCount);
  const overflow = [];
  let coveredTexelCount = 0;
  for (let texelIndex = 0; texelIndex < texelCount; texelIndex += 1) {
    const count = candidateCounts[texelIndex];
    frameListCounts[texelIndex] = Math.min(count, MAX_FRAME_LIST_LENGTH);
    nearestFrame[texelIndex] = frameLists[texelIndex * MAX_FRAME_LIST_LENGTH];
    if (count) coveredTexelCount += 1;
    if (count > MAX_FRAME_LIST_LENGTH) overflow.push(texelIndex);
  }
  return {
    nearestFrame,
    frameLists,
    frameListCounts,
    candidateCounts,
    overflowTexels: Uint32Array.from(overflow),
    overflowCount: overflow.length,
    coveredTexelCount,
    sensingRangeTexels,
  };
}

function insertNearest(frameLists, distances, texelIndex, frameId, distanceSquared) {
  const offset = texelIndex * MAX_FRAME_LIST_LENGTH;
  let insertion = MAX_FRAME_LIST_LENGTH;
  for (let index = 0; index < MAX_FRAME_LIST_LENGTH; index += 1) {
    const oldDistance = distances[offset + index];
    const oldFrame = frameLists[offset + index];
    if (distanceSquared < oldDistance || (distanceSquared === oldDistance && frameId < oldFrame)) {
      insertion = index;
      break;
    }
  }
  if (insertion === MAX_FRAME_LIST_LENGTH) return;
  for (let index = MAX_FRAME_LIST_LENGTH - 1; index > insertion; index -= 1) {
    distances[offset + index] = distances[offset + index - 1];
    frameLists[offset + index] = frameLists[offset + index - 1];
  }
  distances[offset + insertion] = distanceSquared;
  frameLists[offset + insertion] = frameId;
}
