export function quantizeFloat16(values) {
  const encoded = new Uint16Array(values.length);
  for (let index = 0; index < values.length; index += 1) encoded[index] = float32ToFloat16(values[index]);
  return encoded;
}

export function measureFloat16WorldError(worldPos, ownership, smallestKernelWorld) {
  let worstPositionError = 0;
  let worstTexelIndex = 0;
  for (let texelIndex = 0; texelIndex < ownership.length; texelIndex += 1) {
    if (!ownership[texelIndex]) continue;
    let squaredError = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = worldPos[texelIndex * 3 + axis];
      const restored = float16ToFloat32(float32ToFloat16(value));
      squaredError += (restored - value) ** 2;
    }
    const error = Math.sqrt(squaredError);
    if (error > worstPositionError) { worstPositionError = error; worstTexelIndex = texelIndex; }
  }
  const threshold = smallestKernelWorld / 8;
  return {
    worstPositionError,
    worstTexelIndex,
    smallestKernelWorld,
    threshold,
    storage: worstPositionError < threshold ? 'f16' : 'f32',
  };
}

export function float32ToFloat16(value) {
  FLOAT32_VIEW[0] = value;
  const bits = UINT32_VIEW[0];
  const sign = (bits >>> 16) & 0x8000;
  let exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | (mantissa ? 0x7e00 : 0x7c00);
  exponent -= 127;
  if (exponent > 15) return sign | 0x7c00;
  if (exponent < -14) {
    if (exponent < -24) return sign;
    mantissa = (mantissa | 0x800000) >>> (-exponent - 14);
    return sign | ((mantissa + 0x1000) >>> 13);
  }
  const rounded = mantissa + 0x1000;
  if (rounded & 0x800000) {
    exponent += 1;
    mantissa = 0;
    if (exponent > 15) return sign | 0x7c00;
  } else mantissa = rounded;
  return sign | ((exponent + 15) << 10) | ((mantissa >>> 13) & 0x3ff);
}

export function float16ToFloat32(value) {
  const sign = (value & 0x8000) << 16;
  let exponent = (value >>> 10) & 0x1f;
  let mantissa = value & 0x3ff;
  let bits;
  if (exponent === 0) {
    if (mantissa === 0) bits = sign;
    else {
      exponent = -14;
      while ((mantissa & 0x400) === 0) { mantissa <<= 1; exponent -= 1; }
      mantissa &= 0x3ff;
      bits = sign | ((exponent + 127) << 23) | (mantissa << 13);
    }
  } else if (exponent === 0x1f) bits = sign | 0x7f800000 | (mantissa << 13);
  else bits = sign | ((exponent - 15 + 127) << 23) | (mantissa << 13);
  UINT32_VIEW[0] = bits >>> 0;
  return FLOAT32_VIEW[0];
}

const CONVERSION_BUFFER = new ArrayBuffer(4);
const FLOAT32_VIEW = new Float32Array(CONVERSION_BUFFER);
const UINT32_VIEW = new Uint32Array(CONVERSION_BUFFER);
