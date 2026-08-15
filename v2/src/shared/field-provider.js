/**
 * Renderer contract for a scalar field. Providers own their texture and view; frame()
 * advances content without changing either identity.
 */
export function assertFieldProvider(provider) {
  if (!provider?.texture || !provider?.view || !Number.isInteger(provider.size) || provider.size <= 0) {
    throw new TypeError('A field provider requires texture, view, and a positive integer size');
  }
  if (typeof provider.frame !== 'function') throw new TypeError('A field provider requires frame()');
  return provider;
}

export function createSyntheticFieldProvider(device, registry, {
  size = 512,
  label = 'synthetic-look-field',
} = {}) {
  if (!device?.queue) throw new TypeError('A GPUDevice is required');
  if (!registry?.createTexture) throw new TypeError('A GPU registry is required');

  const texture = registry.createTexture({
    label,
    size: [size, size, 1],
    format: 'r32float',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
  });
  const view = texture.createView({ label: `${label}-view` });
  const floatsPerRow = Math.ceil((size * 4) / 256) * 64;
  const upload = new Float32Array(floatsPerRow * size);
  let lastPaintedPhase = Number.NaN;

  function frame({ timeMs = 0, force = false } = {}) {
    const paintedPhase = Math.floor(timeMs / 250) / 16;
    if (!force && paintedPhase === lastPaintedPhase) return;
    paintSyntheticField(upload, size, floatsPerRow, paintedPhase);
    device.queue.writeTexture(
      { texture },
      upload,
      { bytesPerRow: floatsPerRow * 4, rowsPerImage: size },
      [size, size, 1],
    );
    lastPaintedPhase = paintedPhase;
  }

  const provider = {
    texture,
    view,
    size,
    frame,
    destroy() {
      registry.destroy(texture);
    },
  };
  frame({ force: true });
  return assertFieldProvider(provider);
}

export function syntheticFieldValue(uvX, uvY, phase = 0) {
  const wave = 0.5 + 0.5 * Math.sin((uvX * 5.1 + uvY * 2.7 + phase) * Math.PI * 2);
  const ringDistance = Math.abs(Math.hypot(uvX - 0.34, uvY - 0.48) - 0.22);
  const ring = 1 - smoothstep(0.018, 0.06, ringDistance);
  const paintedFront = smoothstep(-0.05, 0.05, uvX - 0.64 + 0.08 * Math.sin(uvY * 14 + phase));
  const noise = hash2d(Math.floor(uvX * 257), Math.floor(uvY * 257));
  return Math.min(1, Math.max(0, 0.06 + wave * 0.19 + ring * 0.58 + paintedFront * 0.42 + noise * 0.08));
}

function paintSyntheticField(target, size, floatsPerRow, phase) {
  for (let texelY = 0; texelY < size; texelY += 1) {
    for (let texelX = 0; texelX < size; texelX += 1) {
      target[texelY * floatsPerRow + texelX] = syntheticFieldValue(
        (texelX + 0.5) / size,
        (texelY + 0.5) / size,
        phase,
      );
    }
  }
}

function smoothstep(low, high, value) {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

function hash2d(x, y) {
  let value = Math.imul(x ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(y, 0xc2b2ae35);
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff;
}

