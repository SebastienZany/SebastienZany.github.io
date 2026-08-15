import {
  MESH_ASSET_VERSION,
  MESH_SECTIONS,
  crc32,
  meshAssetHeaderLayout,
} from '../src/atlas/asset.js';

// Tables are fixed-stride records documented by their field offsets in the encoders below.
// Geometry arrays stay unquantized: MESH1 is M2's exact input topology, not its runtime output.
const LITTLE_ENDIAN_HOST = new Uint8Array(Uint32Array.of(0x01020304).buffer)[0] === 4;

export function packMeshAsset(mesh) {
  const counts = validateMesh(mesh);
  const sections = encodeSections(mesh);
  const layout = meshAssetHeaderLayout();
  const entries = [];
  let nextByteOffset = layout.headerBytes;
  for (const [name, definition] of Object.entries(MESH_SECTIONS)) {
    nextByteOffset = alignTo(nextByteOffset, 8);
    const bytes = sections[name];
    entries.push({
      name,
      id: definition.id,
      byteOffset: nextByteOffset,
      byteLength: bytes.byteLength,
      crc32: crc32(bytes),
      recordCount: counts[definition.countFrom],
      recordStride: definition.stride,
    });
    nextByteOffset += bytes.byteLength;
  }

  const asset = new Uint8Array(nextByteOffset);
  asset.set(layout.magicBytes, 0);
  const header = new DataView(asset.buffer);
  header.setUint32(8, MESH_ASSET_VERSION, true);
  header.setUint32(12, layout.headerBytes, true);
  header.setUint32(16, entries.length, true);
  header.setUint32(20, counts.vertexCount, true);
  header.setUint32(24, counts.triangleCount, true);
  header.setUint32(28, counts.chartCount, true);
  header.setUint32(32, counts.seamPairCount, true);
  header.setUint32(36, counts.seamPairCount * 2, true);
  header.setUint32(40, counts.slitComponentCount, true);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const byteOffset = layout.preambleBytes + index * layout.sectionEntryBytes;
    header.setUint32(byteOffset, entry.id, true);
    header.setUint32(byteOffset + 4, entry.byteOffset, true);
    header.setUint32(byteOffset + 8, entry.byteLength, true);
    header.setUint32(byteOffset + 12, entry.crc32, true);
    header.setUint32(byteOffset + 16, entry.recordCount, true);
    header.setUint32(byteOffset + 20, entry.recordStride, true);
    asset.set(sections[entry.name], entry.byteOffset);
  }
  return asset;
}

function validateMesh(mesh) {
  requireTyped(mesh.positions, Float32Array, 3, 'positions');
  requireTyped(mesh.normals, Float32Array, 3, 'normals');
  requireTyped(mesh.uv0, Float32Array, 2, 'uv0');
  requireTyped(mesh.indices, Uint32Array, 3, 'indices');
  requireTyped(mesh.triangleChartIds, Uint32Array, 1, 'triangleChartIds');
  const vertexCount = mesh.positions.length / 3;
  const triangleCount = mesh.indices.length / 3;
  requireCondition(mesh.normals.length / 3 === vertexCount, 'pack: normal count mismatch');
  requireCondition(mesh.uv0.length / 2 === vertexCount, 'pack: UV count mismatch');
  requireCondition(mesh.triangleChartIds.length === triangleCount, 'pack: triangle chart count mismatch');
  requireCondition(Array.isArray(mesh.charts) && mesh.charts.length > 0, 'pack: missing chart table');
  requireCondition(Array.isArray(mesh.seamPairs), 'pack: missing seam-pair table');
  requireCondition(Array.isArray(mesh.slitComponents), 'pack: missing slit-component table');
  return {
    vertexCount,
    triangleCount,
    indexCount: mesh.indices.length,
    chartCount: mesh.charts.length,
    seamPairCount: mesh.seamPairs.length,
    slitComponentCount: mesh.slitComponents.length,
  };
}

