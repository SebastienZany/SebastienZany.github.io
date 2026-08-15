import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseMeshAsset } from '../../src/atlas/asset.js';
import {
  DEFAULT_ATLAS_TARGETS,
  DESKTOP_GUTTER_TEXELS,
  MIN_CHART_TEXELS,
} from '../../tools/atlas-constants.mjs';
import { splitChartLocalSlits } from '../../tools/slit-split.mjs';

const meshPath = fileURLToPath(new URL('../../assets/mesh-1.bin', import.meta.url));
const splitPromise = readFile(meshPath).then((bytes) => {
  const mesh = parseMeshAsset(bytes);
  return { mesh, split: splitChartLocalSlits(mesh) };
});

test('atlas constants derive the desktop footprint and tier the mobile direct tap', () => {
  assert.equal(DESKTOP_GUTTER_TEXELS, 4);
  assert.equal(MIN_CHART_TEXELS, 4);
  assert.deepEqual(
    DEFAULT_ATLAS_TARGETS.map(({ fieldSize, gutterTexels, directTapClampTexels }) => (
      [fieldSize, gutterTexels, directTapClampTexels]
    )),
    [[1536, 4, 3], [1024, 3, 2]],
  );
});

test('chart-local slit splitting preserves geometry and separates every original slit', async () => {
  const { mesh, split } = await splitPromise;
  assert.equal(split.indices.length, mesh.indices.length);
  assert.equal(split.triangleChartIds.length, mesh.triangleCount);
  assert.equal(split.stats.slitPairCount, 3_592);
  assert.equal(split.stats.slitComponentCount, 630);
  assert.equal(split.stats.branchVertexCount, 19);
  assert.equal(split.stats.closedLoopCount, 0);
  assert.equal(split.stats.unresolvedSlitCount, 0);
  assert.equal(split.stats.simplePathCount, 667);
  assert.equal(split.stats.outputChartCount, 1_828);
  assert.equal(split.stats.extensionEdgeCount, 8_529);

  for (let triangleIndex = 0; triangleIndex < mesh.triangleCount; triangleIndex += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const bakedVertex = split.indices[triangleIndex * 3 + corner];
      const originalVertex = split.originalVertexIds[bakedVertex];
      assert.equal(originalVertex, mesh.indices[triangleIndex * 3 + corner]);
      assert.deepEqual(
        split.positions.subarray(bakedVertex * 3, bakedVertex * 3 + 3),
        mesh.positions.subarray(originalVertex * 3, originalVertex * 3 + 3),
      );
      assert.deepEqual(
        split.normals.subarray(bakedVertex * 3, bakedVertex * 3 + 3),
        mesh.normals.subarray(originalVertex * 3, originalVertex * 3 + 3),
      );
    }
  }

  for (const pair of split.seamPairs.slice(0, mesh.seamPairCount)) {
    if (pair.wasSlit) assert.notEqual(pair.sides[0].chartId, pair.sides[1].chartId);
  }
  assert.ok(split.extensionEdges.every((pair) => pair.sides[0].chartId !== pair.sides[1].chartId));
  assert.equal(split.charts.reduce((sum, chart) => sum + chart.triangleCount, 0), mesh.triangleCount);
});

test('only declared extension edges lose indexed adjacency', async () => {
  const { mesh, split } = await splitPromise;
  const usesByEdge = new Map();
  for (let triangleIndex = 0; triangleIndex < mesh.triangleCount; triangleIndex += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex0 = mesh.indices[triangleIndex * 3 + corner];
      const vertex1 = mesh.indices[triangleIndex * 3 + ((corner + 1) % 3)];
      const low = Math.min(vertex0, vertex1);
      const edgeKey = low * mesh.vertexCount + Math.max(vertex0, vertex1);
      let uses = usesByEdge.get(edgeKey);
      if (!uses) usesByEdge.set(edgeKey, uses = []);
      uses.push(triangleIndex);
    }
  }
  let separatedAdjacencyCount = 0;
  for (const [edgeKey, uses] of usesByEdge) {
    if (uses.length !== 2) continue;
    const separated = split.triangleChartIds[uses[0]] !== split.triangleChartIds[uses[1]];
    assert.equal(separated, split.cutEdgeKeys.has(edgeKey), `indexed edge ${edgeKey}`);
    if (separated) separatedAdjacencyCount += 1;
  }
  assert.equal(separatedAdjacencyCount, split.stats.extensionEdgeCount);
});
