import { withGpuErrorScope } from '../gpu/device.js';
import { GpuRegistry } from '../gpu/registry.js';
import { createParams } from '../shared/params.js';
import { createSimulationBindings } from './bindings.js';
import {
  AGENT_BYTES,
  AGENT_WORKGROUP_SIZE,
  DEFAULT_OAT_RADIUS,
  FLAT_MANIFEST_ROOT_HASH,
  MAX_CAPACITY,
  MAX_OATS,
} from './constants.js';
import {
  clonePopulationControllerState,
  createPopulationControllerState,
  restorePopulationControllerState,
  resetPopulationController,
  updatePopulationController,
} from './controller.js';
import { createSimulationLayouts } from './layouts.js';
import { packSimulationParams } from './params-layout.js';
import { encodeSimulationStep, encodeStateHash } from './pass-graph.js';
import { createSimulationPipelines } from './pipelines.js';
import { readAgentRecords, readScalarTexture } from './readback.js';
import { createSimulationResources, destroySimulationResources } from './resources.js';
import { buildSeedAgents, normalizeOats, packOats } from './seed.js';
import {
  assertSnapshotCompatibility,
  captureSimulationSnapshot,
  paddedFieldUpload,
} from './snapshot.js';
import { createSimulationTimebase } from './timebase.js';

