import { BASE_POPULATION_CONTROL_VALUES } from '../shared/params.js';

const SAMPLE_LIMIT = 240;
const SUPPLY_EPSILON = 1e-6;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function createPopulationControllerState(params, { clock } = {}) {
  const state = {
    enabled: false,
    target: BASE_POPULATION_CONTROL_VALUES.populationTarget,
    lastSampleTime: 0,
    lastCount: null,
    growthRate: 0,
    commandedGrowthRate: 0,
    logPopulationError: 0,
    lastOatSupplyRate: params.oatSupplyRate,
    saturatedLow: false,
    saturatedHigh: false,
    secondarySeverity: 0,
    baseBurnRate: params.burnRate,
    baseReproThreshold: params.reproThreshold,
    samples: [],
  };
  resetPopulationController(params, state, { clock });
  return state;
}

export function resetPopulationController(params, state, { clock, preserveBase = false } = {}) {
  if (!preserveBase) {
    state.baseBurnRate = params.burnRate;
    state.baseReproThreshold = params.reproThreshold;
  }
  state.enabled = Boolean(params.usePopulationControl);
  state.target = populationTarget(params);
  // The reset call is the controller epoch: one read from the injected clock,
  // before any population readback can complete or sampling period can elapse.
  state.lastSampleTime = readClock(clock);
  state.lastCount = null;
  state.growthRate = 0;
  state.commandedGrowthRate = 0;
  state.logPopulationError = 0;
  state.lastOatSupplyRate = params.oatSupplyRate;
  state.saturatedLow = false;
  state.saturatedHigh = false;
  state.secondarySeverity = 0;
  state.samples = [];
  return clonePopulationControllerState(state);
}

/** Fresh semantic transcription of main.js:19371–19492. */
export function updatePopulationController(params, state, {
  clock,
  visibleAgents,
  force = false,
} = {}) {
  if (!params.usePopulationControl) return clonePopulationControllerState(state);

  const sampleTime = readClock(clock);
  const target = populationTarget(params);
  const periodMs = Math.max(1, finite(
    params.populationControlPeriodMs,
    BASE_POPULATION_CONTROL_VALUES.populationControlPeriodMs,
  ));
  if (state.lastSampleTime !== null && state.lastCount !== null
      && !force && sampleTime - state.lastSampleTime < periodMs) {
    return clonePopulationControllerState(state);
  }

  const agentCount = Math.max(finite(visibleAgents, 1), 1);
  params.useOatRationing = true;
  state.enabled = true;
  state.target = target;
  state.logPopulationError = Math.log(agentCount / target);
  if (state.lastSampleTime === null || state.lastCount === null) {
    state.lastSampleTime = sampleTime;
    state.lastCount = agentCount;
    state.lastOatSupplyRate = params.oatSupplyRate;
    return clonePopulationControllerState(state);
  }

  const dtSeconds = Math.max((sampleTime - state.lastSampleTime) / 1000, 1e-6);
  const rawGrowthRate = (Math.log(agentCount) - Math.log(Math.max(state.lastCount, 1))) / dtSeconds;
  const emaAlpha = clamp(
    finite(params.populationGrowthEmaAlpha, BASE_POPULATION_CONTROL_VALUES.populationGrowthEmaAlpha),
    0,
    1,
  );
  state.growthRate = state.samples.length === 0
    ? rawGrowthRate
    : state.growthRate + emaAlpha * (rawGrowthRate - state.growthRate);

  const deadband = Math.max(0, finite(
    params.populationDeadbandFraction,
    BASE_POPULATION_CONTROL_VALUES.populationDeadbandFraction,
  ));
  const effectiveLogError = Math.abs(agentCount - target) / target < deadband
    ? 0
    : state.logPopulationError;
  const lambda = Math.max(0, finite(params.populationLambda, BASE_POPULATION_CONTROL_VALUES.populationLambda));
  const commandLimit = Math.max(0, finite(
    params.populationMaxCommandedGrowthRate,
    BASE_POPULATION_CONTROL_VALUES.populationMaxCommandedGrowthRate,
  ));
  state.commandedGrowthRate = clamp(-lambda * effectiveLogError, -commandLimit, commandLimit);

  const growthError = state.commandedGrowthRate - state.growthRate;
  const supplyGain = Math.max(0, finite(
    params.populationSupplyLogGain,
    BASE_POPULATION_CONTROL_VALUES.populationSupplyLogGain,
  ));
  const { min: supplyMin, max: supplyMax } = oatSupplyBounds(params);
  const currentSupply = Math.max(finite(params.oatSupplyRate, supplyMin), SUPPLY_EPSILON);
  const requestedSupply = Math.exp(Math.log(currentSupply) + supplyGain * growthError);
  const nextSupply = clamp(requestedSupply, supplyMin, supplyMax);
  state.saturatedLow = nextSupply <= supplyMin + SUPPLY_EPSILON;
  state.saturatedHigh = nextSupply >= supplyMax - SUPPLY_EPSILON;
  params.oatSupplyRate = nextSupply;
  applySecondaryActuator(params, state, agentCount, target, state.saturatedLow);

  state.lastSampleTime = sampleTime;
  state.lastCount = agentCount;
  state.lastOatSupplyRate = params.oatSupplyRate;
  recordSample(state, sampleTime, agentCount);
  return clonePopulationControllerState(state);
}

