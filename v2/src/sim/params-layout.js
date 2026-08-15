import {
  CROWD_FIXED_POINT_SCALE,
  DENSITY_MASS,
  EXPOSURE_FIXED_POINT_SCALE,
  MAX_DENSITY_RESERVE_MASS,
  SPLAT_REFERENCE_FIELD_SIZE,
  WORLD_LINEAR_SCALE,
} from './constants.js';

export const PARAM_SLOT = Object.freeze({
  frame: 0,
  sensing: 1,
  movement: 2,
  reproduction: 3,
  economy: 4,
  crowd: 5,
  field: 6,
  oat: 7,
  crowdKernel: 8,
  repel: 9,
  oatMeta: 10,
  fixedPoint: 11,
});
export const PARAM_SLOT_COUNT = Object.keys(PARAM_SLOT).length;
export const PARAM_BUFFER_BYTES = PARAM_SLOT_COUNT * 16;

export const PARAM_FLAGS = Object.freeze({
  oatRationing: 1 << 0,
  crowdFloat: 1 << 1,
  repelActive: 1 << 2,
});

// Table order is the shared JS/WGSL ABI. WGSL receives the slot numbers through
// the M0 preprocessor rather than maintaining a second numeric declaration.
export const PARAM_PACKING_TABLE = Object.freeze([
  ['frame', ['fieldSize:u32', 'capacity:u32', 'stepIndex:u32', 'flags:u32']],
  ['sensing', ['dt', 'sensorDistance', 'sensorAngle', 'turnAngle']],
  ['movement', ['wander', 'stepSize', 'minMoveScale', 'reproThreshold']],
  ['reproduction', ['reproAngle', 'childStep', 'maxReserve', 'childJitter']],
  ['economy', ['uptakeRate', 'depositRate', 'burnRate', 'foodWeight']],
  ['crowd', ['crowdWeight', 'crowdExponent', 'densityTarget', 'densityBlur']],
  ['field', ['fieldDiffusion', 'fieldDecay', 'deltaScale', 'foodClamp']],
  ['oat', ['oatSupplyRate', 'densityMass', 'exposureCap', 'reserved']],
  ['crowdKernel', ['pointSizeTexels', 'radiusTexels', 'kernelMass', 'blurAlpha']],
  ['repel', ['repelUvX', 'repelUvY', 'repelRadius', 'repelStrength']],
  ['oatMeta', ['oatCount:u32', 'blurIterations:u32', 'reserved:u32', 'reserved:u32']],
  ['fixedPoint', ['crowdScale', 'exposureScale', 'reserved', 'reserved']],
]);

export function crowdKernelSettings(densityBlur, fieldSize) {
  const pointSizeTexels = Math.max(1,
    (densityBlur / WORLD_LINEAR_SCALE) * (fieldSize / SPLAT_REFERENCE_FIELD_SIZE)); // main.js:769–773
  if (pointSizeTexels <= 1) {
    return { pointSizeTexels, radiusTexels: 0.5, kernelMass: 1, blurIterations: 0, blurAlpha: 0 };
  }
  const radiusTexels = pointSizeTexels * 0.5;
  const variancePerAxis = 0.15 * radiusTexels * radiusTexels;
  const blurIterations = Math.max(1, Math.ceil(variancePerAxis / 0.5));
  const blurAlpha = variancePerAxis / (0.5 * blurIterations);
  return {
    pointSizeTexels,
    radiusTexels,
    kernelMass: Math.PI * radiusTexels * radiusTexels * 0.5,
    blurIterations,
    blurAlpha,
  };
}

