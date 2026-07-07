// Standalone flat-field renderer for the WebGPU physarum sim. Samples the sim's
// field texture and maps it to a physarum colormap on a full-screen triangle.
// Used only by the dev/benchmark harness (dev.html); the real app renders the
// field on the cuttlefish mesh via main.js instead.

import { WGSL_SHARED } from './sim.js?v=11';

const RENDER_WGSL = WGSL_SHARED + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var fieldTex: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -3.0), vec2<f32>(-1.0, 1.0), vec2<f32>(3.0, 1.0));
  var o: VOut;
  let xy = p[vi];
  o.pos = vec4<f32>(xy, 0.0, 1.0);
  o.uv = vec2<f32>((xy.x + 1.0) * 0.5, 1.0 - (xy.y + 1.0) * 0.5);
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4<f32> {
  let s = P.v0.x;
  let t = vec2<i32>(clamp(in.uv, vec2<f32>(0.0), vec2<f32>(0.99999)) * s);
  let food = max(textureLoad(fieldTex, t, 0).r, 0.0);
  var x = clamp(food / P.v5.z, 0.0, 1.0);
  x = pow(x, 0.55);
  // dark navy -> teal -> warm white
  let a = vec3<f32>(0.015, 0.03, 0.06);
  let b = vec3<f32>(0.05, 0.65, 0.62);
  let c = vec3<f32>(1.0, 0.98, 0.92);
  var col = mix(a, b, smoothstep(0.0, 0.55, x));
  col = mix(col, c, smoothstep(0.5, 1.0, x));
  return vec4<f32>(col, 1.0);
}
`;

/**
 * @param {object} opts
 * @param {ReturnType<import('./sim.js').createPhysarumSim>} opts.sim  resolved sim object
 * @param {HTMLCanvasElement} opts.canvas
 * @param {number} [opts.maxPixelRatio=2]
 */
export function createFieldRenderer({ sim, canvas, maxPixelRatio = 2 }) {
  const device = sim.device;
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });

  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: device.createShaderModule({ code: RENDER_WGSL }), entryPoint: 'vs' },
    fragment: { module: device.createShaderModule({ code: RENDER_WGSL }), entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });

  // One bind group per field texture; select by sim.getParity() each frame.
  const bind = sim.fieldTextures.map((tex) => device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: sim.paramsBuffer } },
      { binding: 1, resource: tex.createView() },
    ],
  }));

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  }
  resize();

  function render() {
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind[sim.getParity()]);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  return { render, resize };
}