function encodeSections(mesh) {
  return {
    positions: typedBytes(mesh.positions),
    normals: typedBytes(mesh.normals),
    uv0: typedBytes(mesh.uv0),
    indices: typedBytes(mesh.indices),
    triangleChartIds: typedBytes(mesh.triangleChartIds),
    charts: encodeCharts(mesh.charts),
    seamPairs: encodeSeamPairs(mesh.seamPairs),
    slitComponents: encodeSlitComponents(mesh.slitComponents),
  };
}

function encodeCharts(charts) {
  const bytes = new Uint8Array(charts.length * MESH_SECTIONS.charts.stride);
  const view = new DataView(bytes.buffer);
  charts.forEach((chart, index) => {
    const byteOffset = index * MESH_SECTIONS.charts.stride;
    requireCondition(chart.uvBounds?.length === 4, `pack: chart ${index} has invalid UV bounds`);
    view.setUint32(byteOffset, chart.triangleCount, true);
    chart.uvBounds.forEach((value, axis) => view.setFloat32(byteOffset + 8 + axis * 4, value, true));
    view.setFloat64(byteOffset + 24, chart.uvArea, true);
  });
  return bytes;
}

function encodeSeamPairs(seamPairs) {
  const bytes = new Uint8Array(seamPairs.length * MESH_SECTIONS.seamPairs.stride);
  const view = new DataView(bytes.buffer);
  seamPairs.forEach((pair, index) => {
    const byteOffset = index * MESH_SECTIONS.seamPairs.stride;
    requireCondition(pair.sides?.length === 2, `pack: seam pair ${index} needs two sides`);
    const [side0, side1] = pair.sides;
    view.setUint32(byteOffset, side0.triangleIndex, true);
    view.setUint32(byteOffset + 4, side1.triangleIndex, true);
    view.setUint32(byteOffset + 8, side0.vertex0, true);
    view.setUint32(byteOffset + 12, side0.vertex1, true);
    view.setUint32(byteOffset + 16, side1.vertex0, true);
    view.setUint32(byteOffset + 20, side1.vertex1, true);
    view.setUint32(byteOffset + 24, side0.chartId, true);
    view.setUint32(byteOffset + 28, side1.chartId, true);
    view.setUint32(byteOffset + 32, pair.slitComponentId, true);
    view.setUint32(byteOffset + 36, pair.isSlit ? 1 : 0, true);
    view.setFloat32(byteOffset + 40, pair.foldAngleRadians, true);
    view.setFloat32(byteOffset + 44, side0.uvAltitude, true);
    view.setFloat32(byteOffset + 48, side1.uvAltitude, true);
    view.setFloat32(byteOffset + 52, pair.coincidenceError, true);
  });
  return bytes;
}

function encodeSlitComponents(components) {
  const bytes = new Uint8Array(components.length * MESH_SECTIONS.slitComponents.stride);
  const view = new DataView(bytes.buffer);
  components.forEach((component, index) => {
    const byteOffset = index * MESH_SECTIONS.slitComponents.stride;
    view.setUint32(byteOffset, component.chartId, true);
    view.setUint32(byteOffset + 4, component.edgeCount, true);
    view.setUint32(byteOffset + 8, component.maxBranchDegree, true);
    view.setUint32(byteOffset + 12, component.branchVertexCount, true);
    view.setUint32(byteOffset + 16, component.closedLoop ? 1 : 0, true);
  });
  return bytes;
}

function typedBytes(values) {
  requireCondition(LITTLE_ENDIAN_HOST, 'pack: this tool requires a little-endian host');
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength).slice();
}

function requireTyped(values, ArrayType, tupleWidth, name) {
  requireCondition(values instanceof ArrayType && values.length > 0, `pack: ${name} has wrong type`);
  requireCondition(values.length % tupleWidth === 0, `pack: ${name} has incomplete records`);
}

function alignTo(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
