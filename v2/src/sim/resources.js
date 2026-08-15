import {
  AGENT_BYTES,
  MAX_OATS,
} from './constants.js';
import { PARAM_BUFFER_BYTES } from './params-layout.js';

const bufferUsage = (copySrc = false, copyDst = true) => GPUBufferUsage.STORAGE
  | (copySrc ? GPUBufferUsage.COPY_SRC : 0)
  | (copyDst ? GPUBufferUsage.COPY_DST : 0);

export function createSimulationResources(registry, { fieldSize, capacity }) {
  const fieldTexels = fieldSize * fieldSize;
  const makeBuffer = (label, size, usage) => registry.createBuffer({ label, size, usage });
  const makeField = (label) => registry.createTexture({
    label,
    size: [fieldSize, fieldSize, 1],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
      | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
  });

  const agentBuffers = [0, 1].map((index) => makeBuffer(
    `sim-agents-${index}`,
    capacity * AGENT_BYTES,
    bufferUsage(true),
  ));
  const countBuffers = [0, 1].map((index) => makeBuffer(
    `sim-count-${index}`,
    4,
    bufferUsage(true),
  ));
  const dynamicFields = [makeField('sim-field-canonical'), makeField('sim-field-diffuse-scratch')];
  const crowdFields = [makeField('sim-crowd-0'), makeField('sim-crowd-1')];
  const oatField = makeField('sim-oat-field');
  const resources = {
    fieldSize,
    fieldTexels,
    capacity,
    agentBuffers,
    countBuffers,
    dynamicFields,
    dynamicFieldViews: dynamicFields.map((texture, index) => texture.createView({ label: `sim-field-view-${index}` })),
    crowdFields,
    crowdFieldViews: crowdFields.map((texture, index) => texture.createView({ label: `sim-crowd-view-${index}` })),
    oatField,
    oatFieldView: oatField.createView({ label: 'sim-oat-field-view' }),
    parameters: makeBuffer('sim-parameters', PARAM_BUFFER_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
    oats: makeBuffer('sim-oats', MAX_OATS * 16, bufferUsage(false)),
    crowdAtomic: makeBuffer('sim-crowd-atomic', fieldTexels * 4, bufferUsage()),
    exposureAtomic: makeBuffer('sim-exposure-atomic', fieldTexels * 4, bufferUsage()),
    dispatchArgs: makeBuffer('sim-dispatch-args', 12, bufferUsage(true) | GPUBufferUsage.INDIRECT),
    renderArgs: makeBuffer('sim-render-args', 16, bufferUsage(true) | GPUBufferUsage.INDIRECT),
    survivorCount: makeBuffer('sim-survivor-count', 4, bufferUsage(true)),
    allocatorDebug: makeBuffer('sim-allocator-debug', 16, bufferUsage(true)),
    childOwnership: makeBuffer('sim-child-ownership', capacity * 4, bufferUsage()),
    stateHash: makeBuffer('sim-state-hash', 32, bufferUsage(true)),
    countReadback: makeBuffer('sim-count-readback', 4, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
    hashReadback: makeBuffer('sim-hash-readback', 32, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
    allocatorReadback: makeBuffer('sim-allocator-readback', 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
  };
  resources.all = [
    ...agentBuffers, ...countBuffers, ...dynamicFields, ...crowdFields, oatField,
    resources.parameters, resources.oats, resources.crowdAtomic, resources.exposureAtomic,
    resources.dispatchArgs, resources.renderArgs, resources.survivorCount,
    resources.allocatorDebug, resources.childOwnership, resources.stateHash,
    resources.countReadback, resources.hashReadback, resources.allocatorReadback,
  ];
  return resources;
}

export function destroySimulationResources(registry, resources) {
  for (const resource of resources.all) registry.destroy(resource);
}

export function alignedFieldRowBytes(fieldSize) {
  return Math.ceil((fieldSize * 4) / 256) * 256;
}
