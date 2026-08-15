import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyC1Reconstruction } from '../../tools/c1-verification.mjs';
import { fixtureBakeMesh } from '../../tools/fixture-pipeline.mjs';
import { buildFixtureSet } from '../../tools/fixtures.mjs';
import { rasterizeAtlas } from '../../tools/rasterize.mjs';
import { repackAtlasWithTarget } from '../../tools/repack.mjs';
import {
  measureAffineWalkBands,
  measureWalkReconstruction,
  sharpWorldField,
  smoothWorldField,
  verifyCorruptedDonorIsDetected,
  verifyCoverage,
  verifyStencilTable,
  verifyTransposeIdentity,
} from '../../tools/seam-verification.mjs';
import { buildDirectionalFrames } from '../../tools/seams.mjs';
import { splitChartLocalSlits } from '../../tools/slit-split.mjs';

test('fixture seam tables prove coverage, transpose, exact hinge walks, and fault sensitivity', () => {
  for (const [name, fixture] of Object.entries(buildFixtureSet())) {
    const mesh = splitChartLocalSlits(fixtureBakeMesh(fixture));
    const repack = repackAtlasWithTarget(mesh, {
      fieldSize: 128,
      gutterTexels: 2,
      directTapClampTexels: 1,
      densityScale: 0.3,
      role: 'fixture',
    });
    const frames = buildDirectionalFrames(mesh, repack);
    const raster = rasterizeAtlas(mesh, repack);
    assert.equal(verifyCoverage(mesh, repack, raster, 2_000).wrongChartSamples, 0, name);
    assert.ok(verifyStencilTable(mesh, repack, raster).maxWeightSumError < 1e-7, name);
    assert.ok(verifyTransposeIdentity(raster).relativeError < 2e-12, name);
    assert.equal(verifyCorruptedDonorIsDetected(mesh, repack, raster).rejected, true, name);

    const smooth = measureWalkReconstruction(mesh, repack, raster, smoothWorldField);
    const sharp = measureWalkReconstruction(mesh, repack, raster, sharpWorldField);
    assert.ok(smooth.disabledMaxValueError > Math.max(...smooth.bands.map((band) => band.maxValueError)) * 8, name);
    assert.ok(sharp.disabledMaxValueError > 0.1, name);

    const affine = measureAffineWalkBands(mesh, repack, frames, raster.surfaceTopology);
    assert.ok(Math.max(...affine.map((row) => row.maxAffineErrorTexels)) < 1e-3, name);
    const c1 = verifyC1Reconstruction(mesh, repack, raster, frames);
    assert.ok(c1.pathCount >= frames.frameCount, name);
    assert.ok(c1.smooth.negativeControlValueViolations > 0, name);
    assert.ok(c1.smooth.negativeControlGradientViolations > 0, name);
    assert.ok(c1.sharp.negativeControlValueViolations > 0, name);
    if (name === 'folded-quad-45' || name === 'folded-quad-80') {
      assert.ok(Math.max(...affine.map((row) => row.maxLegacyErrorTexels)) > 1, name);
    }
  }
});
