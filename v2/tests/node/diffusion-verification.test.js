import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBoundaryFrameIndex } from '../../tools/boundary-index.mjs';
import { verifyDiffusionMass } from '../../tools/diffusion-verification.mjs';
import { fixtureBakeMesh } from '../../tools/fixture-pipeline.mjs';
import { buildFixtureSet } from '../../tools/fixtures.mjs';
import { rasterizeAtlas } from '../../tools/rasterize.mjs';
import { repackAtlasWithTarget } from '../../tools/repack.mjs';
import { buildDirectionalFrames } from '../../tools/seams.mjs';
import { splitChartLocalSlits } from '../../tools/slit-split.mjs';

test('per-curve flux ledger detects a wrong tap on the cone fixture', () => {
  const mesh = splitChartLocalSlits(fixtureBakeMesh(buildFixtureSet()['three-chart-corner']));
  const repack = repackAtlasWithTarget(mesh, {
    fieldSize: 128,
    gutterTexels: 2,
    directTapClampTexels: 1,
    densityScale: 0.3,
    role: 'fixture',
  });
  const frames = buildDirectionalFrames(mesh, repack);
  const raster = rasterizeAtlas(mesh, repack);
  const boundary = buildBoundaryFrameIndex(mesh, repack, frames, raster.authoritativeOwner);
  const result = verifyDiffusionMass(repack, raster, boundary, 100);
  assert.equal(result.massBoundPassed, true);
  assert.equal(result.bandBoundPassed, true);
  assert.equal(result.wrongTapDetected, true);
  assert.ok(result.maximumLedgerResidual < 1e-12);
});
