import assert from 'node:assert/strict';
import test from 'node:test';
import { createParams } from '../../src/shared/params.js';
import {
  CROWD_FIXED_POINT_SCALE,
  DENSITY_MASS,
  EXPOSURE_FIXED_POINT_SCALE,
  MAX_CAPACITY,
  MAX_DENSITY_RESERVE_MASS,
} from '../../src/sim/constants.js';
import {
  PARAM_BUFFER_BYTES,
  PARAM_PACKING_TABLE,
  crowdKernelSettings,
  packSimulationParams,
  unpackSimulationParams,
} from '../../src/sim/params-layout.js';

test('simulation parameter packing round-trips mixed float and u32 slots', () => {
  const params = createParams();
  const packed = packSimulationParams(params, {
    fieldSize: 1536,
    capacity: 262144,
    stepIndex: 0xf1234567,
    dt: 0.75,
    oatCount: 64,
    crowdFloat: false,
    repel: { active: true, uvX: 0.25, uvY: 0.75, radius: 0.03, strength: 1.2 },
  });
  assert.equal(packed.buffer.byteLength, PARAM_BUFFER_BYTES);
  assert.equal(PARAM_PACKING_TABLE.length * 16, PARAM_BUFFER_BYTES);
  const decoded = unpackSimulationParams(packed.buffer);
  assert.deepEqual(decoded.frame, { fieldSize: 1536, capacity: 262144, stepIndex: 0xf1234567, flags: 5 });
  assert.equal(decoded.oat.oatSupplyRate, Math.fround(params.oatSupplyRate));
  assert.equal(decoded.oat.densityMass, Math.fround(DENSITY_MASS));
  assert.equal(decoded.fixedPoint.crowdScale, CROWD_FIXED_POINT_SCALE);
  assert.equal(decoded.fixedPoint.exposureScale, EXPOSURE_FIXED_POINT_SCALE);
  assert.equal(decoded.oatMeta.oatCount, 64);
});

test('crowd kernel uses snap mode at the low end and iterated 3x3 across the moving range', () => {
  assert.equal(crowdKernelSettings(1, 1536).blurIterations, 0);
  assert.equal(crowdKernelSettings(4, 1536).blurIterations, 0);
  const defaults = crowdKernelSettings(30, 1536);
  assert.equal(defaults.blurIterations, 5);
  assert.ok(Math.abs(defaults.radiusTexels * Math.sqrt(0.15) - 1.45237) < 1e-4);
  assert.ok(crowdKernelSettings(64, 1536).blurIterations > defaults.blurIterations);
});

test('fixed-point crowd scatter cannot wrap at the declared capacity and largest slider radius', () => {
  const kernel = crowdKernelSettings(64, 1536);
  const maxPerAgent = 7 * DENSITY_MASS * kernel.kernelMass;
  assert.ok(maxPerAgent * MAX_CAPACITY * CROWD_FIXED_POINT_SCALE < 0x1_0000_0000);
});

test('fixed-point food exposure keeps 1/4096 precision without wrapping', () => {
  const maximum = MAX_DENSITY_RESERVE_MASS * DENSITY_MASS
    * MAX_CAPACITY * EXPOSURE_FIXED_POINT_SCALE;
  assert.ok(maximum < 0x1_0000_0000);
});
