import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBoundaryFrameIndex } from '../../tools/boundary-index.mjs';
import { fixtureBakeMesh } from '../../tools/fixture-pipeline.mjs';
import { buildFixtureSet } from '../../tools/fixtures.mjs';
import { rasterizeAtlas } from '../../tools/rasterize.mjs';
import { repackAtlasWithTarget } from '../../tools/repack.mjs';
import { buildDirectionalFrames } from '../../tools/seams.mjs';
import { splitChartLocalSlits } from '../../tools/slit-split.mjs';
import { verifySeamConditionedTransport } from '../../tools/transport-verification.mjs';

test('conditioned walks cross real fixture seams with continuous position and heading', () => {
  const mesh = splitChartLocalSlits(fixtureBakeMesh(buildFixtureSet()['seam-quad']));
  const repack = repackAtlasWithTarget(mesh, {
    fieldSize: 1024,
    gutterTexels: 3,
    directTapClampTexels: 2,
    densityScale: 0.3,
    role: 'fixture',
  });
  const frames = buildDirectionalFrames(mesh, repack);
  const raster = rasterizeAtlas(mesh, repack);
  const boundary = buildBoundaryFrameIndex(mesh, repack, frames, raster.authoritativeOwner);
  const result = verifySeamConditionedTransport(mesh, repack, raster, boundary, frames, 1_000);
  assert.equal(result.resolverFailures, 0);
  assert.equal(result.positionViolations, 0);
  assert.equal(result.headingViolations, 0);
  assert.ok(result.crossBackEligible > 900);
});
