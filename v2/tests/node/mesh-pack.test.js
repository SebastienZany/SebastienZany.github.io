import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_SLIT_COMPONENT, parseMeshAsset } from '../../src/atlas/asset.js';
import { packMeshAsset } from '../../tools/pack.mjs';

test('MESH1 loader round-trips every section byte-for-byte', () => {
  const packed = packMeshAsset(fixtureMesh());
  const loaded = parseMeshAsset(packed);
  assert.equal(loaded.vertexCount, 4);
  assert.equal(loaded.triangleCount, 2);
  assert.equal(loaded.chartCount, 2);
  assert.equal(loaded.seamPairCount, 2);
  assert.equal(loaded.directionalSideCount, 4);
  assert.equal(loaded.slitComponentCount, 1);

  const repacked = parseMeshAsset(packMeshAsset(loaded));
  for (const sectionName of Object.keys(loaded.rawSections)) {
    assert.deepEqual(repacked.rawSections[sectionName], loaded.rawSections[sectionName], sectionName);
  }
});

test('MESH1 loader detects a tampered section through its CRC', () => {
  const packed = packMeshAsset(fixtureMesh());
  packed[packed.length - 1] ^= 0x80;
  assert.throws(() => parseMeshAsset(packed), /CRC mismatch in slitComponents/);
});

function fixtureMesh() {
  return {
    positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0),
    normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1),
    uv0: Float32Array.of(0, 0, 0.5, 0, 0, 0.5, 1, 1),
    indices: Uint32Array.of(0, 1, 2, 2, 1, 3),
    triangleChartIds: Uint32Array.of(0, 1),
    charts: [
      { triangleCount: 1, uvBounds: [0, 0, 0.5, 0.5], uvArea: 0.125 },
      { triangleCount: 1, uvBounds: [0, 0, 1, 1], uvArea: 0.25 },
    ],
    seamPairs: [
      seamPair(0, 1, 0, 1, NO_SLIT_COMPONENT, false),
      seamPair(1, 0, 1, 1, 0, true),
    ],
    slitComponents: [{
      chartId: 1,
      edgeCount: 1,
      maxBranchDegree: 1,
      branchVertexCount: 0,
      closedLoop: false,
    }],
  };
}

function seamPair(triangle0, triangle1, chart0, chart1, slitComponentId, isSlit) {
  return {
    sides: [
      { triangleIndex: triangle0, vertex0: 1, vertex1: 2, chartId: chart0, uvAltitude: 0.25 },
      { triangleIndex: triangle1, vertex0: 1, vertex1: 2, chartId: chart1, uvAltitude: 0.5 },
    ],
    slitComponentId,
    isSlit,
    foldAngleRadians: 0.75,
    coincidenceError: 1e-7,
  };
}
