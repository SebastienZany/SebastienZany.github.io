import { AGENT_BYTES, SNAPSHOT_SCHEMA_VERSION } from './constants.js';
import { clonePopulationControllerState } from './controller.js';
import { alignedFieldRowBytes } from './resources.js';

export async function captureSimulationSnapshot({
  device,
  registry,
  resources,
  agentParity,
  count,
  metadata,
  compatibility,
}) {
  const agentBytes = Math.max(4, count * AGENT_BYTES);
  const fieldRowBytes = alignedFieldRowBytes(resources.fieldSize);
  const agentReadback = registry.createBuffer({
    label: 'sim-snapshot-agent-readback',
    size: agentBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const fieldReadback = registry.createBuffer({
    label: 'sim-snapshot-field-readback',
    size: fieldRowBytes * resources.fieldSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder({ label: 'sim-snapshot-copy-encoder' });
  if (count > 0) encoder.copyBufferToBuffer(resources.agentBuffers[agentParity], 0, agentReadback, 0, count * AGENT_BYTES);
  encoder.copyTextureToBuffer(
    { texture: resources.dynamicFields[0] },
    { buffer: fieldReadback, bytesPerRow: fieldRowBytes, rowsPerImage: resources.fieldSize },
    [resources.fieldSize, resources.fieldSize, 1],
  );
  device.queue.submit([encoder.finish()]);
  try {
    await Promise.all([agentReadback.mapAsync(GPUMapMode.READ), fieldReadback.mapAsync(GPUMapMode.READ)]);
    const agentWords = count === 0
      ? new Uint32Array()
      : new Uint32Array(agentReadback.getMappedRange().slice(0, count * AGENT_BYTES));
    const paddedField = new Float32Array(fieldReadback.getMappedRange());
    const field = new Float32Array(resources.fieldTexels);
    const paddedRowFloats = fieldRowBytes / 4;
    for (let row = 0; row < resources.fieldSize; row += 1) {
      field.set(paddedField.subarray(row * paddedRowFloats, row * paddedRowFloats + resources.fieldSize), row * resources.fieldSize);
    }
    return {
      header: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        manifestRootHash: compatibility.manifestRootHash,
        fieldSize: resources.fieldSize,
        capacity: resources.capacity,
      },
      agents: agentWords,
      field,
      metadata: {
        ...metadata,
        params: { ...metadata.params },
        oats: metadata.oats.map((oat) => ({ ...oat, uvPos: [...oat.uvPos] })),
        controllerState: clonePopulationControllerState(metadata.controllerState),
        timebase: { ...metadata.timebase },
      },
    };
  } finally {
    if (agentReadback.mapState === 'mapped') agentReadback.unmap();
    if (fieldReadback.mapState === 'mapped') fieldReadback.unmap();
    registry.destroy(agentReadback);
    registry.destroy(fieldReadback);
  }
}

export function assertSnapshotCompatibility(snapshot, expected) {
  const header = snapshot?.header;
  if (!header) throw new TypeError('Snapshot is missing its compatibility header');
  const mismatches = [];
  if (header.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) mismatches.push('schema version');
  if (header.manifestRootHash !== expected.manifestRootHash) mismatches.push('manifest root hash');
  if (header.fieldSize !== expected.fieldSize) mismatches.push('field size');
  if (header.capacity !== expected.capacity) mismatches.push('capacity');
  if (mismatches.length > 0) throw new Error(`Snapshot compatibility mismatch: ${mismatches.join(', ')}`);
}

export function paddedFieldUpload(field, fieldSize) {
  if (!(field instanceof Float32Array) || field.length !== fieldSize * fieldSize) {
    throw new TypeError('Snapshot field has the wrong type or length');
  }
  const rowBytes = alignedFieldRowBytes(fieldSize);
  const rowFloats = rowBytes / 4;
  const upload = new Float32Array(rowFloats * fieldSize);
  for (let row = 0; row < fieldSize; row += 1) {
    upload.set(field.subarray(row * fieldSize, (row + 1) * fieldSize), row * rowFloats);
  }
  return { upload, rowBytes };
}
