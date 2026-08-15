import {
  RENDER_PRESETS,
  SIMULATION_PRESETS,
  createParams,
} from '../shared/params.js';

const simulationKeys = new Set(Object.keys(SIMULATION_PRESETS[0].values));
const renderKeys = new Set(Object.keys(RENDER_PRESETS[0].values));

export function createPanelModel({ values = createParams(), onPatch = () => {} } = {}) {
  let params = createParams(values);
  let simulationPresetId = findMatchingPreset(SIMULATION_PRESETS, params) ?? 'custom';
  let renderPresetId = findMatchingPreset(RENDER_PRESETS, params) ?? 'custom';
  const listeners = new Set();

  function commit(patch, source, presetChanges = {}) {
    params = createParams({ ...params, ...patch });
    simulationPresetId = presetChanges.simulation ?? simulationPresetId;
    renderPresetId = presetChanges.render ?? renderPresetId;
    onPatch(Object.freeze({ ...patch }), Object.freeze({ source }));
    const state = getState();
    for (const listener of listeners) listener(state);
    return state;
  }

  function setParam(parameterName, value) {
    const patch = { [parameterName]: value };
    const presetChanges = {};
    if (simulationKeys.has(parameterName)) presetChanges.simulation = 'custom';
    if (renderKeys.has(parameterName)) presetChanges.render = 'custom';
    // Anchored population-control behavior: it cannot run on an unrationed oat supply.
    if (parameterName === 'usePopulationControl' && value === true) patch.useOatRationing = true;
    return commit(patch, 'manual', presetChanges);
  }

  function applyPreset(kind, presetId) {
    const presets = kind === 'simulation' ? SIMULATION_PRESETS : RENDER_PRESETS;
    const preset = presets.find(({ id }) => id === presetId);
    if (!preset) throw new RangeError(`Unknown ${kind} preset: ${presetId}`);
    return commit(preset.values, `preset:${presetId}`, { [kind]: presetId });
  }

  function replaceValues(nextValues) {
    params = createParams(nextValues);
    simulationPresetId = findMatchingPreset(SIMULATION_PRESETS, params) ?? 'custom';
    renderPresetId = findMatchingPreset(RENDER_PRESETS, params) ?? 'custom';
    const state = getState();
    for (const listener of listeners) listener(state);
    return state;
  }

  function getState() {
    return Object.freeze({
      params: Object.freeze({ ...params }),
      simulationPresetId,
      renderPresetId,
    });
  }

  return Object.freeze({
    getState,
    setParam,
    applySimulationPreset: (presetId) => applyPreset('simulation', presetId),
    applyRenderPreset: (presetId) => applyPreset('render', presetId),
    replaceValues,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

function findMatchingPreset(presets, params) {
  return presets.find(({ values }) => Object.entries(values).every(([name, value]) => params[name] === value))?.id;
}

