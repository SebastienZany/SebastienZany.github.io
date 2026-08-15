import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseMeshAsset } from '../../src/atlas/asset.js';
import {
  MESH_VERTEX_ATTRIBUTES,
  makeMeshGeometryUploadPlan,
} from '../../src/render/mesh-geometry.js';

const meshAssetUrl = new URL('../../assets/mesh-1.bin', import.meta.url);

test('MESH1 geometry upload uses the section-table strides and offsets directly', async () => {
  const asset = parseMeshAsset(await readFile(meshAssetUrl));
  const plan = makeMeshGeometryUploadPlan(asset);
  const firstSectionOffset = asset.sectionEntries.positions.byteOffset;

  assert.equal(plan.vertexBindings.length, 3);
  assert.deepEqual(
    MESH_VERTEX_ATTRIBUTES.map(({ sectionName, shaderLocation, format }, bindingIndex) => {
      const entry = asset.sectionEntries[sectionName];
      const binding = plan.vertexBindings[bindingIndex];
      const layout = plan.vertexLayouts[bindingIndex];
      return {
        sectionName,
        shaderLocation,
        format,
        sourceOffset: entry.byteOffset,
        uploadOffset: binding.byteOffset,
        byteLength: binding.byteLength,
        stride: layout.arrayStride,
      };
    }),
    [
      {
        sectionName: 'positions', shaderLocation: 0, format: 'float32x3',
        sourceOffset: 240, uploadOffset: 0, byteLength: 3_383_772, stride: 12,
      },
      {
        sectionName: 'normals', shaderLocation: 1, format: 'float32x3',
        sourceOffset: 3_384_016, uploadOffset: 3_383_776, byteLength: 3_383_772, stride: 12,
      },
      {
        sectionName: 'uv0', shaderLocation: 2, format: 'float32x2',
        sourceOffset: 6_767_792, uploadOffset: 6_767_552, byteLength: 2_255_848, stride: 8,
      },
    ],
  );
  assert.deepEqual(plan.indexBinding, {
    sectionName: 'indices',
    byteOffset: asset.sectionEntries.indices.byteOffset - firstSectionOffset,
    byteLength: asset.sectionEntries.indices.byteLength,
    format: 'uint32',
  });
  assert.equal(plan.indexBinding.byteOffset, 9_023_400);
  assert.equal(plan.bufferByteLength, 15_040_536);
  assert.equal(asset.indexCount, 1_504_284);
});
