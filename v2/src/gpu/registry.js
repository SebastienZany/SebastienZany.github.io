const BYTES_PER_TEXEL = Object.freeze({
  r8unorm: 1,
  r16float: 2,
  r32float: 4,
  r32uint: 4,
  rg16float: 4,
  rg32float: 8,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  // Preferred canvas formats on macOS (first registered by F2's swapchain-format target).
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  rgba16float: 8,
  rgba32float: 16,
  depth24plus: 4,
  depth32float: 4,
});

export class GpuRegistry {
  #device;
  #records = new Map();

  constructor(device) {
    if (!device?.createBuffer || !device?.createTexture) throw new TypeError('GpuRegistry requires a GPUDevice');
    this.#device = device;
  }

  createBuffer(descriptor) {
    requireLabel(descriptor?.label, 'buffer');
    const resource = this.#device.createBuffer(descriptor);
    this.#records.set(resource, Object.freeze({
      kind: 'buffer',
      label: descriptor.label,
      bytes: descriptor.size,
      details: { size: descriptor.size, usage: descriptor.usage },
    }));
    return resource;
  }

  createTexture(descriptor) {
    requireLabel(descriptor?.label, 'texture');
    const resource = this.#device.createTexture(descriptor);
    const extent = normalizeExtent(descriptor.size);
    this.#records.set(resource, Object.freeze({
      kind: 'texture',
      label: descriptor.label,
      bytes: calculateTextureBytes(descriptor),
      details: {
        size: extent,
        format: descriptor.format,
        mipLevelCount: descriptor.mipLevelCount || 1,
        sampleCount: descriptor.sampleCount || 1,
      },
    }));
    return resource;
  }

  destroy(resource) {
    const known = this.#records.delete(resource);
    if (known) resource.destroy();
    return known;
  }

  totalBytes() {
    let total = 0;
    for (const record of this.#records.values()) total += record.bytes;
    return total;
  }

  dump() {
    return [...this.#records.values()]
      .map((record) => ({ ...record, details: { ...record.details } }))
      .sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label));
  }
}

export function calculateTextureBytes(descriptor) {
  const bytesPerTexel = BYTES_PER_TEXEL[descriptor.format];
  if (!bytesPerTexel) throw new Error(`Byte accounting is undefined for texture format ${descriptor.format}`);
  const { width, height, depthOrArrayLayers } = normalizeExtent(descriptor.size);
  const mipLevelCount = descriptor.mipLevelCount || 1;
  const sampleCount = descriptor.sampleCount || 1;
  const shrinksInDepth = descriptor.dimension === '3d';
  let texelCount = 0;
  for (let level = 0; level < mipLevelCount; level += 1) {
    texelCount += Math.max(1, width >> level)
      * Math.max(1, height >> level)
      * (shrinksInDepth ? Math.max(1, depthOrArrayLayers >> level) : depthOrArrayLayers);
  }
  return texelCount * bytesPerTexel * sampleCount;
}

function normalizeExtent(size) {
  if (typeof size === 'number') return { width: size, height: 1, depthOrArrayLayers: 1 };
  if (Array.isArray(size)) {
    return { width: size[0], height: size[1] || 1, depthOrArrayLayers: size[2] || 1 };
  }
  return {
    width: size.width,
    height: size.height || 1,
    depthOrArrayLayers: size.depthOrArrayLayers || 1,
  };
}

function requireLabel(label, kind) {
  if (typeof label !== 'string' || label.trim() === '') throw new Error(`Every GPU ${kind} requires a label`);
}
