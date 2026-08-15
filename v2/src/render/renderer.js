import { fetchWgsl } from '../gpu/wgsl.js';
import { makeIcosaLightUniformData } from './light-rig.js';

const CLEAR_COLOUR = Object.freeze({ r: 0.004, g: 0.006, b: 0.005, a: 1 });
const TEST_TARGET_SIZE = 256;

export async function createSurfaceRenderer({
  device,
  registry,
  canvas,
  cameraRig,
  materialUniforms,
  mesh,
  displayChain,
  goldLut,
  dev = true,
  onCompilationMessage,
}) {
  const context = canvas.getContext('webgpu');
  const colourFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format: colourFormat,
    alphaMode: 'opaque',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const lightBuffer = registry.createBuffer({
    label: 'look-icosa-light-uniforms',
    size: 32 * 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(lightBuffer, 0, makeIcosaLightUniformData());

  const frameLayout = device.createBindGroupLayout({
    label: 'look-material-frame-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const textureLayout = device.createBindGroupLayout({
    label: 'look-material-texture-layout',
    entries: [
      textureEntry(0, 'float'),
      samplerEntry(1),
      samplerEntry(2),
      textureEntry(3, 'unfilterable-float'),
      textureEntry(4, 'float'),
      samplerEntry(5),
    ],
  });
  const pipelineLayout = device.createPipelineLayout({
    label: 'look-material-pipeline-layout',
    bindGroupLayouts: [frameLayout, textureLayout],
  });
  const frameBindGroup = device.createBindGroup({
    label: 'look-material-frame-bind',
    layout: frameLayout,
    entries: [
      { binding: 0, resource: { buffer: cameraRig.uniformBuffer } },
      { binding: 1, resource: { buffer: materialUniforms.buffer } },
      { binding: 2, resource: { buffer: lightBuffer } },
    ],
  });
  const displayLinearSampler = device.createSampler({
    label: 'look-display-linear-sampler',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    magFilter: 'linear',
    minFilter: 'linear',
  });
  const displayNearestSampler = device.createSampler({
    label: 'look-display-nearest-sampler',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    magFilter: 'nearest',
    minFilter: 'nearest',
  });
  const goldSampler = device.createSampler({
    label: 'look-gold-response-sampler',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    magFilter: 'linear',
    minFilter: 'linear',
  });
  const textureBindGroups = displayChain.maximumViews.map((maximumView, index) => device.createBindGroup({
    label: `look-material-texture-bind-${index}`,
    layout: textureLayout,
    entries: [
      { binding: 0, resource: displayChain.sampleView },
      { binding: 1, resource: displayLinearSampler },
      { binding: 2, resource: displayNearestSampler },
      { binding: 3, resource: maximumView },
      { binding: 4, resource: goldLut.view },
      { binding: 5, resource: goldSampler },
    ],
  }));

  const [slimeSource, goldSource] = await Promise.all([
    fetchWgsl(new URL('./slime.wgsl', import.meta.url)),
    fetchWgsl(new URL('./gold.wgsl', import.meta.url)),
  ]);
  const slimeModule = await checkedModule(device, 'look-slime', slimeSource, dev, onCompilationMessage);
  const goldModule = await checkedModule(device, 'look-gold', goldSource, dev, onCompilationMessage);
  const depthStencil = {
    format: 'depth24plus',
    depthWriteEnabled: true,
    depthCompare: 'less-equal',
  };
  const goldPipeline = await device.createRenderPipelineAsync({
    label: 'look-gold-pipeline',
    layout: pipelineLayout,
    vertex: { module: goldModule, entryPoint: 'goldVertex', buffers: mesh.vertexLayouts },
    fragment: { module: goldModule, entryPoint: 'goldFragment', targets: [{ format: colourFormat }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil,
  });
  const slimePipeline = await device.createRenderPipelineAsync({
    label: 'look-slime-pipeline',
    layout: pipelineLayout,
    vertex: { module: slimeModule, entryPoint: 'slimeVertex', buffers: mesh.vertexLayouts },
    fragment: {
      module: slimeModule,
      entryPoint: 'slimeFragment',
      targets: [{
        format: colourFormat,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { ...depthStencil, depthWriteEnabled: false },
  });

  const testColour = registry.createTexture({
    label: 'look-test-colour',
    size: [TEST_TARGET_SIZE, TEST_TARGET_SIZE],
    format: colourFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const testDepth = makeDepthTexture(registry, 'look-test-depth', TEST_TARGET_SIZE, TEST_TARGET_SIZE);
  const testColourView = testColour.createView();
  const testDepthView = testDepth.createView();
  const testBytesPerRow = align(TEST_TARGET_SIZE * 4, 256);
  const testReadback = registry.createBuffer({
    label: 'look-test-colour-readback',
    size: testBytesPerRow * TEST_TARGET_SIZE,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  let canvasDepth = null;
  let canvasDepthView = null;
  let canvasWidth = 0;
  let canvasHeight = 0;

  function encodeCanvas(encoder, params) {
    resizeCanvasTarget();
    cameraRig.update(canvasWidth, canvasHeight);
    encodeMeshPass(
      encoder,
      context.getCurrentTexture().createView(),
      canvasDepthView,
      params,
      'look-canvas-mesh-pass',
    );
  }

  function encodeTestFrame(encoder, params) {
    cameraRig.update(TEST_TARGET_SIZE, TEST_TARGET_SIZE);
    encodeMeshPass(encoder, testColourView, testDepthView, params, 'look-offscreen-mesh-pass');
    encoder.copyTextureToBuffer(
      { texture: testColour },
      { buffer: testReadback, bytesPerRow: testBytesPerRow, rowsPerImage: TEST_TARGET_SIZE },
      [TEST_TARGET_SIZE, TEST_TARGET_SIZE, 1],
    );
  }

  function encodeMeshPass(encoder, colourView, depthView, params, label) {
    const pass = encoder.beginRenderPass({
      label,
      colorAttachments: [{
        view: colourView,
        clearValue: CLEAR_COLOUR,
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    for (let bindingIndex = 0; bindingIndex < mesh.vertexBindings.length; bindingIndex += 1) {
      const binding = mesh.vertexBindings[bindingIndex];
      pass.setVertexBuffer(bindingIndex, binding.buffer, binding.byteOffset, binding.byteLength);
    }
    pass.setIndexBuffer(
      mesh.indexBinding.buffer,
      mesh.indexBinding.format,
      mesh.indexBinding.byteOffset,
      mesh.indexBinding.byteLength,
    );
    pass.setBindGroup(0, frameBindGroup);
    pass.setBindGroup(1, textureBindGroups[displayChain.currentMaximumIndex()]);
    if (params.useGoldWaferBody) {
      pass.setPipeline(goldPipeline);
      pass.drawIndexed(mesh.indexCount);
    }
    pass.setPipeline(slimePipeline);
    pass.drawIndexed(mesh.indexCount);
    pass.end();
  }

  async function readTestStats() {
    await testReadback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(testReadback.getMappedRange());
    const background = [CLEAR_COLOUR.r, CLEAR_COLOUR.g, CLEAR_COLOUR.b].map((value) => Math.round(value * 255));
    let nonBackgroundPixels = 0;
    let maxLum = 0;
    for (let pixelY = 0; pixelY < TEST_TARGET_SIZE; pixelY += 1) {
      for (let pixelX = 0; pixelX < TEST_TARGET_SIZE; pixelX += 1) {
        const offset = pixelY * testBytesPerRow + pixelX * 4;
        const red = pixels[offset + (colourFormat.startsWith('bgra') ? 2 : 0)];
        const green = pixels[offset + 1];
        const blue = pixels[offset + (colourFormat.startsWith('bgra') ? 0 : 2)];
        if (Math.max(
          Math.abs(red - background[0]),
          Math.abs(green - background[1]),
          Math.abs(blue - background[2]),
        ) > 3) {
          nonBackgroundPixels += 1;
        }
        maxLum = Math.max(maxLum, (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255);
      }
    }
    testReadback.unmap();
    return {
      nonBackgroundFrac: nonBackgroundPixels / (TEST_TARGET_SIZE * TEST_TARGET_SIZE),
      maxLum,
    };
  }

  function resizeCanvasTarget() {
    const pixelRatio = Math.min(devicePixelRatio, 2); // legacy desktop cap, inventory §0.
    const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
    const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
    if (width === canvasWidth && height === canvasHeight) return;
    canvasWidth = width;
    canvasHeight = height;
    canvas.width = width;
    canvas.height = height;
    if (canvasDepth) registry.destroy(canvasDepth);
    canvasDepth = makeDepthTexture(registry, 'look-canvas-depth', width, height);
    canvasDepthView = canvasDepth.createView();
  }

  resizeCanvasTarget();
  return { colourFormat, encodeCanvas, encodeTestFrame, readTestStats };
}

function makeDepthTexture(registry, label, width, height) {
  return registry.createTexture({
    label,
    size: [width, height],
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
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

function textureEntry(binding, sampleType) {
  return { binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType, viewDimension: '2d' } };
}

function samplerEntry(binding) {
  return { binding, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } };
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
