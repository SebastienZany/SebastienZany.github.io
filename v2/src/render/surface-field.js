import { assertFieldProvider } from '../shared/field-provider.js';

export const SURFACE_FIELD_CONSTANTS = Object.freeze({
  frequencyPerWorld: 11,
  baseValue: 0.32,
  xAmplitude: 0.16,
  yAmplitude: 0.16,
  zAmplitude: 0.12,
  yFrequencyScale: 0.86,
  zFrequencyScale: 1.18,
});

export function surfaceFieldValueAtWorld(
  worldX,
  worldY,
  worldZ,
  frequencyPerWorld = SURFACE_FIELD_CONSTANTS.frequencyPerWorld,
) {
  const constants = SURFACE_FIELD_CONSTANTS;
  const value = constants.baseValue
    + constants.xAmplitude * Math.sin(worldX * frequencyPerWorld)
    + constants.yAmplitude * Math.cos(worldY * frequencyPerWorld * constants.yFrequencyScale)
    + constants.zAmplitude * Math.sin(worldZ * frequencyPerWorld * constants.zFrequencyScale);
  return Math.max(value, 0);
}

export function bakeSurfaceFieldTexels({
  positions,
  uv0,
  indices,
  size,
  rowStrideFloats = size,
  frequencyPerWorld = SURFACE_FIELD_CONSTANTS.frequencyPerWorld,
}) {
  assertSurfaceGeometry({ positions, uv0, indices });
  if (!Number.isInteger(size) || size <= 0) throw new TypeError('Surface-field size must be positive');
  if (!Number.isInteger(rowStrideFloats) || rowStrideFloats < size) {
    throw new TypeError('Surface-field row stride must cover one row');
  }

  const values = new Float32Array(rowStrideFloats * size);
  const painted = new Uint8Array(size * size);
  let paintedTexelCount = 0;
  let degenerateTriangleCount = 0;

  for (let triangleOffset = 0; triangleOffset < indices.length; triangleOffset += 3) {
    const vertex0 = indices[triangleOffset];
    const vertex1 = indices[triangleOffset + 1];
    const vertex2 = indices[triangleOffset + 2];
    const uvOffset0 = vertex0 * 2;
    const uvOffset1 = vertex1 * 2;
    const uvOffset2 = vertex2 * 2;
    const u0 = uv0[uvOffset0];
    const v0 = uv0[uvOffset0 + 1];
    const u1 = uv0[uvOffset1];
    const v1 = uv0[uvOffset1 + 1];
    const u2 = uv0[uvOffset2];
    const v2 = uv0[uvOffset2 + 1];
    const denominator = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(denominator) <= Number.EPSILON) {
      degenerateTriangleCount += 1;
      continue;
    }

    const minimumTexelX = texelMinimum(Math.min(u0, u1, u2), size);
    const maximumTexelX = texelMaximum(Math.max(u0, u1, u2), size);
    const minimumTexelY = texelMinimum(Math.min(v0, v1, v2), size);
    const maximumTexelY = texelMaximum(Math.max(v0, v1, v2), size);
    const inverseDenominator = 1 / denominator;
    const positionOffset0 = vertex0 * 3;
    const positionOffset1 = vertex1 * 3;
    const positionOffset2 = vertex2 * 3;

    for (let texelY = minimumTexelY; texelY <= maximumTexelY; texelY += 1) {
      const uvY = (texelY + 0.5) / size;
      for (let texelX = minimumTexelX; texelX <= maximumTexelX; texelX += 1) {
        const uvX = (texelX + 0.5) / size;
        const weight0 = ((v1 - v2) * (uvX - u2) + (u2 - u1) * (uvY - v2))
          * inverseDenominator;
        const weight1 = ((v2 - v0) * (uvX - u2) + (u0 - u2) * (uvY - v2))
          * inverseDenominator;
        const weight2 = 1 - weight0 - weight1;
        if (weight0 < -1e-7 || weight1 < -1e-7 || weight2 < -1e-7) continue;

        const worldX = positions[positionOffset0] * weight0
          + positions[positionOffset1] * weight1
          + positions[positionOffset2] * weight2;
        const worldY = positions[positionOffset0 + 1] * weight0
          + positions[positionOffset1 + 1] * weight1
          + positions[positionOffset2 + 1] * weight2;
        const worldZ = positions[positionOffset0 + 2] * weight0
          + positions[positionOffset1 + 2] * weight1
          + positions[positionOffset2 + 2] * weight2;
        values[texelY * rowStrideFloats + texelX] = surfaceFieldValueAtWorld(
          worldX,
          worldY,
          worldZ,
          frequencyPerWorld,
        );
        const coverageOffset = texelY * size + texelX;
        if (painted[coverageOffset] === 0) {
          painted[coverageOffset] = 1;
          paintedTexelCount += 1;
        }
      }
    }
  }

  return Object.freeze({
    values,
    rowStrideFloats,
    paintedTexelCount,
    degenerateTriangleCount,
  });
}

export function createSurfaceFieldProvider(device, registry, asset, {
  size = 256,
  label = 'synthetic-world-surface-field',
  frequencyPerWorld = SURFACE_FIELD_CONSTANTS.frequencyPerWorld,
} = {}) {
  if (!device?.queue) throw new TypeError('A GPUDevice is required');
  if (!registry?.createTexture) throw new TypeError('A GPU registry is required');
  const rowStrideFloats = Math.ceil((size * Float32Array.BYTES_PER_ELEMENT) / 256) * 64;
  const bake = bakeSurfaceFieldTexels({
    positions: asset?.positions,
    uv0: asset?.uv0,
    indices: asset?.indices,
    size,
    rowStrideFloats,
    frequencyPerWorld,
  });
  const texture = registry.createTexture({
    label,
    size: [size, size, 1],
    format: 'r32float',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
  });
  const view = texture.createView({ label: `${label}-view` });
  let uploaded = false;

  function frame({ force = false } = {}) {
    if (uploaded && !force) return;
    device.queue.writeTexture(
      { texture },
      bake.values,
      { bytesPerRow: bake.rowStrideFloats * 4, rowsPerImage: size },
      [size, size, 1],
    );
    uploaded = true;
  }

  const provider = {
    texture,
    view,
    size,
    mode: 'world-surface',
    paintedTexelCount: bake.paintedTexelCount,
    degenerateTriangleCount: bake.degenerateTriangleCount,
    frame,
    destroy() {
      registry.destroy(texture);
    },
  };
  frame({ force: true });
  return assertFieldProvider(provider);
}

function texelMinimum(uvValue, size) {
  return Math.max(0, Math.ceil(uvValue * size - 0.5));
}

function texelMaximum(uvValue, size) {
  return Math.min(size - 1, Math.floor(uvValue * size - 0.5));
}

function assertSurfaceGeometry({ positions, uv0, indices }) {
  if (!(positions instanceof Float32Array)
      || !(uv0 instanceof Float32Array)
      || !(indices instanceof Uint32Array)
      || positions.length === 0
      || positions.length % 3 !== 0
      || uv0.length / 2 !== positions.length / 3
      || indices.length === 0
      || indices.length % 3 !== 0) {
    throw new TypeError('Surface-field bake requires indexed MESH1 positions and uv0');
  }
}
