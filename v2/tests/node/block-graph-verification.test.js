import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBlockGraph } from '../../tools/block-graph.mjs';
import { verifyBlockGraph } from '../../tools/block-graph-verification.mjs';
import { fixtureBakeMesh } from '../../tools/fixture-pipeline.mjs';
import { buildFixtureSet } from '../../tools/fixtures.mjs';
import { rasterizeAtlas } from '../../tools/rasterize.mjs';
import { repackAtlasWithTarget } from '../../tools/repack.mjs';
import { splitChartLocalSlits } from '../../tools/slit-split.mjs';

test('fixture block graphs stay within exact intrinsic bounds and interpolate continuously', () => {
  for (const [name, fixture] of Object.entries(buildFixtureSet())) {
    const mesh = splitChartLocalSlits(fixtureBakeMesh(fixture));
    const repack = repackAtlasWithTarget(mesh, {
      fieldSize: 256,
      gutterTexels: 2,
      directTapClampTexels: 1,
      densityScale: 0.3,
      role: 'fixture',
    });
    const raster = rasterizeAtlas(mesh, repack);
    const graph = buildBlockGraph(mesh, repack, raster, 16);
    const result = verifyBlockGraph(mesh, repack, raster, graph);
    assert.ok(result.distanceSampleCount > 0, name);
    assert.equal(result.distanceViolationCount, 0, name);
    assert.ok(result.continuitySampleCount > 0, name);
    assert.equal(result.continuityViolationCount, 0, name);
    for (const node of graph.nodes) {
      assert.equal(raster.triangleMap[node.representativeTexel], node.representativeTriangle, name);
      assert.ok(node.worldCenter.every(Number.isFinite), name);
      assert.ok(node.atlasCenter.every(Number.isFinite), name);
    }
  }
});
