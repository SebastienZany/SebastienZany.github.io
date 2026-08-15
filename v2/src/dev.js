import { acquireDevice } from './gpu/device.js';
import { GpuRegistry } from './gpu/registry.js';
import { createField2dRenderer } from './render/field2d.js';
import { createClock } from './shared/clock.js';
import { createFlatTorusSimulation } from './sim/sim.js';

const query = new URLSearchParams(location.search);
let testClockSourceMs = 0;
const injectedTestClock = query.get('testclock') === '1'
  ? createClock({ read: () => testClockSourceMs })
  : null;
const DEV_OATS = Object.freeze([
  { uvPos: [0.5, 0.5], radiusUv: 0.02 },
  { uvPos: [0.25, 0.30], radiusUv: 0.014 },
  { uvPos: [0.75, 0.30], radiusUv: 0.014 },
  { uvPos: [0.28, 0.74], radiusUv: 0.014 },
  { uvPos: [0.72, 0.74], radiusUv: 0.014 },
]);
const state = {
  device: null,
  registry: null,
  sim: null,
  renderer: null,
  uncapturedErrors: [],
  paused: query.get('paused') === '1',
  testClock: injectedTestClock ? {
    now: () => injectedTestClock.now(),
    set(timeMs) {
      if (!Number.isFinite(timeMs)) throw new RangeError('test clock time must be finite');
      testClockSourceMs = timeMs;
      return injectedTestClock.now();
    },
  } : null,
  ready: null,
};
window.__v2 = state;
state.ready = initialize();

async function initialize() {
  const acquisition = await acquireDevice({
    onDeviceLost: ({ reason, message }) => showError(`Device lost (${reason}): ${message}`),
  });
  if (!acquisition.ok) {
    document.querySelector('#status').textContent = 'WebGPU unavailable';
    showError(`${acquisition.stage}: ${acquisition.message}`);
    return state;
  }
  state.device = acquisition.device;
  state.registry = new GpuRegistry(state.device);
  state.device.addEventListener('uncapturederror', (event) => {
    event.preventDefault();
    const message = event.error?.message || 'Unknown WebGPU error';
    state.uncapturedErrors.push(message);
    showError(message);
  });

  const fieldSize = integerQuery('field', 256, 64, 1536);
  const capacity = integerQuery('cap', 100_000, 1, 500_000);
  const seedCount = Math.min(integerQuery('seed', 4_000, 0, capacity), capacity);
  const target = query.has('target') ? integerQuery('target', 100_000, 1, Math.min(capacity, 262_144)) : null;
  state.sim = await createFlatTorusSimulation({
    device: state.device,
    registry: state.registry,
    fieldSize,
    capacity,
    seedCount,
    randomSeed: integerQuery('rng', 1, 0, 0xffff_ffff),
    fixedTick: query.get('fixedtick') === '1',
    crowdFloat: query.get('crowdfloat') === '1',
    oats: DEV_OATS,
    params: target === null ? {} : { usePopulationControl: true, populationTarget: target },
    onGpuError: ({ label, message }) => showError(`${label}: ${message}`),
    onCompilationMessage: (message) => console.warn(`[${message.shader}] ${message.message}`),
    clock: injectedTestClock ?? undefined,
  });
  state.renderer = await createField2dRenderer({
    device: state.device,
    canvas: document.querySelector('#surface'),
    sim: state.sim,
    onCompilationMessage: (message) => console.warn(`[${message.shader}] ${message.message}`),
  });
  installControls(state.sim);
  document.querySelector('#status').textContent = `Flat torus ${fieldSize}² · cap ${capacity.toLocaleString()}`;
  startLoop();
  return state;
}

function startLoop() {
  let previousTime = null;
  let smoothedFps = 0;
  let lastCountAt = -Infinity;
  let countBusy = false;
  let submittedSteps = 0;
  const frame = (time) => {
    if (previousTime !== null) {
      const elapsed = Math.min(time - previousTime, 100);
      if (!state.paused) submittedSteps += state.sim.advance(elapsed);
      const fps = 1000 / Math.max(elapsed, 0.01);
      smoothedFps = smoothedFps === 0 ? fps : smoothedFps * 0.92 + fps * 0.08;
      document.querySelector('#fps').textContent = smoothedFps.toFixed(1);
      document.querySelector('#steps').textContent = submittedSteps.toLocaleString();
    }
    previousTime = time;
    state.renderer.render({ showAgentDots: true });
    if (!countBusy && time - lastCountAt >= 500) {
      countBusy = true;
      lastCountAt = time;
      state.sim.count().then((count) => {
        document.querySelector('#agents').textContent = count.toLocaleString();
        if (!state.paused && state.sim.params.usePopulationControl) return state.sim.samplePopulation();
        return null;
      }).catch((error) => showError(error.message)).finally(() => { countBusy = false; });
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function installControls(sim) {
  const definitions = [
    ['uptakeRate', 'Uptake', 0.005, 0.09, 0.001],
    ['depositRate', 'Deposit', 0.001, 0.05, 0.001],
    ['burnRate', 'Burn', 0.001, 0.045, 0.001],
    ['reproThreshold', 'Reproduction', 0.2, 4.5, 0.05],
    ['foodWeight', 'Food weight', 0.2, 3.5, 0.05],
    ['crowdWeight', 'Crowd weight', 0, 3.5, 0.05],
    ['densityBlur', 'Crowd blur', 1, 64, 0.5],
    ['densityTarget', 'Ideal density', 0.02, 0.7, 0.01],
    ['fieldDecay', 'Field decay', 0.94, 1, 0.001],
    ['simulationSteps', 'Steps/frame', 0, 8, 1],
  ];
  const controls = document.querySelector('#controls');
  for (const [name, labelText, min, max, step] of definitions) {
    const label = document.createElement('label');
    const text = document.createElement('span');
    const input = document.createElement('input');
    const output = document.createElement('output');
    text.textContent = labelText;
    input.type = 'range';
    Object.assign(input, { min, max, step, value: sim.params[name] });
    output.value = formatValue(sim.params[name]);
    input.addEventListener('input', () => {
      sim.params[name] = Number(input.value);
      output.value = formatValue(sim.params[name]);
    });
    label.append(text, input, output);
    controls.append(label);
  }
  document.querySelector('#pause').addEventListener('click', (event) => {
    state.paused = !state.paused;
    event.currentTarget.textContent = state.paused ? 'Resume' : 'Pause';
  });
  document.querySelector('#step').addEventListener('click', () => state.sim.step(1));
  document.querySelector('#seed').addEventListener('click', () => state.sim.seed());
}

function integerQuery(name, fallback, minimum, maximum) {
  const value = Number.parseInt(query.get(name) ?? '', 10);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : fallback));
}

function formatValue(value) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function showError(message) {
  const errors = document.querySelector('#errors');
  errors.hidden = false;
  const row = document.createElement('li');
  row.textContent = message;
  errors.querySelector('ul').append(row);
}

window.addEventListener('error', (event) => showError(event.error?.message || event.message));
window.addEventListener('unhandledrejection', (event) => showError(event.reason?.message || String(event.reason)));
