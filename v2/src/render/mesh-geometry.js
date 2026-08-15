import { MESH_SECTIONS, parseMeshAsset } from '../atlas/asset.js';

const MESH_ASSET_URL = new URL('../../assets/mesh-1.bin', import.meta.url);

export const MESH_VERTEX_ATTRIBUTES = Object.freeze([
  attributeDefinition('positions', 0, 'float32x3'),
  attributeDefinition('normals', 1, 'float32x3'),
  attributeDefinition('uv0', 2, 'float32x2'),
]);

export function makeMeshGeometryUploadPlan(asset) {
  if (!asset?.sectionEntries || !asset?.rawSections) {
    throw new TypeError('MESH1 geometry upload requires a parsed asset');
  }

  const firstSectionOffset = asset.sectionEntries.positions.byteOffset;
  const indexEntry = asset.sectionEntries.indices;
  const bufferByteLength = indexEntry.byteOffset + indexEntry.byteLength - firstSectionOffset;
  const vertexBindings = MESH_VERTEX_ATTRIBUTES.map((attribute) => {
    const entry = asset.sectionEntries[attribute.sectionName];
    const section = MESH_SECTIONS[attribute.sectionName];
    requireCondition(entry.recordStride === section.stride, `${attribute.sectionName} stride changed`);
    requireCondition(entry.recordCount === asset.vertexCount, `${attribute.sectionName} count changed`);
    return Object.freeze({
      sectionName: attribute.sectionName,
      byteOffset: entry.byteOffset - firstSectionOffset,
      byteLength: entry.byteLength,
    });
  });
  const vertexLayouts = MESH_VERTEX_ATTRIBUTES.map((attribute) => Object.freeze({
    arrayStride: MESH_SECTIONS[attribute.sectionName].stride,
    stepMode: 'vertex',
    attributes: Object.freeze([Object.freeze({
      shaderLocation: attribute.shaderLocation,
      offset: 0,
      format: attribute.format,
    })]),
  }));
  const indexBinding = Object.freeze({
    sectionName: 'indices',
    byteOffset: indexEntry.byteOffset - firstSectionOffset,
    byteLength: indexEntry.byteLength,
    format: 'uint32',
  });

  return Object.freeze({
    bufferByteLength,
    firstSectionOffset,
    vertexBindings: Object.freeze(vertexBindings),
    vertexLayouts: Object.freeze(vertexLayouts),
    indexBinding,
  });
}

export async function loadMeshAssetGeometry({
  device,
  registry,
  fetchImpl = fetch,
  sourceUrl = MESH_ASSET_URL,
} = {}) {
  if (!device?.createBuffer) throw new TypeError('MESH1 geometry upload requires a GPUDevice');
  if (!registry?.createBuffer) throw new TypeError('MESH1 geometry upload requires a GPU registry');

  const response = await fetchImpl(sourceUrl);
  if (!response.ok) throw new Error(`MESH1 request failed with HTTP ${response.status}`);
  const asset = parseMeshAsset(await response.arrayBuffer());
  const uploadPlan = makeMeshGeometryUploadPlan(asset);
  const geometryBuffer = registry.createBuffer({
    label: 'look-mesh1-geometry',
    size: uploadPlan.bufferByteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX,
    mappedAtCreation: true,
  });
  const destination = new Uint8Array(geometryBuffer.getMappedRange());
  for (const binding of uploadPlan.vertexBindings) {
    destination.set(asset.rawSections[binding.sectionName], binding.byteOffset);
  }
  destination.set(asset.rawSections.indices, uploadPlan.indexBinding.byteOffset);
  geometryBuffer.unmap();

  return Object.freeze({
    name: 'MESH1 cuttlefish',
    asset,
    vertexCount: asset.vertexCount,
    triangleCount: asset.triangleCount,
    vertexLayouts: uploadPlan.vertexLayouts,
    vertexBindings: Object.freeze(uploadPlan.vertexBindings.map((binding) => Object.freeze({
      buffer: geometryBuffer,
      byteOffset: binding.byteOffset,
      byteLength: binding.byteLength,
    }))),
    indexBinding: Object.freeze({
      buffer: geometryBuffer,
      byteOffset: uploadPlan.indexBinding.byteOffset,
      byteLength: uploadPlan.indexBinding.byteLength,
      format: uploadPlan.indexBinding.format,
    }),
    indexCount: asset.indexCount,
  });
}

function attributeDefinition(sectionName, shaderLocation, format) {
  return Object.freeze({ sectionName, shaderLocation, format });
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(`MESH1 geometry upload: ${message}`);
}