/** Creates the M3 flat-torus simulation. No atlas or seam data enters this module. */
export async function createFlatTorusSimulation({
  device,
  registry: providedRegistry,
  fieldSize = 512,
  capacity = 262_144,
  seedCount = 60_000,
  randomSeed = 1,
  initialFood = 0,
  params: parameterOverrides = {},
  oats: initialOats,
  fixedTick = false,
  crowdFloat = false,
  manifestRootHash = FLAT_MANIFEST_ROOT_HASH,
  dev = true,
  onGpuError,
  onCompilationMessage,
} = {}) {
  validateDimensions(fieldSize, capacity, seedCount);
  if (!device?.queue) throw new TypeError('createFlatTorusSimulation requires a GPUDevice');
  const registry = providedRegistry ?? new GpuRegistry(device);
  const ownsRegistry = !providedRegistry;
  const resources = createSimulationResources(registry, { fieldSize, capacity });
  const layouts = createSimulationLayouts(device);
  const setup = await withGpuErrorScope(device, 'M3 simulation setup', async () => {
    const pipelines = await createSimulationPipelines(device, layouts, { onCompilationMessage });
    return { pipelines, bindings: createSimulationBindings(device, layouts, resources) };
  }, { enabled: dev, onError: onGpuError });
  if (setup.error) throw new Error(`M3 GPU setup failed: ${setup.error.message}`);
  const { pipelines, bindings } = setup.value;

  const rawParams = createParams(parameterOverrides);
  let oatDirty = true;
  const params = new Proxy(rawParams, {
    set(target, name, value) {
      if (name === 'oatPower') oatDirty = true;
      target[name] = value;
      return true;
    },
  });
  let oats = normalizeOats(initialOats ?? [{
    uvPos: [0.5, 0.5], radiusUv: DEFAULT_OAT_RADIUS, peakFood: params.oatPower,
  }], params.oatPower);
  if (oats.length > MAX_OATS) throw new RangeError(`At most ${MAX_OATS} oats are supported`);
  let agentParity = 0;
  let densityIndex = 0;
  let stepIndex = 0;
  let currentSeedCount = seedCount;
  let currentRandomSeed = randomSeed >>> 0;
  let handOutCursor = 0;
  let destroyed = false;
  let controllerState = createPopulationControllerState(params);
  const timebase = createSimulationTimebase({ fixedTick });
  const compatibility = { manifestRootHash, fieldSize, capacity };
  const zeroField = new Float32Array(fieldSize * fieldSize);
  let countReadPromise = null;
  let hashReadPromise = null;

  uploadOats();
  resetSeedState(seedCount, currentRandomSeed, initialFood);
  uploadParameters(1);

  function step(dt = 1, { capacityDispatch = false } = {}) {
    requireLive();
    const kernel = uploadParameters(dt);
    const encoder = device.createCommandEncoder({ label: `sim-step-${stepIndex}` });
    const encoded = encodeSimulationStep(encoder, pipelines, bindings, resources, {
      agentParity,
      blurIterations: kernel.blurIterations,
      oatDirty,
      capacityDispatch,
    });
    device.queue.submit([encoder.finish()]);
    agentParity = encoded.nextParity;
    densityIndex = encoded.densityIndex;
    oatDirty = false;
    stepIndex = (stepIndex + 1) >>> 0;
  }

  function advance(elapsedMs) {
    const dts = timebase.frame(elapsedMs, params.simulationSteps);
    for (const dt of dts) step(dt);
    return dts.length;
  }

  async function count() {
    requireLive();
    if (countReadPromise) return countReadPromise;
    countReadPromise = (async () => {
      const encoder = device.createCommandEncoder({ label: 'sim-count-copy-encoder' });
      encoder.copyBufferToBuffer(resources.countBuffers[agentParity], 0, resources.countReadback, 0, 4);
      device.queue.submit([encoder.finish()]);
      await resources.countReadback.mapAsync(GPUMapMode.READ);
      try {
        return new Uint32Array(resources.countReadback.getMappedRange())[0];
      } finally {
        resources.countReadback.unmap();
      }
    })().finally(() => { countReadPromise = null; });
    return countReadPromise;
  }

  async function inspectState() {
    requireLive();
    if (hashReadPromise) return hashReadPromise;
    hashReadPromise = (async () => {
      const encoder = device.createCommandEncoder({ label: 'sim-state-hash-encoder' });
      encodeStateHash(encoder, pipelines, bindings, resources, agentParity);
      encoder.copyBufferToBuffer(resources.stateHash, 0, resources.hashReadback, 0, 32);
      device.queue.submit([encoder.finish()]);
      await resources.hashReadback.mapAsync(GPUMapMode.READ);
      let words;
      try {
        words = new Uint32Array(resources.hashReadback.getMappedRange().slice(0));
      } finally {
        resources.hashReadback.unmap();
      }
      const population = await count();
      return {
        value: `${hex(words[0])}-${hex(words[1])}-${hex(words[2])}-${hex(words[3])}-${hex(population)}`,
        nonFinite: words[4],
        population,
        stepIndex,
      };
    })().finally(() => { hashReadPromise = null; });
    return hashReadPromise;
  }

  async function allocatorDiagnostics() {
    const encoder = device.createCommandEncoder({ label: 'sim-allocator-debug-copy' });
    encoder.copyBufferToBuffer(resources.allocatorDebug, 0, resources.allocatorReadback, 0, 16);
    device.queue.submit([encoder.finish()]);
    await resources.allocatorReadback.mapAsync(GPUMapMode.READ);
    try {
      const words = new Uint32Array(resources.allocatorReadback.getMappedRange());
      return { ownershipViolations: words[0], admittedChildren: words[1], rejectedChildren: words[2] };
    } finally {
      resources.allocatorReadback.unmap();
    }
  }

  async function readAgents(limit = capacity) {
    const population = await count();
    const readCount = Math.min(population, Math.max(0, Math.floor(limit)));
    return readAgentRecords({
      device, registry, buffer: resources.agentBuffers[agentParity], count: readCount,
    });
  }

  async function debugReplaceState({ agents = [], field = zeroField, nextStepIndex = 0 } = {}) {
    if (agents.length > capacity) throw new RangeError('Debug agent set exceeds capacity');
    const agentData = new ArrayBuffer(agents.length * AGENT_BYTES);
    const floats = new Float32Array(agentData);
    const uints = new Uint32Array(agentData);
    for (let index = 0; index < agents.length; index += 1) {
      const agent = agents[index];
      const base = index * 8;
      floats.set([agent.uvPos[0], agent.uvPos[1], agent.heading, agent.reserve], base);
      uints.set([agent.idLo >>> 0, agent.idHi >>> 0, agent.flags >>> 0, 0], base + 4);
    }
    const scalarField = field instanceof Float32Array ? field : Float32Array.from(field);
    const { upload, rowBytes } = paddedFieldUpload(scalarField, fieldSize);
    clearMutableBuffers();
    if (agentData.byteLength > 0) device.queue.writeBuffer(resources.agentBuffers[0], 0, agentData);
    writePopulationArgs(agents.length);
    device.queue.writeTexture(
      { texture: resources.dynamicFields[0] }, upload,
      { bytesPerRow: rowBytes, rowsPerImage: fieldSize }, [fieldSize, fieldSize, 1],
    );
    device.queue.writeTexture(
      { texture: resources.dynamicFields[1] }, zeroField,
      { bytesPerRow: fieldSize * 4, rowsPerImage: fieldSize }, [fieldSize, fieldSize, 1],
    );
    agentParity = 0;
    densityIndex = 0;
    stepIndex = nextStepIndex >>> 0;
    oatDirty = true;
    uploadParameters(1);
    await device.queue.onSubmittedWorkDone();
  }

  async function snapshot() {
    const population = await count();
    return captureSimulationSnapshot({
      device, registry, resources, agentParity, count: population, compatibility,
      metadata: {
        stepIndex,
        controllerState,
        params,
        oats,
        handOutCursor,
        randomSeed: currentRandomSeed,
        seedCount: currentSeedCount,
        timebase: timebase.snapshot(),
      },
    });
  }

  async function restore(snapshotState) {
    assertSnapshotCompatibility(snapshotState, compatibility);
    const metadata = snapshotState.metadata;
    const restoredParams = createParams(metadata.params);
    const restoredOats = normalizeOats(metadata.oats, restoredParams.oatPower);
    const agentWords = snapshotState.agents instanceof Uint32Array
      ? snapshotState.agents
      : Uint32Array.from(snapshotState.agents);
    const population = agentWords.length / 8;
    if (!Number.isInteger(population) || population > capacity) throw new RangeError('Snapshot agent payload is invalid');
    const field = snapshotState.field instanceof Float32Array
      ? snapshotState.field
      : Float32Array.from(snapshotState.field);
    const { upload, rowBytes } = paddedFieldUpload(field, fieldSize);
    clearMutableBuffers();
    if (agentWords.length > 0) device.queue.writeBuffer(resources.agentBuffers[0], 0, agentWords);
    writePopulationArgs(population);
    device.queue.writeTexture(
      { texture: resources.dynamicFields[0] }, upload,
      { bytesPerRow: rowBytes, rowsPerImage: fieldSize }, [fieldSize, fieldSize, 1],
    );
    device.queue.writeTexture(
      { texture: resources.dynamicFields[1] }, zeroField,
      { bytesPerRow: fieldSize * 4, rowsPerImage: fieldSize }, [fieldSize, fieldSize, 1],
    );
    Object.assign(params, restoredParams);
    oats = restoredOats;
    uploadOats();
    controllerState = restorePopulationControllerState(metadata.controllerState);
    timebase.restore(metadata.timebase);
    stepIndex = metadata.stepIndex >>> 0;
    handOutCursor = metadata.handOutCursor >>> 0;
    currentRandomSeed = metadata.randomSeed >>> 0;
    currentSeedCount = metadata.seedCount >>> 0;
    agentParity = 0;
    densityIndex = 0;
    oatDirty = true;
    uploadParameters(1);
    await device.queue.onSubmittedWorkDone();
  }

  function seed(nextSeedCount = currentSeedCount, nextRandomSeed = currentRandomSeed) {
    validateDimensions(fieldSize, capacity, nextSeedCount);
    currentSeedCount = nextSeedCount;
    currentRandomSeed = nextRandomSeed >>> 0;
    resetSeedState(currentSeedCount, currentRandomSeed, initialFood);
    resetPopulationController(params, controllerState);
  }

  function setOats(nextOats) {
    const normalized = normalizeOats(nextOats, params.oatPower);
    if (normalized.length > MAX_OATS) throw new RangeError(`At most ${MAX_OATS} oats are supported`);
    oats = normalized;
    uploadOats();
    oatDirty = true;
  }

  async function samplePopulation(now, { force = false } = {}) {
    const visibleAgents = await count();
    return updatePopulationController(params, controllerState, { now, visibleAgents, force });
  }

  function uploadParameters(dt) {
    const packed = packSimulationParams(params, runtimeParams(dt));
    device.queue.writeBuffer(resources.parameters, 0, packed.buffer);
    return packed.kernel;
  }

  function runtimeParams(dt) {
    return {
      fieldSize, capacity, stepIndex, dt, oatCount: oats.length, crowdFloat,
      repel: { active: false },
    };
  }

  function uploadOats() {
    device.queue.writeBuffer(resources.oats, 0, packOats(oats, MAX_OATS));
  }

  function resetSeedState(nextCount, nextRandomSeed, foodValue) {
    clearMutableBuffers();
    const agents = buildSeedAgents({ count: nextCount, randomSeed: nextRandomSeed, params, oats });
    if (agents.byteLength > 0) device.queue.writeBuffer(resources.agentBuffers[0], 0, agents);
    writePopulationArgs(nextCount);
    const field = new Float32Array(fieldSize * fieldSize).fill(foodValue);
    for (const texture of [...resources.dynamicFields, ...resources.crowdFields, resources.oatField]) {
      device.queue.writeTexture(
        { texture }, texture === resources.dynamicFields[0] || texture === resources.dynamicFields[1] ? field : zeroField,
        { bytesPerRow: fieldSize * 4, rowsPerImage: fieldSize }, [fieldSize, fieldSize, 1],
      );
    }
    agentParity = 0;
    densityIndex = 0;
    stepIndex = 0;
    oatDirty = true;
  }

  function clearMutableBuffers() {
    const encoder = device.createCommandEncoder({ label: 'sim-reset-clear-encoder' });
    for (const buffer of [
      ...resources.agentBuffers, ...resources.countBuffers, resources.crowdAtomic,
      resources.exposureAtomic, resources.survivorCount, resources.allocatorDebug,
      resources.childOwnership, resources.stateHash,
    ]) encoder.clearBuffer(buffer);
    device.queue.submit([encoder.finish()]);
  }

  function writePopulationArgs(population) {
    device.queue.writeBuffer(resources.countBuffers[0], 0, new Uint32Array([population]));
    device.queue.writeBuffer(resources.countBuffers[1], 0, new Uint32Array([0]));
    device.queue.writeBuffer(resources.dispatchArgs, 0, new Uint32Array([
      Math.ceil(population / AGENT_WORKGROUP_SIZE), 1, 1,
    ]));
    device.queue.writeBuffer(resources.renderArgs, 0, new Uint32Array([population, 1, 0, 0]));
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    destroySimulationResources(registry, resources);
  }

  function requireLive() {
    if (destroyed) throw new Error('Simulation has been destroyed');
  }

  return {
    device,
    registry,
    ownsRegistry,
    fieldSize,
    capacity,
    params,
    step,
    advance,
    seed,
    count,
    hashState: async () => (await inspectState()).value,
    inspectState,
    scanFinite: async () => (await inspectState()).nonFinite,
    snapshot,
    restore,
    setOats,
    clearOats: () => setOats([]),
    oats: () => oats.map((oat) => ({ ...oat, uvPos: [...oat.uvPos] })),
    samplePopulation,
    controllerState: () => clonePopulationControllerState(controllerState),
    allocatorDiagnostics,
    readAgents,
    readField: () => readScalarTexture({ device, registry, texture: resources.dynamicFields[0], fieldSize }),
    readDensityField: () => readScalarTexture({ device, registry, texture: resources.crowdFields[densityIndex], fieldSize }),
    readOatField: () => readScalarTexture({ device, registry, texture: resources.oatField, fieldSize }),
    debugReplaceState,
    currentAgentBuffer: () => resources.agentBuffers[agentParity],
    allAgentBuffers: () => [...resources.agentBuffers],
    currentCountBuffer: () => resources.countBuffers[agentParity],
    currentFieldTexture: () => resources.dynamicFields[0],
    currentFieldView: () => resources.dynamicFieldViews[0],
    currentDensityView: () => resources.crowdFieldViews[densityIndex],
    renderIndirectBuffer: resources.renderArgs,
    fieldProvider: { texture: resources.dynamicFields[0], view: resources.dynamicFieldViews[0], size: fieldSize, frame() {} },
    handOutCursor: (next) => {
      if (next !== undefined) handOutCursor = Math.max(0, next >>> 0);
      return handOutCursor;
    },
    destroy,
  };
}

function validateDimensions(fieldSize, capacity, seedCount) {
  if (!Number.isInteger(fieldSize) || fieldSize < 8 || fieldSize > 4096) throw new RangeError('fieldSize must be an integer from 8 through 4096');
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) throw new RangeError(`capacity must be an integer from 1 through ${MAX_CAPACITY}`);
  if (!Number.isInteger(seedCount) || seedCount < 0 || seedCount > capacity) throw new RangeError('seedCount must be an integer within capacity');
}

function hex(value) {
  return (value >>> 0).toString(16).padStart(8, '0');
}
