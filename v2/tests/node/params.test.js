import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PARAMETER_VALUES,
  MAX_KERNEL_FOOTPRINT,
  PARAMETER_DEFINITIONS,
  RENDER_PRESETS,
  SIMULATION_PRESETS,
  SLIDER_PARAM_BINDINGS,
  createParams,
  parseParams,
  serializeParams,
} from '../../src/shared/params.js';

test('parameter table round-trips every value', () => {
  const values = createParams();
  assert.deepEqual(parseParams(serializeParams(values)), values);
  assert.deepEqual(Object.keys(PARAMETER_DEFINITIONS).sort(), Object.keys(DEFAULT_PARAMETER_VALUES).sort());
});

test('effective defaults match the parity checklist and selected presets', () => {
  const values = createParams();
  assert.equal(values.uptakeRate, 0.035);
  assert.equal(values.stepSize, 0.0004);
  assert.equal(values.sensorDistance, 0.008);
  assert.equal(values.densityBlur, 30);
  assert.equal(values.oatSupplyRate, 0.14);
  assert.equal(values.useOatRationing, true);
  assert.equal(values.temporalSmoothing, 0.93);
  assert.equal(values.surfaceHeight, 1.4);
  assert.equal(values.surfaceBump, 5);
  assert.equal(values.iridescenceMinThickness, 220);
  assert.equal(values.iridescenceThickness, 760);
  assert.equal(values.endingTimeLimitEnabled, false);
  assert.equal(SIMULATION_PRESETS.length, 6);
  assert.equal(RENDER_PRESETS.length, 2);
});

test('every bound numeric control has a definition and exact UI bounds', () => {
  for (const parameterName of Object.values(SLIDER_PARAM_BINDINGS)) {
    assert.ok(PARAMETER_DEFINITIONS[parameterName], `missing ${parameterName}`);
  }
  assert.deepEqual(
    pickRange(PARAMETER_DEFINITIONS.densityBlur),
    { min: 1, max: 64, step: 0.5 },
  );
  assert.deepEqual(
    pickRange(PARAMETER_DEFINITIONS.simulationSteps),
    { min: 0, max: 8, step: 1 },
  );
  assert.deepEqual(
    pickRange(PARAMETER_DEFINITIONS.populationTarget),
    { min: 1, max: 262144, step: 1000 },
  );
});

test('kernel footprint contract derives a four-texel gutter', () => {
  assert.equal(MAX_KERNEL_FOOTPRINT.bumpTaps.requiredGutterTexels, 4);
  assert.ok(Object.values(MAX_KERNEL_FOOTPRINT).every(({ maxSampleReachTexels }) => maxSampleReachTexels <= 2.33));
});

function pickRange({ min, max, step }) {
  return { min, max, step };
}

