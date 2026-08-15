import { PARAM_BUFFER_BYTES } from './params-layout.js';

export function createSimulationLayouts(device) {
  const compute = GPUShaderStage.COMPUTE;
  const uniform = { buffer: { type: 'uniform', minBindingSize: PARAM_BUFFER_BYTES } };
  const storage = { buffer: { type: 'storage' } };
  const readonly = { buffer: { type: 'read-only-storage' } };
  const sampledField = { texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } };
  const storageField = { storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '2d' } };
  const make = (label, resources) => device.createBindGroupLayout({
    label,
    entries: resources.map((resource, binding) => ({ binding, visibility: compute, ...resource })),
  });

  const layouts = {
    oat: make('sim-oat-layout', [uniform, readonly, storageField]),
    scatter: make('sim-agent-scatter-layout', [uniform, readonly, storage, storage]),
    crowdResolve: make('sim-crowd-resolve-layout', [uniform, storage, storageField]),
    textureFilter: make('sim-texture-filter-layout', [uniform, sampledField, storageField]),
    advance: make('sim-advance-layout', [
      uniform, readonly, storage, storage, storage, sampledField, sampledField, sampledField,
    ]),
    birth: make('sim-birth-layout', [uniform, storage, storage, readonly, storage, storage]),
    indirect: make('sim-indirect-layout', [uniform, storage, storage, storage, storage]),
    field: make('sim-field-layout', [uniform, sampledField, storage, storageField]),
    hash: make('sim-hash-layout', [uniform, readonly, storage, sampledField, storage]),
  };
  return Object.fromEntries(Object.entries(layouts).map(([name, bindGroupLayout]) => [name, {
    bindGroupLayout,
    pipelineLayout: device.createPipelineLayout({ label: `${name}-pipeline-layout`, bindGroupLayouts: [bindGroupLayout] }),
  }]));
}
