import { FRAME_DT_CLAMP, MAX_SIMULATION_STEPS } from './constants.js';

const LEGACY_FRAME_MS = 16.6667;

/** Converts rendered-frame time into the legacy or fixed-tick simulation law. */
export function createSimulationTimebase({ fixedTick = false } = {}) {
  let accumulatorMs = 0;

  return {
    fixedTick,
    frame(elapsedMs, simulationSteps = 1) {
      const stepCount = Math.max(0, Math.min(MAX_SIMULATION_STEPS, Math.round(simulationSteps)));
      if (stepCount === 0) return [];
      if (!fixedTick) {
        const rawDt = Math.min(Math.max(elapsedMs, 0) / LEGACY_FRAME_MS, FRAME_DT_CLAMP);
        return Array.from({ length: stepCount }, () => rawDt / stepCount);
      }
      accumulatorMs += Math.max(elapsedMs, 0);
      const substeps = [];
      while (accumulatorMs + 1e-9 >= LEGACY_FRAME_MS) {
        accumulatorMs -= LEGACY_FRAME_MS;
        for (let index = 0; index < stepCount; index += 1) substeps.push(1 / stepCount);
      }
      return substeps;
    },
    snapshot() {
      return { fixedTick, accumulatorMs };
    },
    restore(snapshot) {
      if (Boolean(snapshot.fixedTick) !== fixedTick) throw new Error('Snapshot timebase mode does not match this simulation');
      accumulatorMs = Math.max(0, Number(snapshot.accumulatorMs) || 0);
    },
  };
}
