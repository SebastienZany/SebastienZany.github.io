export const SURFACE_WORLD_SIZE = 9.6;

// Legacy anchor main.js:15294: downstream camera, audio, and oat units assume this exact frame.
export function normalizeGeometry(sourcePositions) {
  validateTriples(sourcePositions, 'positions');
  const sourceBounds = measureBounds(sourcePositions);
  const sourceExtents = boundsExtents(sourceBounds);
  const longestSourceExtent = Math.max(...sourceExtents);
  if (!(longestSourceExtent > 0)) throw new Error('positions: bounding box has no extent');

  const sourceCenter = [
    (sourceBounds.min[0] + sourceBounds.max[0]) * 0.5,
    (sourceBounds.min[1] + sourceBounds.max[1]) * 0.5,
    (sourceBounds.min[2] + sourceBounds.max[2]) * 0.5,
  ];
  const scaleFactor = SURFACE_WORLD_SIZE / longestSourceExtent;
  const positions = new Float32Array(sourcePositions.length);
  for (let offset = 0; offset < sourcePositions.length; offset += 3) {
    positions[offset] = (sourcePositions[offset] - sourceCenter[0]) * scaleFactor;
    positions[offset + 1] = (sourcePositions[offset + 1] - sourceCenter[1]) * scaleFactor;
    positions[offset + 2] = (sourcePositions[offset + 2] - sourceCenter[2]) * scaleFactor;
  }

  return {
    positions,
    sourceBounds,
    normalizedBounds: measureBounds(positions),
    sourceCenter,
    scaleFactor,
  };
}

export function measureBounds(positions) {
  validateTriples(positions, 'positions');
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[offset + axis];
      if (!Number.isFinite(value)) throw new Error(`positions: non-finite value at scalar ${offset + axis}`);
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

export function boundsExtents(bounds) {
  return bounds.max.map((maximum, axis) => maximum - bounds.min[axis]);
}

function validateTriples(values, name) {
  if (!ArrayBuffer.isView(values) || values.length === 0 || values.length % 3 !== 0) {
    throw new Error(`${name}: expected a non-empty typed array of xyz triples`);
  }
}
