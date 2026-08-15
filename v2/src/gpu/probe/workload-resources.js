const GUTTER_FRACTION_BY_SIZE = Object.freeze({ 1024: 0.47, 1536: 0.30 });

/** Allocates the itemized PLAN §2 resource set; contents are synthetic but dimensions/formats are real. */
export function createWorkloadResources(device, registry, size, formatCapabilities) {
  const textureCount = size * size;
  const agentCount = (size / 2) ** 2;
  const gutterFraction = GUTTER_FRACTION_BY_SIZE[size];
  if (!gutterFraction) throw new RangeError(`No measured gutter fraction is recorded for ${size}`);

  const all = [];
  const texture = (descriptor) => {
    const value = registry.createTexture(descriptor);
    all.push(value);
    return value;
  };
  const buffer = (descriptor) => {
    const value = registry.createBuffer(descriptor);
    all.push(value);
    return value;
  };
  const scalarUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;

  try {
    const fields = Object.fromEntries(['food', 'oat', 'density'].map((name) => [name, [0, 1].map((parity) => texture({
      label: `workload-${name}-${parity}`,
      size: [size, size],
      format: 'r32float',
      usage: scalarUsage,
    }))]));
    const scatterBuffers = ['deposit', 'exposure'].map((name) => buffer({
      label: `workload-${name}-fixed-point`,
      size: textureCount * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }));
    const agents = [0, 1].map((parity) => buffer({
      label: `workload-agents-${parity}`,
      size: agentCount * 32,
      usage: GPUBufferUsage.STORAGE,
    }));
    const worldMaps = ['world-position', 'tangent-frame'].map((name) => texture({
      label: `workload-${name}`,
      size: [size, size],
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    }));
    const ownershipMaps = ['ownership', 'boundary-index'].map((name) => texture({
      label: `workload-${name}`,
      size: [size, size],
      format: 'r32uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    }));
    const displayHistory = texture({
      label: 'workload-display-history-r32float',
      size: [size, size],
      format: 'r32float',
      usage: scalarUsage,
    });
    const displayFormat = formatCapabilities.r16RenderAndFilter ? 'r16float' : 'rgba16float';
    if (displayFormat === 'rgba16float' && !formatCapabilities.rgba16Storage) {
      throw new Error('Neither r16float render/filter nor rgba16float storage is available for display sample views');
    }
    const displayUsage = displayFormat === 'r16float'
      ? GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      : GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    const displayViews = [0, 1].map((parity) => texture({
      label: `workload-display-sample-${parity}`,
      size: [size, size],
      format: displayFormat,
      usage: displayUsage,
    }));
    const maxFoodHistory = texture({
      label: 'workload-max-food-history',
      size: [size, size],
      format: 'r16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const fallbackStaging = texture({
      label: 'workload-gutter-fallback-staging',
      size: [size, size],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const gutterRecordCount = Math.floor(textureCount * gutterFraction);
    const donorRecords = buffer({
      label: 'workload-structure-valid-donor-stencils',
      size: gutterRecordCount * 28,
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    });
    writeStructureValidDonorRecords(donorRecords.getMappedRange(), textureCount, gutterRecordCount);
    donorRecords.unmap();
    const fixedBuffers = [
      ['mesh-geometry', 15_000_000],
      ['seam-frames-and-corners', 6_000_000],
      ['miscellaneous', 2_000_000],
    ].map(([name, byteSize]) => buffer({
      label: `workload-${name}`,
      size: byteSize,
      usage: GPUBufferUsage.STORAGE,
    }));
    const lut = texture({
      label: 'workload-gold-lut',
      size: [600, 256],
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    return {
      all,
      size,
      textureCount,
      agentCount,
      gutterFraction,
      gutterRecordCount,
      authoritativeTexelCount: textureCount - gutterRecordCount,
      fields,
      scatterBuffers,
      agents,
      worldMaps,
      ownershipMaps,
      displayHistory,
      displayViews,
      displayFormat,
      maxFoodHistory,
      fallbackStaging,
      donorRecords,
      fixedBuffers,
      lut,
    };
  } catch (error) {
    all.reverse().forEach((resource) => registry.destroy(resource));
    throw error;
  }
}

export function destroyWorkloadResources(registry, resources) {
  resources?.all.slice().reverse().forEach((resource) => registry.destroy(resource));
}

function writeStructureValidDonorRecords(mappedRange, textureCount, recordCount) {
  const values = new Uint32Array(mappedRange);
  const authoritativeTexelCount = textureCount - recordCount;
  let randomState = 0x17c0ffee;
  const random = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return randomState >>> 0;
  };
  for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
    const base = recordIndex * 7;
    values[base] = authoritativeTexelCount + recordIndex;
    for (let donor = 0; donor < 4; donor += 1) values[base + 1 + donor] = random() % authoritativeTexelCount;
    const raw = [random() % 1024 + 1, random() % 1024 + 1, random() % 1024 + 1, random() % 1024 + 1];
    const total = raw.reduce((sum, value) => sum + value, 0);
    const weights = raw.map((value) => Math.floor(value / total * 65535));
    weights[3] = 65535 - weights[0] - weights[1] - weights[2];
    values[base + 5] = weights[0] | (weights[1] << 16);
    values[base + 6] = weights[2] | (weights[3] << 16);
  }
}

