import { fetchWgsl } from '../gpu/wgsl.js';
import {
  AGENT_WORKGROUP_SIZE,
  FIELD_WORKGROUP_SIZE,
  MAX_OATS,
  OAT_SUPPORT_SIGMAS,
} from './constants.js';
import { PARAM_WGSL_CONSTANTS } from './params-layout.js';

const SHADERS = Object.freeze({
  oat: 'oat-field.wgsl',
  crowdScatter: 'crowd-scatter.wgsl',
  crowdResolve: 'crowd-resolve.wgsl',
  crowdFilter: 'crowd-filter.wgsl',
  agents: 'agents.wgsl',
  birth: 'birth.wgsl',
  indirect: 'indirect.wgsl',
  exposure: 'exposure.wgsl',
  field: 'field.wgsl',
  hash: 'state-hash.wgsl',
});

export async function createSimulationPipelines(device, layouts, { onCompilationMessage } = {}) {
  const constants = {
    ...PARAM_WGSL_CONSTANTS,
    AGENT_WORKGROUP_SIZE,
    FIELD_WORKGROUP_SIZE,
    MAX_OATS,
    OAT_SUPPORT_SIGMAS,
  };
  const baseUrl = new URL('./', import.meta.url);
  const sources = Object.fromEntries(await Promise.all(Object.entries(SHADERS).map(async ([name, file]) => [
    name,
    await fetchWgsl(new URL(file, baseUrl), { constants }),
  ])));
  const modules = {};
  for (const [name, code] of Object.entries(sources)) {
    const module = device.createShaderModule({ label: `sim-${name}-module`, code });
    modules[name] = module;
    if (typeof module.getCompilationInfo === 'function') {
      const info = await module.getCompilationInfo();
      for (const message of info.messages) onCompilationMessage?.({ shader: name, ...message });
      const errors = info.messages.filter(({ type }) => type === 'error');
      if (errors.length > 0) throw new Error(`WGSL compilation failed for ${name}: ${errors.map(({ message }) => message).join('; ')}`);
    }
  }

  const make = (label, layout, module, entryPoint) => device.createComputePipelineAsync({
    label,
    layout: layouts[layout].pipelineLayout,
    compute: { module: modules[module], entryPoint },
  });
  const entries = {
    oat: ['sim-oat-refresh-pipeline', 'oat', 'oat', 'refreshOatField'],
    crowdScatter: ['sim-crowd-scatter-pipeline', 'scatter', 'crowdScatter', 'scatterCrowd'],
    crowdResolve: ['sim-crowd-resolve-pipeline', 'crowdResolve', 'crowdResolve', 'resolveCrowd'],
    crowdBlur: ['sim-crowd-blur-pipeline', 'textureFilter', 'crowdFilter', 'blurCrowd'],
    crowdQuantize: ['sim-crowd-quantize-pipeline', 'textureFilter', 'crowdFilter', 'quantizeCrowd'],
    advance: ['sim-advance-pipeline', 'advance', 'agents', 'advanceSurvivors'],
    birth: ['sim-birth-pipeline', 'birth', 'birth', 'admitChildren'],
    prepare: ['sim-prepare-survivors-pipeline', 'indirect', 'indirect', 'prepareSurvivors'],
    finalize: ['sim-finalize-admission-pipeline', 'indirect', 'indirect', 'finalizeAdmission'],
    exposure: ['sim-exposure-scatter-pipeline', 'scatter', 'exposure', 'scatterExposure'],
    diffuse: ['sim-field-diffuse-pipeline', 'field', 'field', 'diffuseField'],
    delta: ['sim-field-delta-pipeline', 'field', 'field', 'applyExposureDelta'],
    hashAgents: ['sim-hash-agents-pipeline', 'hash', 'hash', 'hashAgents'],
    hashField: ['sim-hash-field-pipeline', 'hash', 'hash', 'hashField'],
  };
  return Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([name, args]) => [
    name,
    await make(...args),
  ])));
}
