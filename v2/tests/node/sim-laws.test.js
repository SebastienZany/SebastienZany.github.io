import assert from 'node:assert/strict';
import test from 'node:test';
import { createParams } from '../../src/shared/params.js';
import {
  createPopulationControllerState,
  updatePopulationController,
} from '../../src/sim/controller.js';
import { rationedOatFood, resolveFoodDelta } from '../../src/sim/delta-oracle.js';
import { createSimulationTimebase } from '../../src/sim/timebase.js';

test('delta oracle preserves exposure normalization, cap, dt, and output clamp', () => {
  const state = {
    food: 0.42,
    density: 0.032 * 80,
    uptakeRate: 0.035,
    depositRate: 0.005,
    deltaScale: 1.35,
    dt: 0.75,
    foodClamp: 0.5,
  };
  const exposure = 64 * state.deltaScale * state.dt;
  const expected = Math.min(0.5, Math.max(0,
    state.food + state.depositRate * exposure - state.food * (1 - Math.exp(-state.uptakeRate * exposure)),
  ));
  assert.equal(resolveFoodDelta(state), expected);
  assert.notEqual(resolveFoodDelta(state), resolveFoodDelta({ ...state, density: 0.032 * 8 }));
});

test('oat rationing follows local reserve load and can be disabled', () => {
  const input = { oatFood: 1, localDensity: 0.32, uptakeRate: 0.035, oatSupplyRate: 0.14 };
  assert.equal(rationedOatFood({ ...input, enabled: false }), 1);
  assert.ok(rationedOatFood(input) < 1);
  assert.ok(rationedOatFood({ ...input, localDensity: 0.032 }) > rationedOatFood(input));
});

test('population controller honors sample timing, log command, EMA, deadband, and bounds', () => {
  const params = createParams({
    usePopulationControl: true,
    populationTarget: 1000,
    oatSupplyRate: 0.14,
    populationControlPeriodMs: 1200,
  });
  const state = createPopulationControllerState(params);
  const first = updatePopulationController(params, state, { now: 0, visibleAgents: 1000 });
  assert.equal(first.samples.length, 0);
  assert.equal(params.oatSupplyRate, 0.14);
  updatePopulationController(params, state, { now: 600, visibleAgents: 1200 });
  assert.equal(state.lastSampleTime, 0);
  const second = updatePopulationController(params, state, { now: 1200, visibleAgents: 1200 });
  assert.equal(second.samples.length, 1);
  assert.ok(second.growthRate > 0);
  assert.ok(second.commandedGrowthRate < 0);
  assert.ok(params.oatSupplyRate < 0.14);
  const growthBefore = second.growthRate;
  const third = updatePopulationController(params, state, { now: 2400, visibleAgents: 1200 });
  assert.ok(third.growthRate < growthBefore);
  assert.ok(third.growthRate > 0);

  params.populationTarget = 1190;
  const deadbanded = updatePopulationController(params, state, { now: 3600, visibleAgents: 1200 });
  assert.equal(Math.abs(deadbanded.commandedGrowthRate), 0);
  assert.ok(params.oatSupplyRate >= params.populationOatSupplyMin);
  assert.ok(params.oatSupplyRate <= params.populationOatSupplyMax);
});

test('secondary actuator is stateful and only engages at the low supply bound', () => {
  const params = createParams({
    usePopulationControl: true,
    populationTarget: 1000,
    oatSupplyRate: 0.001,
    populationUseSecondaryActuator: true,
  });
  const state = createPopulationControllerState(params);
  updatePopulationController(params, state, { now: 0, visibleAgents: 1500 });
  updatePopulationController(params, state, { now: 1200, visibleAgents: 1700 });
  assert.equal(state.saturatedLow, true);
  assert.ok(state.secondarySeverity > 0);
  assert.ok(params.burnRate > state.baseBurnRate);
  assert.ok(params.reproThreshold > state.baseReproThreshold);
});

test('legacy and fixed-tick timebases expose their deliberately different laws', () => {
  const legacy = createSimulationTimebase();
  assert.deepEqual(legacy.frame(33.3334, 2), [1, 1]);
  assert.deepEqual(legacy.frame(1000, 1), [2.2]);
  const fixed = createSimulationTimebase({ fixedTick: true });
  assert.deepEqual(fixed.frame(8, 2), []);
  assert.deepEqual(fixed.frame(9, 2), [0.5, 0.5]);
});
