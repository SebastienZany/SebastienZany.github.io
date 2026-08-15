import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureBakeMesh } from '../../tools/fixture-pipeline.mjs';
import { buildFixtureSet } from '../../tools/fixtures.mjs';
import { verifyImpulseSpread } from '../../tools/impulse-verification.mjs';
import { rasterizeAtlas } from '../../tools/rasterize.mjs';
import { repackAtlasWithTarget } from '../../tools/repack.mjs';
import { splitChartLocalSlits } from '../../tools/slit-split.mjs';

test('planar fixture impulse spread stays within the seamless tensor bound', () => {
  const mesh = splitChartLocalSlits(fixtureBakeMesh(buildFixtureSet()['seam-quad']));
  const repack = repackAtlasWithTarget(mesh, {
    fieldSize: 128,
    gutterTexels: 2,
    directTapClampTexels: 1,
    densityScale: 0.3,
    role: 'fixture',
  });
  const raster = rasterizeAtlas(mesh, repack);
  const result = verifyImpulseSpread(mesh, repack, raster, 4, 4);
  assert.equal(result.traceViolations, 0);
  assert.equal(result.ellipticityViolations, 0);
});