export function packSimulationParams(params, runtime) {
  const buffer = new ArrayBuffer(PARAM_BUFFER_BYTES);
  const floats = new Float32Array(buffer);
  const uints = new Uint32Array(buffer);
  const kernel = crowdKernelSettings(params.densityBlur, runtime.fieldSize);
  const flags = (params.useOatRationing ? PARAM_FLAGS.oatRationing : 0)
    | (runtime.crowdFloat ? PARAM_FLAGS.crowdFloat : 0)
    | (runtime.repel?.active ? PARAM_FLAGS.repelActive : 0);

  writeU32(uints, 'frame', [runtime.fieldSize, runtime.capacity, runtime.stepIndex, flags]);
  writeF32(floats, 'sensing', [runtime.dt, params.sensorDistance, params.sensorAngle, params.turnAngle]);
  writeF32(floats, 'movement', [params.wander, params.stepSize, params.minMoveScale, params.reproThreshold]);
  writeF32(floats, 'reproduction', [params.reproAngle, params.childStep, params.maxReserve, 0.18]); // main.js:3228
  writeF32(floats, 'economy', [params.uptakeRate, params.depositRate, params.burnRate, params.foodWeight]);
  writeF32(floats, 'crowd', [params.crowdWeight, params.crowdExponent, params.densityTarget, params.densityBlur]);
  writeF32(floats, 'field', [params.fieldDiffusion, params.fieldDecay, params.deltaScale, params.foodClamp]);
  writeF32(floats, 'oat', [params.oatSupplyRate, DENSITY_MASS, MAX_DENSITY_RESERVE_MASS, 0]);
  writeF32(floats, 'crowdKernel', [kernel.pointSizeTexels, kernel.radiusTexels, kernel.kernelMass, kernel.blurAlpha]);
  writeF32(floats, 'repel', [runtime.repel?.uvX ?? 0, runtime.repel?.uvY ?? 0, runtime.repel?.radius ?? 0, runtime.repel?.strength ?? 0]);
  writeU32(uints, 'oatMeta', [runtime.oatCount, kernel.blurIterations, 0, 0]);
  writeF32(floats, 'fixedPoint', [CROWD_FIXED_POINT_SCALE, EXPOSURE_FIXED_POINT_SCALE, 0, 0]);
  return { buffer, kernel, flags };
}

export function unpackSimulationParams(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== PARAM_BUFFER_BYTES) {
    throw new TypeError(`Expected a ${PARAM_BUFFER_BYTES}-byte parameter buffer`);
  }
  const floats = new Float32Array(buffer);
  const uints = new Uint32Array(buffer);
  return Object.fromEntries(PARAM_PACKING_TABLE.map(([slotName, fields]) => {
    const base = PARAM_SLOT[slotName] * 4;
    return [slotName, Object.fromEntries(fields.map((field, lane) => {
      const isUint = field.endsWith(':u32');
      return [field.replace(':u32', ''), isUint ? uints[base + lane] : floats[base + lane]];
    }))];
  }));
}

export const PARAM_WGSL_CONSTANTS = Object.freeze({
  PARAM_SLOT_COUNT,
  PARAM_SLOT_FRAME: PARAM_SLOT.frame,
  PARAM_SLOT_SENSING: PARAM_SLOT.sensing,
  PARAM_SLOT_MOVEMENT: PARAM_SLOT.movement,
  PARAM_SLOT_REPRODUCTION: PARAM_SLOT.reproduction,
  PARAM_SLOT_ECONOMY: PARAM_SLOT.economy,
  PARAM_SLOT_CROWD: PARAM_SLOT.crowd,
  PARAM_SLOT_FIELD: PARAM_SLOT.field,
  PARAM_SLOT_OAT: PARAM_SLOT.oat,
  PARAM_SLOT_CROWD_KERNEL: PARAM_SLOT.crowdKernel,
  PARAM_SLOT_REPEL: PARAM_SLOT.repel,
  PARAM_SLOT_OAT_META: PARAM_SLOT.oatMeta,
  PARAM_SLOT_FIXED_POINT: PARAM_SLOT.fixedPoint,
  PARAM_FLAG_OAT_RATIONING: PARAM_FLAGS.oatRationing,
  PARAM_FLAG_CROWD_FLOAT: PARAM_FLAGS.crowdFloat,
  PARAM_FLAG_REPEL_ACTIVE: PARAM_FLAGS.repelActive,
});

function writeF32(target, slotName, values) {
  target.set(values, PARAM_SLOT[slotName] * 4);
}

function writeU32(target, slotName, values) {
  target.set(values.map((value) => value >>> 0), PARAM_SLOT[slotName] * 4);
}
