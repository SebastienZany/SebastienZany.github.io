import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBlockGraph, dijkstraBlockGraph } from '../../tools/block-graph.mjs';
import { buildBoundaryFrameIndex } from '../../tools/boundary-index.mjs';
import { fixtureBakeMesh } from '../../tools/fixture-pipeline.mjs';
import { FIXTURE_FORMAT, buildFixtureSet } from '../../tools/fixtures.mjs';
import { rasterizeAtlas } from '../../tools/rasterize.mjs';
import { repackAtlasWithTarget } from '../../tools/repack.mjs';
import { buildDirectionalFrames } from '../../tools/seams.mjs';
import { splitChartLocalSlits } from '../../tools/slit-split.mjs';

test('fixture generator emits every M2 analytic seam fixture', () => {
  const fixtures = buildFixtureSet();
  assert.deepEqual(Object.keys(fixtures).sort(), [
    'cylinder',
    'folded-quad-45',
    'folded-quad-80',
    'seam-quad',
    'thin-sheet',
    'three-chart-corner',
    'two-chart-sphere',
  ]);
  for (const fixture of Object.values(fixtures)) {
    assert.equal(fixture.format, FIXTURE_FORMAT);
    assert.equal(fixture.attributes.positions.length % 3, 0);
    assert.equal(fixture.attributes.uv.length / 2, fixture.attributes.positions.length / 3);
    assert.equal(fixture.indices.length % 3, 0);
    assert.equal(fixture.triangleChartIds.length, fixture.indices.length / 3);
    assert.ok(fixture.seams.length > 0);
  }
  assert.notEqual(fixtures['seam-quad'].attributes.uv[3], fixtures['seam-quad'].attributes.uv[13]);
  assert.equal(fixtures['folded-quad-80'].seams[0].foldAngleDegrees, 80);
  assert.equal(fixtures['three-chart-corner'].seams.length, 3);
  assert.equal(fixtures['thin-sheet'].seams[0].worldGap, 0.02);
});

test('every analytic fixture traverses the same split, repack, frame, walk, and graph pipeline', () => {
  for (const [name, fixture] of Object.entries(buildFixtureSet())) {
    const mesh = fixtureBakeMesh(fixture);
    const split = splitChartLocalSlits(mesh);
    const repack = repackAtlasWithTarget(split, {
      fieldSize: 128,
      gutterTexels: 2,
      directTapClampTexels: 1,
      densityScale: 0.3,
      role: 'fixture',
    });
    const frames = buildDirectionalFrames(split, repack);
    const raster = rasterizeAtlas(split, repack);
    const boundary = buildBoundaryFrameIndex(split, repack, frames, raster.authoritativeOwner);
    const graph = buildBlockGraph(split, repack, raster, 16);
    assert.equal(raster.gutter.deadCount, 0, name);
    assert.equal(frames.frameCount, split.seamPairs.length * 2, name);
    assert.ok(boundary.coveredTexelCount > 0, name);
    assert.ok(graph.nodeCount >= split.charts.length, name);

    if (name === 'thin-sheet') {
      const distance = dijkstraBlockGraph(graph, 0);
      assert.ok([...distance].some((value) => value === Infinity), 'parallel disconnected sheets must not gain a geodesic edge');
    }
  }
});
