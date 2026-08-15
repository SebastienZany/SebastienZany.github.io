import { fetchWgsl } from '../gpu/wgsl.js';

const WORKGROUP_EDGE = 8;
const DISPLAY_FORMAT = 'r16float'; // Core renderable/filterable; PLAN §2's preferred path.

export async function createSyntheticDisplayChain({
  device,
  registry,
  fieldProvider,
  dev = true,
  onCompilationMessage,
}) {
  if (fieldProvider?.size <= 0) throw new TypeError('Display chain requires a field provider');
  const size = fieldProvider.size;
  const scalarUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
    | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
  const historyTextures = makeTexturePair(registry, 'look-display-history', size, 'r32float', scalarUsage);
  const maximumTextures = makeTexturePair(registry, 'look-max-food-history', size, 'r32float', scalarUsage);
  const historyViews = historyTextures.map((texture) => texture.createView());
  const maximumViews = maximumTextures.map((texture) => texture.createView());
  const sampleTexture = registry.createTexture({
    label: 'look-display-sample-view',
    size: [size, size],
    format: DISPLAY_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const uniformBuffer = registry.createBuffer({
    label: 'look-display-uniforms',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const uniformValues = new Float32Array(4);
  const sampleView = sampleTexture.createView();
  const readbackBytesPerRow = align(size * 4, 256);
  const finiteReadback = registry.createBuffer({
    label: 'look-display-finite-readback',
    size: readbackBytesPerRow * size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const historyLayout = device.createBindGroupLayout({
    label: 'look-display-history-layout',
    entries: [
      textureEntry(0, GPUShaderStage.COMPUTE, 'unfilterable-float'),
      textureEntry(1, GPUShaderStage.COMPUTE, 'unfilterable-float'),
      storageTextureEntry(2, GPUShaderStage.COMPUTE, 'r32float'),
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const maximumLayout = device.createBindGroupLayout({
    label: 'look-max-food-history-layout',
    entries: [
      textureEntry(0, GPUShaderStage.COMPUTE, 'unfilterable-float'),
      textureEntry(1, GPUShaderStage.COMPUTE, 'unfilterable-float'),
      storageTextureEntry(2, GPUShaderStage.COMPUTE, 'r32float'),
    ],
  });
  const sampleLayout = device.createBindGroupLayout({
    label: 'look-sample-view-layout',
    entries: [textureEntry(0, GPUShaderStage.FRAGMENT, 'unfilterable-float')],
  });

  const [historySource, maximumSource, sampleSource] = await Promise.all([
    fetchWgsl(new URL('./display-history.wgsl', import.meta.url)),
    fetchWgsl(new URL('./max-food-history.wgsl', import.meta.url)),
    fetchWgsl(new URL('./sample-view.wgsl', import.meta.url)),
  ]);
  const historyModule = await checkedModule(device, 'look-display-history', historySource, dev, onCompilationMessage);
  const maximumModule = await checkedModule(device, 'look-max-food-history', maximumSource, dev, onCompilationMessage);
  const sampleModule = await checkedModule(device, 'look-sample-view', sampleSource, dev, onCompilationMessage);

  const historyPipeline = await device.createComputePipelineAsync({
    label: 'look-display-history-pipeline',
    layout: pipelineLayout(device, 'look-display-history-pipeline-layout', [historyLayout]),
    compute: { module: historyModule, entryPoint: 'displayHistoryMain' },
  });
  const maximumPipeline = await device.createComputePipelineAsync({
    label: 'look-max-food-history-pipeline',
    layout: pipelineLayout(device, 'look-max-food-history-pipeline-layout', [maximumLayout]),
    compute: { module: maximumModule, entryPoint: 'maxFoodHistoryMain' },
  });
  const samplePipeline = await device.createRenderPipelineAsync({
    label: 'look-sample-view-pipeline',
    layout: pipelineLayout(device, 'look-sample-view-pipeline-layout', [sampleLayout]),
    vertex: { module: sampleModule, entryPoint: 'sampleViewVertex' },
    fragment: { module: sampleModule, entryPoint: 'sampleViewFragment', targets: [{ format: DISPLAY_FORMAT }] },
    primitive: { topology: 'triangle-list' },
  });

  const historyBindGroups = historyTextures.map((previousTexture, previousIndex) => (
    device.createBindGroup({
      label: `look-display-history-bind-${previousIndex}`,
      layout: historyLayout,
      entries: [
        { binding: 0, resource: fieldProvider.view },
        { binding: 1, resource: historyViews[previousIndex] },
        { binding: 2, resource: historyViews[1 - previousIndex] },
        { binding: 3, resource: { buffer: uniformBuffer } },
      ],
    })
  ));
  const maximumBindGroups = maximumTextures.map((previousTexture, previousIndex) => (
    historyTextures.map((historyTexture, historyIndex) => device.createBindGroup({
      label: `look-max-food-history-bind-${previousIndex}-${historyIndex}`,
      layout: maximumLayout,
      entries: [
        { binding: 0, resource: historyViews[historyIndex] },
        { binding: 1, resource: maximumViews[previousIndex] },
        { binding: 2, resource: maximumViews[1 - previousIndex] },
      ],
    }))
  ));
  const sampleBindGroups = historyTextures.map((historyTexture, historyIndex) => device.createBindGroup({
    label: `look-sample-view-bind-${historyIndex}`,
    layout: sampleLayout,
    entries: [{ binding: 0, resource: historyViews[historyIndex] }],
  }));

  let currentHistoryIndex = 0;
  let currentMaximumIndex = 0;
  let historyReady = false;

  function encode(encoder, params) {
    uniformValues[0] = params.temporalSmoothing;
    uniformValues[1] = params.spatialSmoothing;
    uniformValues[2] = historyReady ? 1 : 0;
    uniformValues[3] = params.foodClamp;
    device.queue.writeBuffer(uniformBuffer, 0, uniformValues);

    const historyPass = encoder.beginComputePass({ label: 'look-display-history-pass' });
    historyPass.setPipeline(historyPipeline);
    historyPass.setBindGroup(0, historyBindGroups[currentHistoryIndex]);
    historyPass.dispatchWorkgroups(Math.ceil(size / WORKGROUP_EDGE), Math.ceil(size / WORKGROUP_EDGE));
    historyPass.end();
    currentHistoryIndex = 1 - currentHistoryIndex;
    historyReady = true;

    const maximumPass = encoder.beginComputePass({ label: 'look-max-food-history-pass' });
    maximumPass.setPipeline(maximumPipeline);
    maximumPass.setBindGroup(0, maximumBindGroups[currentMaximumIndex][currentHistoryIndex]);
    maximumPass.dispatchWorkgroups(Math.ceil(size / WORKGROUP_EDGE), Math.ceil(size / WORKGROUP_EDGE));
    maximumPass.end();
    currentMaximumIndex = 1 - currentMaximumIndex;

    const samplePass = encoder.beginRenderPass({
      label: 'look-sample-view-pass',
      colorAttachments: [{
        view: sampleView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    samplePass.setPipeline(samplePipeline);
    samplePass.setBindGroup(0, sampleBindGroups[currentHistoryIndex]);
    samplePass.draw(3);
    samplePass.end();
  }

  async function scanForNonFinite() {
    const encoder = device.createCommandEncoder({ label: 'look-display-finite-scan-encoder' });
    encoder.copyTextureToBuffer(
      { texture: historyTextures[currentHistoryIndex] },
      { buffer: finiteReadback, bytesPerRow: readbackBytesPerRow, rowsPerImage: size },
      [size, size, 1],
    );
    device.queue.submit([encoder.finish()]);
    await finiteReadback.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(finiteReadback.getMappedRange());
    const values = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let nonFiniteCount = 0;
    for (let texelY = 0; texelY < size; texelY += 1) {
      for (let texelX = 0; texelX < size; texelX += 1) {
        const value = values.getFloat32(texelY * readbackBytesPerRow + texelX * 4, true);
        if (!Number.isFinite(value)) nonFiniteCount += 1;
      }
    }
    finiteReadback.unmap();
    return nonFiniteCount;
  }

  return {
    size,
    displayFormat: DISPLAY_FORMAT,
    sampleTexture,
    sampleView,
    maximumTextures,
    maximumViews,
    encode,
    currentMaximumIndex: () => currentMaximumIndex,
    currentMaximumView: () => maximumViews[currentMaximumIndex],
    scanForNonFinite,
  };
}

function makeTexturePair(registry, label, size, format, usage) {
  return [0, 1].map((index) => registry.createTexture({
    label: `${label}-${index}`,
    size: [size, size],
    format,
    usage,
  }));
}

async function checkedModule(device, label, code, dev, onCompilationMessage) {
  const module = device.createShaderModule({ label: `${label}-module`, code });
  if (dev && typeof module.getCompilationInfo === 'function') {
    const info = await module.getCompilationInfo();
    for (const message of info.messages) onCompilationMessage?.({ shader: label, ...message });
    const errors = info.messages.filter(({ type }) => type === 'error');
    if (errors.length > 0) throw new Error(errors.map(({ message }) => message).join('; '));
  }
  return module;
}

function textureEntry(binding, visibility, sampleType) {
  return { binding, visibility, texture: { sampleType, viewDimension: '2d' } };
}

function storageTextureEntry(binding, visibility, format) {
  return { binding, visibility, storageTexture: { access: 'write-only', format, viewDimension: '2d' } };
}

function pipelineLayout(device, label, bindGroupLayouts) {
  return device.createPipelineLayout({ label, bindGroupLayouts });
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
