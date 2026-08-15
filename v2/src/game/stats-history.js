export const HISTORY_SAMPLE_CAPACITY = 180; // main.js:273

export function createHistoryRing(capacity = HISTORY_SAMPLE_CAPACITY) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('History capacity must be a positive integer');
  const samples = new Array(capacity);
  let firstIndex = 0;
  let length = 0;

  return Object.freeze({
    push(sample) {
      const checked = validateSample(sample);
      if (length < capacity) {
        samples[(firstIndex + length) % capacity] = checked;
        length++;
      } else {
        samples[firstIndex] = checked;
        firstIndex = (firstIndex + 1) % capacity;
      }
      return checked;
    },
    clear() {
      firstIndex = 0;
      length = 0;
    },
    toArray() {
      return Array.from({ length }, (_, index) => samples[(firstIndex + index) % capacity]);
    },
    get length() {
      return length;
    },
    capacity,
  });
}

export function deriveHistorySeries(samples) {
  const population = samples.map(({ agentCount }) => agentCount);
  const growthSamples = [];
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1];
    const current = samples[index];
    const elapsedSeconds = Math.max(0.001, (current.timeMs - previous.timeMs) / 1000);
    growthSamples.push(Object.freeze({
      timeMs: current.timeMs,
      value: (current.agentCount - previous.agentCount) / elapsedSeconds,
    }));
  }

  const acceleration = [];
  for (let index = 1; index < growthSamples.length; index++) {
    const previous = growthSamples[index - 1];
    const current = growthSamples[index];
    const elapsedSeconds = Math.max(0.001, (current.timeMs - previous.timeMs) / 1000);
    const rawValue = (current.value - previous.value) / elapsedSeconds;
    const priorSmoothed = acceleration[acceleration.length - 1];
    // The chart's 0.72/0.28 EMA is display-only and does not alter population control.
    acceleration.push(priorSmoothed === undefined ? rawValue : priorSmoothed * 0.72 + rawValue * 0.28);
  }

  return Object.freeze({
    population: Object.freeze(population),
    growth: Object.freeze(growthSamples.map(({ value }) => value)),
    acceleration: Object.freeze(acceleration),
  });
}

function validateSample({ timeMs, agentCount } = {}) {
  if (!Number.isFinite(timeMs) || !Number.isFinite(agentCount)) {
    throw new TypeError('History samples require finite timeMs and agentCount');
  }
  return Object.freeze({ timeMs, agentCount });
}

