import { withGpuErrorScope } from '../device.js';
import { fetchWgsl } from '../wgsl.js';

const shaderUrl = (name) => new URL(`../shaders/${name}`, import.meta.url);

export async function checkReadWriteStorageExtension(device, registry) {
  const resources = [];
  try {
    const code = await fetchWgsl(shaderUrl('read-write-storage.wgsl'));
    const module = await shaderModule(device, 'read-write-storage-probe', code);
    const layout = device.createBindGroupLayout({
      label: 'read-write-storage-probe-layout',
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'read-write', format: 'r32float' },
      }],
    });
    const texture = registry.createTexture({
      label: 'read-write-storage-probe-texture',
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING,
    });
    resources.push(texture);
    await scopedValidation(device, 'read-write storage pipeline', async () => {
      const pipeline = device.createComputePipeline({
        label: 'read-write-storage-probe-pipeline',
        layout: device.createPipelineLayout({ label: 'read-write-storage-probe-pipeline-layout', bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: 'main' },
      });
      const bindGroup = device.createBindGroup({
        label: 'read-write-storage-probe-bind-group',
        layout,
        entries: [{ binding: 0, resource: texture.createView() }],
      });
      const encoder = device.createCommandEncoder({ label: 'read-write-storage-probe-encoder' });
      const pass = encoder.beginComputePass({ label: 'read-write-storage-probe-pass' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
    });
    return { compiledAndDispatched: true };
  } finally {
    resources.forEach((resource) => registry.destroy(resource));
  }
}

export async function checkStorageFormat(device, registry, format) {
  const resources = [];
  try {
    const code = await fetchWgsl(shaderUrl('storage-write.wgsl'), { constants: { FORMAT: format } });
    const module = await shaderModule(device, `${format}-storage-probe`, code);
    const layout = device.createBindGroupLayout({
      label: `${format}-storage-probe-layout`,
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format },
      }],
    });
    const texture = registry.createTexture({
      label: `${format}-storage-probe-texture`,
      size: [1, 1],
      format,
      usage: GPUTextureUsage.STORAGE_BINDING,
    });
    resources.push(texture);
    await scopedValidation(device, `${format} storage`, async () => {
      const pipeline = device.createComputePipeline({
        label: `${format}-storage-probe-pipeline`,
        layout: device.createPipelineLayout({ label: `${format}-storage-probe-pipeline-layout`, bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: 'main' },
      });
      const bindGroup = device.createBindGroup({
        label: `${format}-storage-probe-bind-group`,
        layout,
        entries: [{ binding: 0, resource: texture.createView() }],
      });
      const encoder = device.createCommandEncoder({ label: `${format}-storage-probe-encoder` });
      const pass = encoder.beginComputePass({ label: `${format}-storage-probe-pass` });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
    });
    return { format, storageWrite: true };
  } finally {
    resources.forEach((resource) => registry.destroy(resource));
  }
}

