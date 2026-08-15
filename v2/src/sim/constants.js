import { SIMULATION_CONSTANTS } from '../shared/params.js';

export const AGENT_WORDS = 8;
export const AGENT_BYTES = AGENT_WORDS * 4;
export const AGENT_WORKGROUP_SIZE = 64;
export const FIELD_WORKGROUP_SIZE = 8;
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const FLAT_MANIFEST_ROOT_HASH = 'flat-torus-v1';
export const MAX_CAPACITY = 500_000;

// At the largest legacy crowd radius (8 texels at 1536), one max-reserve agent
// scatters at most 7 * 0.032 * (pi * 8^2 / 2) = 22.52. Co-locating 500k agents
// therefore stays below 2^32 at scale 256: 2.88e9. Resolution 1/256 is also
// slightly finer than the legacy density target's 8-bit quantization.
export const ATOMIC_FIXED_POINT_SCALE = 256;

export const {
  worldLinearScale: WORLD_LINEAR_SCALE,
  frameDtClamp: FRAME_DT_CLAMP,
  maxSimulationSteps: MAX_SIMULATION_STEPS,
  depositPointSizeWorld: DEPOSIT_POINT_SIZE_WORLD,
  densityMass: DENSITY_MASS,
  maxDensityReserveMass: MAX_DENSITY_RESERVE_MASS,
  defaultOatRadius: DEFAULT_OAT_RADIUS,
  maxOats: MAX_OATS,
  splatReferenceFieldSize: SPLAT_REFERENCE_FIELD_SIZE,
} = SIMULATION_CONSTANTS;

export const TAU = Math.PI * 2;
