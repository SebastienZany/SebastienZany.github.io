import { fetchWgsl } from '../gpu/wgsl.js';

export async function createField2dRenderer({ device, canvas, sim, dev = true, onCompilationMessage }) {
  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: 'opaque',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const fieldLayout = device.createBindGroupLayout({
    label: 'field2d-field-layout',
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
    }],
  });
  const agentLayout = device.createBindGroupLayout({
    label: 'field2d-agent-layout',
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: 'read-only-storage' },
    }],
  });
  const emptyLayout = device.createBindGroupLayout({ label: 'field2d-empty-layout', entries: [] });
  const source = await fetchWgsl(new URL('./field2d.wgsl', import.meta.url));
  const module = device.createShaderModule({ label: 'field2d-module', code: source });
  if (dev && typeof module.getCompilationInfo === 'function') {
    const info = await module.getCompilationInfo();
    for (const message of info.messages) onCompilationMessage?.({ shader: 'field2d', ...message });
    const errors = info.messages.filter(({ type }) => type === 'error');
    if (errors.length > 0) throw new Error(errors.map(({ message }) => message).join('; '));
  }
  const fieldPipeline = await device.createRenderPipelineAsync({
    label: 'field2d-field-pipeline',
    layout: device.createPipelineLayout({
      label: 'field2d-field-pipeline-layout',
      bindGroupLayouts: [fieldLayout, emptyLayout],
    }),
    vertex: { module, entryPoint: 'fieldVertex' },
    fragment: { module, entryPoint: 'fieldFragment', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const agentPipeline = await device.createRenderPipelineAsync({
    label: 'field2d-agent-pipeline',
    layout: device.createPipelineLayout({
      label: 'field2d-agent-pipeline-layout',
      bindGroupLayouts: [emptyLayout, agentLayout],
    }),
    vertex: { module, entryPoint: 'agentVertex' },
    fragment: {
      module,
      entryPoint: 'agentFragment',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'point-list' },
  });
  const fieldBind = device.createBindGroup({
    label: 'field2d-field-bind',
    layout: fieldLayout,
    entries: [{ binding: 0, resource: sim.currentFieldView() }],
  });
  const emptyBind = device.createBindGroup({ label: 'field2d-empty-bind', layout: emptyLayout, entries: [] });
  const agentBuffers = sim.allAgentBuffers();
  const agentBinds = new Map(agentBuffers.map((buffer, index) => [buffer, device.createBindGroup({
    label: `field2d-agent-bind-${index}`,
    layout: agentLayout,
    entries: [{ binding: 0, resource: { buffer } }],
  })]));

  return {
    render({ showAgentDots = true } = {}) {
      resizeCanvas(canvas);
      const encoder = device.createCommandEncoder({ label: 'field2d-render-encoder' });
      const pass = encoder.beginRenderPass({
        label: 'field2d-render-pass',
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.004, g: 0.006, b: 0.005, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.setPipeline(fieldPipeline);
      pass.setBindGroup(0, fieldBind);
      pass.setBindGroup(1, emptyBind);
      pass.draw(3);
      if (showAgentDots) {
        pass.setPipeline(agentPipeline);
        pass.setBindGroup(0, emptyBind);
        pass.setBindGroup(1, agentBinds.get(sim.currentAgentBuffer()));
        pass.drawIndirect(sim.renderIndirectBuffer, 0);
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
  };
}

function resizeCanvas(canvas) {
  const width = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
  const height = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}
