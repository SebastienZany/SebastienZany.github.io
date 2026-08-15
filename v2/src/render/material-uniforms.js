import { selectIcosaLightVariant } from './light-rig.js';

export const MATERIAL_UNIFORM_BYTES = 9 * 16;
export const MAX_BUMP_TAP_RADIUS_TEXELS = 2.33; // PLAN §1 display footprint contract.

export function createMaterialUniformWriter({ device, registry, fieldSize, lut }) {
  const buffer = registry.createBuffer({
    label: 'look-material-uniforms',
    size: MATERIAL_UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const values = new Float32Array(MATERIAL_UNIFORM_BYTES / 4);

  function write(params) {
    values.fill(0);
    const normalRadiusTexels = Math.min(
      MAX_BUMP_TAP_RADIUS_TEXELS,
      1 + params.spatialSmoothing * 0.65, // main.js:285-286,673-675
    );
    values.set([1 / fieldSize, 1 / fieldSize, normalRadiusTexels, params.foodClamp], 0);
    values.set([
      params.surfaceHeight,
      params.surfaceBump,
      params.iridescenceStrength,
      params.filmThicknessCurve,
    ], 4);
    values.set([
      params.iridescenceMinThickness,
      params.iridescenceThickness,
      params.lightBrightness,
      0,
    ], 8);
    writeLinearColour(values, 12, params.slimeBaseColor);
    values.set([
      params.goldBodyFade,
      params.goldBodyRoughness,
      params.goldBodyReflectivity,
      0,
    ], 16);
    writeLinearColour(values, 20, params.goldBodyColor);
    values.set([
      Number(params.filmFollowsSlimeHeight),
      Number(params.useGoldWaferFilm),
      Number(params.useGoldWaferBody),
      Number(params.smoothFieldDisplay),
    ], 24);
    values.set([lut.minThicknessNm, lut.thicknessSpanNm, lut.cosMin, lut.cosSpan], 28);
    const lightVariant = selectIcosaLightVariant(params.useIcosaFaceLights);
    values.set([
      lightVariant.activeCount,
      lightVariant.radianceScale,
      Number(params.performanceMode === 'quality'), // main.js:301-314
      0,
    ], 32);
    device.queue.writeBuffer(buffer, 0, values);
  }

  return { buffer, values, write };
}

function writeLinearColour(target, offset, hex) {
  const encoded = Number.parseInt(hex.slice(1), 16);
  target[offset] = srgbToLinear(((encoded >> 16) & 0xff) / 255);
  target[offset + 1] = srgbToLinear(((encoded >> 8) & 0xff) / 255);
  target[offset + 2] = srgbToLinear((encoded & 0xff) / 255);
  target[offset + 3] = 1;
}

function srgbToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
