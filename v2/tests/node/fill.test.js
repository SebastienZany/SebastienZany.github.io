import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diffuseWithLedger,
  fillGutters,
  resolveAtlasStep,
  scatterAdjoint,
  transposeInnerProducts,
} from '../../src/atlas/fill.js';
import { GUTTER_RECORD_OFFSET } from '../../tools/atlas-constants.mjs';
import { fixtureBakeMesh } from '../../tools/fixture-pipeline.mjs';
import { buildFixtureSet } from '../../tools/fixtures.mjs';
import { rasterizeAtlas } from '../../tools/rasterize.mjs';
import { repackAtlasWithTarget } from '../../tools/repack.mjs';
import { splitChartLocalSlits } from '../../tools/slit-split.mjs';

test('gutter gather and adjoint scatter obey conservation and transpose identity', () => {
  const gutter = {
    recordCount: 1,
    coords: Uint32Array.of(4),
    tapIndices: Uint32Array.of(0, 1, 0, 0),
    weights: Float32Array.of(0.25, 0.75, 0, 0),
  };
  const ownership = Uint32Array.of(1, 1, 0, 0, GUTTER_RECORD_OFFSET);
  const field = Float64Array.of(2, 6, 0, 0, 0);
  assert.equal(fillGutters(field, gutter)[4], 5);
  const scattered = new Float64Array(field.length);
  scatterAdjoint(scattered, ownership, gutter, 4, 1);
  assert.ok(Math.abs(scattered.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  const identity = transposeInnerProducts(field, Float64Array.of(0.7), gutter, field.length);
  assert.ok(identity.error < 1e-12);
  assert.notEqual(0.25 ** 2 + 0.75 ** 2, 1, 'gather-after-scatter is not an identity for bilinear weights');
});

test('CPU resolver tries the per-texel frame list and transports heading with M', () => {
  const fieldSize = 4;
  const owner = new Uint32Array(fieldSize ** 2);
  owner[1 * fieldSize] = 1;
  owner[1 * fieldSize + 2] = 2;
  const frame = {
    id: 1,
    srcRef: [0.1, 0.25],
    dstRef: [0.1, 0.25],
    matrix: { m00: 2, m01: 0, m10: 0, m11: 1 },
    sourceChart: 1,
    destinationChart: 2,
  };
  const boundaryIndex = {
    frameListCounts: Uint8Array.from({ length: fieldSize ** 2 }, (_, index) => index === 4 ? 1 : 0),
    frameLists: new Uint32Array(fieldSize ** 2 * 4),
  };
  boundaryIndex.frameLists[4 * 4] = 1;
  const result = resolveAtlasStep({
    baseUv: [0.1, 0.3],
    candidateUv: [0.3, 0.3],
    heading: [1, 1],
    fieldSize,
    authoritativeOwner: owner,
    boundaryIndex,
    frameTable: { frames: [frame] },
  });
  assert.equal(result.valid, true);
  assert.equal(result.frameId, 1);
  assert.ok(Math.abs(result.heading[0] - 2 / Math.sqrt(5)) < 1e-12);
});

test('diffusion ledger closes exactly after deposits, depletion, and clamp', () => {
  const fieldSize = 3;
  const owner = new Uint32Array(fieldSize ** 2).fill(1);
  const gutter = { recordCount: 0, coords: new Uint32Array(), tapIndices: new Uint32Array(), weights: new Float32Array() };
  const field = Float64Array.from({ length: fieldSize ** 2 }, (_, index) => index / 8);
  const deposits = new Float64Array(field.length); deposits[4] = 0.5;
  const depletion = new Float64Array(field.length); depletion[4] = 0.2;
  const result = diffuseWithLedger(field, {
    fieldSize,
    authoritativeOwner: owner,
    gutter,
    chartTable: [{ worldAreaPerTexel: 2 }],
  }, { deposits, depletion, upperClamp: 0.7 });
  assert.ok(Math.abs(result.ledger.residual) < 1e-12);
  assert.equal(result.ledger.deposits, 1);
  assert.ok(result.ledger.acceptedDepletion > 0);
  assert.ok(result.ledger.upperClampLoss > 0);
});

test('100-step fixture drift is bounded and a wrong diffusion tap fails the locked flux gate', () => {
  // The locked 0.5% one-step bound includes the 0.4764% cone-corner fixture maximum. It is
  // world-area weighted; a texel-count total would erase the chart-density stress in this test.
  const maximumRelativeDrift = 0.005;
  const fluxFaultTolerance = 1e-5;
  for (const name of ['seam-quad', 'folded-quad-80', 'three-chart-corner']) {
    const mesh = splitChartLocalSlits(fixtureBakeMesh(buildFixtureSet()[name]));
    const repack = repackAtlasWithTarget(mesh, {
      fieldSize: 128,
      gutterTexels: 2,
      directTapClampTexels: 1,
      densityScale: 0.3,
      role: 'fixture',
    });
    const raster = rasterizeAtlas(mesh, repack);
    const atlas = {
      fieldSize: repack.fieldSize,
      authoritativeOwner: raster.authoritativeOwner,
      gutter: raster.gutter,
      chartTable: repack.chartTable,
    };
    let field = Float64Array.from(raster.authoritativeOwner, (owner, index) => (
      owner ? Math.sin(index * 12.9898) * 0.5 + 0.5 : 0
    ));
    for (let step = 0; step < 100; step += 1) {
      const result = diffuseWithLedger(field, atlas);
      const relativeDrift = Math.abs(result.ledger.seamFlux) / Math.abs(result.ledger.T_prev);
      assert.ok(relativeDrift < maximumRelativeDrift, `${name} step ${step}: ${relativeDrift}`);
      assert.ok(Math.abs(result.ledger.residual) < 1e-12, name);
      field = result.field;
    }
    const baseline = diffuseWithLedger(field, atlas);
    const injected = diffuseWithLedger(field, atlas, { wrongTapOffset: 1 });
    assert.ok(
      Math.abs(injected.ledger.seamFlux - baseline.ledger.seamFlux) > fluxFaultTolerance,
      `${name}: wrong-tap injection did not trip the flux gate`,
    );
  }
});
