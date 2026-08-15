import { MAX_KERNEL_FOOTPRINT } from '../src/shared/params.js';

// One direct sample may reach the declared radius and bilinear may consume the next texel.
export const DESKTOP_GUTTER_TEXELS = Math.max(
  ...Object.values(MAX_KERNEL_FOOTPRINT).map((kernel) => kernel.requiredGutterTexels),
);
export const MOBILE_GUTTER_TEXELS = 3;
export const MIN_CHART_TEXELS = 4;
export const MAX_FRAME_LIST_LENGTH = 4;
export const MAX_PACKING_DEMAND = 0.85;
export const MAX_SECTION_BYTES = 95 * 1024 * 1024;
export const ATLAS_SCHEMA_VERSION = 2;
export const GUTTER_RECORD_OFFSET = 2 ** 16;
export const WEIGHT_QUANTIZATION_SUM = 65_535;
export const BLOCK_TEXELS = 32;

export const DEFAULT_ATLAS_TARGETS = Object.freeze([
  Object.freeze({
    fieldSize: 1536,
    gutterTexels: DESKTOP_GUTTER_TEXELS,
    directTapClampTexels: DESKTOP_GUTTER_TEXELS - 1,
    // Post-split conservative demand is 98.12% at s=1. The explicit s=.9 lever measures
    // 84.18% and changes regular-chart world texel width by 11.1%, inside M2's ~15% gate.
    densityScale: 0.9,
    role: 'desktop',
  }),
  Object.freeze({
    fieldSize: 1024,
    gutterTexels: MOBILE_GUTTER_TEXELS,
    directTapClampTexels: MOBILE_GUTTER_TEXELS - 1,
    // Post-split conservative demand is 92.88% at s=.9. The measured s=.83 lever packs at
    // 83.43%, satisfying the preset <=85% combined-lever policy without moving to 1280.
    densityScale: 0.83,
    role: 'mobile',
  }),
]);

export function atlasTarget(fieldSize, overrides = {}) {
  const baseline = DEFAULT_ATLAS_TARGETS.find((target) => target.fieldSize === fieldSize);
  if (!baseline) throw new RangeError(`atlas: unsupported target ${fieldSize}`);
  const target = { ...baseline, ...overrides, fieldSize };
  if (!Number.isInteger(target.gutterTexels) || target.gutterTexels < 1) {
    throw new RangeError('atlas: gutter must be a positive integer');
  }
  if (!(target.densityScale > 0 && target.densityScale <= 1)) {
    throw new RangeError('atlas: density scale must be in (0, 1]');
  }
  return target;
}
