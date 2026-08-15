import { AGENT_BYTES } from './constants.js';
import { alignedFieldRowBytes } from './resources.js';

export async function readAgentRecords({ device, registry, buffer, count }) {
  if (count === 0) return [];
  const readback = registry.createBuffer({
    label: 'sim-debug-agent-readback',
    size: count * AGENT_BYTES,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder({ label: 'sim-debug-agent-copy' });
  encoder.copyBufferToBuffer(buffer, 0, readback, 0, count * AGENT_BYTES);
  device.queue.submit([encoder.finish()]);
  try {
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = readback.getMappedRange().slice(0);
    const floats = new Float32Array(bytes);
    const uints = new Uint32Array(bytes);
    return Array.from({ length: count }, (_, index) => ({
      uvPos: [floats[index * 8], floats[index * 8 + 1]],
      heading: floats[index * 8 + 2],
      reserve: floats[index * 8 + 3],
      idLo: uints[index * 8 + 4],
      idHi: uints[index * 8 + 5],
      flags: uints[index * 8 + 6],
    }));
  } finally {
    if (readback.mapState === 'mapped') readback.unmap();
    registry.destroy(readback);
  }
}

export async function readScalarTexture({ device, registry, texture, fieldSize }) {
  const rowBytes = alignedFieldRowBytes(fieldSize);
  const readback = registry.createBuffer({
    label: 'sim-debug-field-readback',
    size: rowBytes * fieldSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder({ label: 'sim-debug-field-copy' });
  encoder.copyTextureToBuffer(
    { texture },
    { buffer: readback, bytesPerRow: rowBytes, rowsPerImage: fieldSize },
    [fieldSize, fieldSize, 1],
  );
  device.queue.submit([encoder.finish()]);
  try {
    await readback.mapAsync(GPUMapMode.READ);
    const padded = new Float32Array(readback.getMappedRange());
    const result = new Float32Array(fieldSize * fieldSize);
    const rowFloats = rowBytes / 4;
    for (let row = 0; row < fieldSize; row += 1) {
      result.set(padded.subarray(row * rowFloats, row * rowFloats + fieldSize), row * fieldSize);
    }
    return result;
  } finally {
    if (readback.mapState === 'mapped') readback.unmap();
    registry.destroy(readback);
  }
}