export function clonePopulationControllerState(state) {
  return { ...state, samples: state.samples.map((sample) => ({ ...sample })) };
}

export function restorePopulationControllerState(snapshot) {
  return clonePopulationControllerState({ ...snapshot, samples: snapshot.samples ?? [] });
}

function applySecondaryActuator(params, state, agentCount, target, saturatedLow) {
  const growthThreshold = Math.max(0, finite(
    params.populationSecondaryGrowthThreshold,
    BASE_POPULATION_CONTROL_VALUES.populationSecondaryGrowthThreshold,
  ));
  const activationRatio = Math.max(1, finite(
    params.populationSecondaryOvershootRatio,
    BASE_POPULATION_CONTROL_VALUES.populationSecondaryOvershootRatio,
  ));
  let rawSeverity = 0;
  if (params.populationUseSecondaryActuator
      && saturatedLow
      && agentCount > target * activationRatio
      && state.growthRate > growthThreshold) {
    const overshootWindow = Math.max(0.05, activationRatio * 0.35);
    const growthWindow = Math.max(0.01, growthThreshold * 4);
    const overshootSeverity = smoothstep(activationRatio, activationRatio + overshootWindow, agentCount / Math.max(1, target));
    const growthSeverity = smoothstep(growthThreshold, growthThreshold + growthWindow, state.growthRate);
    rawSeverity = clamp(overshootSeverity * growthSeverity, 0, 1);
  }

  const blend = rawSeverity > state.secondarySeverity ? 0.16 : 0.10;
  let severity = state.secondarySeverity + (rawSeverity - state.secondarySeverity) * blend;
  if (severity < 1e-4) severity = 0;
  state.secondarySeverity = clamp(severity, 0, 1);
  const burnBoost = Math.max(0, finite(params.populationBurnBoostMax, BASE_POPULATION_CONTROL_VALUES.populationBurnBoostMax));
  const reproBoost = Math.max(0, finite(params.populationReproBoostMax, BASE_POPULATION_CONTROL_VALUES.populationReproBoostMax));
  params.burnRate = state.baseBurnRate + state.secondarySeverity * burnBoost;
  params.reproThreshold = state.baseReproThreshold + state.secondarySeverity * reproBoost;
}

function populationTarget(params) {
  return Math.max(1, finite(params.populationTarget, BASE_POPULATION_CONTROL_VALUES.populationTarget));
}

function oatSupplyBounds(params) {
  const minimum = Math.max(SUPPLY_EPSILON, finite(
    params.populationOatSupplyMin,
    BASE_POPULATION_CONTROL_VALUES.populationOatSupplyMin,
  ));
  return {
    min: minimum,
    max: Math.max(minimum, finite(params.populationOatSupplyMax, BASE_POPULATION_CONTROL_VALUES.populationOatSupplyMax)),
  };
}

function readClock(clock) {
  if (!clock || typeof clock.now !== 'function') {
    throw new TypeError('population controller requires an injected clock');
  }
  const time = Number(clock.now());
  if (!Number.isFinite(time)) throw new RangeError('population controller clock must return a finite time');
  return time;
}

function recordSample(state, time, agents) {
  state.samples.push({
    time,
    agents,
    growthRate: state.growthRate,
    commandedGrowthRate: state.commandedGrowthRate,
    oatSupplyRate: state.lastOatSupplyRate,
    logPopulationError: state.logPopulationError,
    saturatedLow: state.saturatedLow,
    saturatedHigh: state.saturatedHigh,
    secondarySeverity: state.secondarySeverity,
  });
  if (state.samples.length > SAMPLE_LIMIT) state.samples.splice(0, state.samples.length - SAMPLE_LIMIT);
}

function smoothstep(low, high, value) {
  const amount = clamp((value - low) / (high - low), 0, 1);
  return amount * amount * (3 - 2 * amount);
}