export async function checkR16RenderAndFilter(device, registry) {
  const resources = [];
  try {
    const source = registry.createTexture({
      label: 'r16float-render-filter-source',
      size: [4, 4],
      format: 'r16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const target = registry.createTexture({
      label: 'r16float-render-filter-target',
      size: [4, 4],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    resources.push(source, target);
    const code = await fetchWgsl(shaderUrl('r16-filter.wgsl'));
    const module = await shaderModule(device, 'r16float-render-filter-probe', code);
    const layout = device.createBindGroupLayout({
      label: 'r16float-render-filter-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    await scopedValidation(device, 'r16float render and filter', async () => {
      const pipeline = device.createRenderPipeline({
        label: 'r16float-render-filter-pipeline',
        layout: device.createPipelineLayout({ label: 'r16float-render-filter-pipeline-layout', bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vertexMain' },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      });
      const bindGroup = device.createBindGroup({
        label: 'r16float-render-filter-bind-group',
        layout,
        entries: [
          { binding: 0, resource: source.createView() },
          { binding: 1, resource: device.createSampler({ label: 'r16float-filtering-sampler', magFilter: 'linear', minFilter: 'linear' }) },
        ],
      });
      const encoder = device.createCommandEncoder({ label: 'r16float-render-filter-encoder' });
      const clearPass = encoder.beginRenderPass({
        label: 'r16float-render-pass',
        colorAttachments: [{ view: source.createView(), clearValue: { r: 0.4, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      });
      clearPass.end();
      const samplePass = encoder.beginRenderPass({
        label: 'r16float-filter-pass',
        colorAttachments: [{ view: target.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      });
      samplePass.setPipeline(pipeline);
      samplePass.setBindGroup(0, bindGroup);
      samplePass.draw(3);
      samplePass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
    });
    return { format: 'r16float', renderAttachment: true, filterableSample: true };
  } finally {
    resources.forEach((resource) => registry.destroy(resource));
  }
}

export async function computeSumSmoke(device, registry) {
  const elementCount = 65536;
  const expected = elementCount * (elementCount + 1) / 2;
  const resources = [];
  let readback;
  try {
    const sum = registry.createBuffer({
      label: 'compute-sum-atomic',
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    readback = registry.createBuffer({
      label: 'compute-sum-readback',
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    resources.push(sum, readback);
    const code = await fetchWgsl(shaderUrl('compute-sum.wgsl'), { constants: { ELEMENT_COUNT: elementCount } });
    const module = await shaderModule(device, 'compute-sum-smoke', code);
    const layout = device.createBindGroupLayout({
      label: 'compute-sum-layout',
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage', minBindingSize: 4 } }],
    });
    const pipeline = device.createComputePipeline({
      label: 'compute-sum-pipeline',
      layout: device.createPipelineLayout({ label: 'compute-sum-pipeline-layout', bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: 'main' },
    });
    const bindGroup = device.createBindGroup({
      label: 'compute-sum-bind-group', layout, entries: [{ binding: 0, resource: { buffer: sum } }],
    });
    await scopedValidation(device, 'compute sum', async () => {
      const encoder = device.createCommandEncoder({ label: 'compute-sum-encoder' });
      encoder.clearBuffer(sum);
      const pass = encoder.beginComputePass({ label: 'compute-sum-pass' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(elementCount / 64);
      pass.end();
      encoder.copyBufferToBuffer(sum, 0, readback, 0, 4);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
    });
    const actual = new Uint32Array(readback.getMappedRange())[0];
    readback.unmap();
    if (actual !== expected) throw new Error(`Atomic sum was ${actual}; expected ${expected}`);
    return { elementCount, expected, actual };
  } finally {
    if (readback?.mapState === 'mapped') readback.unmap();
    resources.forEach((resource) => registry.destroy(resource));
  }
}

export async function renderSmoke(device, registry) {
  const size = 8;
  const resources = [];
  let readback;
  try {
    const target = registry.createTexture({
      label: 'render-smoke-target',
      size: [size, size],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    readback = registry.createBuffer({
      label: 'render-smoke-readback',
      size: 256 * size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    resources.push(target, readback);
    const code = await fetchWgsl(shaderUrl('render-smoke.wgsl'));
    const module = await shaderModule(device, 'render-smoke', code);
    const pipeline = device.createRenderPipeline({
      label: 'render-smoke-pipeline',
      layout: device.createPipelineLayout({ label: 'render-smoke-pipeline-layout', bindGroupLayouts: [] }),
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    await scopedValidation(device, 'render smoke', async () => {
      const encoder = device.createCommandEncoder({ label: 'render-smoke-encoder' });
      const pass = encoder.beginRenderPass({
        label: 'render-smoke-pass',
        colorAttachments: [{
          view: target.createView(),
          clearValue: { r: 0.01, g: 0.02, b: 0.03, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: target, origin: [size / 2, size / 2] },
        { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
        [1, 1],
      );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
    });
    const pixel = [...new Uint8Array(readback.getMappedRange()).slice(0, 4)];
    readback.unmap();
    const expected = [51, 102, 153, 255];
    if (pixel.some((component, index) => Math.abs(component - expected[index]) > 1)) {
      throw new Error(`Rendered pixel [${pixel.join(', ')}] did not match [${expected.join(', ')}]`);
    }
    return { pixel, expected };
  } finally {
    if (readback?.mapState === 'mapped') readback.unmap();
    resources.forEach((resource) => registry.destroy(resource));
  }
}

async function shaderModule(device, label, code) {
  const module = device.createShaderModule({ label, code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter(({ type }) => type === 'error');
  if (errors.length) throw new Error(errors.map(({ message, lineNum }) => `${label}:${lineNum}: ${message}`).join('\n'));
  return module;
}

async function scopedValidation(device, label, operation) {
  const { error } = await withGpuErrorScope(device, label, operation);
  if (error) throw new Error(`${label}: ${error.message}`);
}
