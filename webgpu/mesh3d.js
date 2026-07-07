// Phase B foundation: a WebGPU 3D renderer that samples the sim's field texture
// DIRECTLY on a mesh — no readback, no three.js. This proves the endgame
// architecture (sim + render in ONE WebGPU context, the field never leaves the
// GPU). Geometry here is a procedural UV sphere as a stand-in; swapping in the
// cuttlefish GLB + the full slime PBR/seam shader (in WGSL/TSL) is the remaining
// foreground work, but the pipeline — field texture → mesh surface → framebuffer,
// all WebGPU — is exactly this.

// ── Minimal column-major mat4 (WebGPU/WGSL is column-major, like GL) ──
const M4 = {
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[0 * 4 + r] * b[c * 4 + 0] + a[1 * 4 + r] * b[c * 4 + 1] + a[2 * 4 + r] * b[c * 4 + 2] + a[3 * 4 + r] * b[c * 4 + 3];
    }
    return o;
  },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  },
  lookAt(eye, center, up) {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const z = norm(sub(eye, center)), x = norm(cross(up, z)), y = cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
  },
  rotateY(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
  },
};

function makeUvSphere(rings = 48, sectors = 64) {
  const positions = [], normals = [], uvs = [], indices = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI, y = Math.cos(phi), rad = Math.sin(phi);
    for (let s = 0; s <= sectors; s++) {
      const theta = (s / sectors) * Math.PI * 2, x = rad * Math.cos(theta), z = rad * Math.sin(theta);
      positions.push(x, y, z); normals.push(x, y, z); uvs.push(s / sectors, r / rings);
    }
  }
  const stride = sectors + 1;
  for (let r = 0; r < rings; r++) for (let s = 0; s < sectors; s++) {
    const a = r * stride + s, b = a + stride;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  // interleave pos(3) normal(3) uv(2)
  const vcount = positions.length / 3;
  const verts = new Float32Array(vcount * 8);
  for (let i = 0; i < vcount; i++) {
    verts.set([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2],
      normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2], uvs[i * 2], uvs[i * 2 + 1]], i * 8);
  }
  return { verts, indices: new Uint32Array(indices), indexCount: indices.length };
}

// Slime-style surface shader in WGSL (the essence of main.js's slimeFragment):
// field-gradient bump, thin-film iridescence driven by field height, and
// multi-light specular. Samples the sim's field texture directly. The exact PBR /
// seam-continuity match to the WebGL slime is foreground content-authoring; this
// proves the field→surface-shading path renders in one WebGPU context.
const MESH_WGSL = /* wgsl */`
struct Uniforms { mvp: mat4x4<f32>, model: mat4x4<f32>, params: vec4<f32>, camPos: vec4<f32> };  // params: fieldSize, foodClamp, time, _
@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var fieldTex: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) nrm: vec3<f32>, @location(2) wpos: vec3<f32> };
@vertex fn vs(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) uv: vec2<f32>) -> VOut {
  var o: VOut;
  o.pos = U.mvp * vec4<f32>(p, 1.0);
  o.uv = uv;
  o.nrm = normalize((U.model * vec4<f32>(n, 0.0)).xyz);
  o.wpos = (U.model * vec4<f32>(p, 1.0)).xyz;
  return o;
}

fn fieldAt(uv: vec2<f32>) -> f32 {
  let s = U.params.x;
  let c = vec2<i32>(clamp(uv, vec2<f32>(0.0), vec2<f32>(0.999999)) * s);
  return max(textureLoad(fieldTex, c, 0).r, 0.0);
}
fn iridescence(t: f32) -> vec3<f32> {
  let a = t * 6.28318;
  return 0.5 + 0.5 * vec3<f32>(cos(a), cos(a + 2.094), cos(a + 4.188));
}

@fragment fn fs(in: VOut) -> @location(0) vec4<f32> {
  let px = 1.0 / U.params.x;
  let h = fieldAt(in.uv);
  // Bump: perturb the surface normal by the field gradient.
  let dx = fieldAt(in.uv + vec2<f32>(px, 0.0)) - fieldAt(in.uv - vec2<f32>(px, 0.0));
  let dy = fieldAt(in.uv + vec2<f32>(0.0, px)) - fieldAt(in.uv - vec2<f32>(0.0, px));
  let nrm = normalize(in.nrm + vec3<f32>(-dx, -dy, 0.0) * 7.0);

  let x = clamp(h / U.params.y, 0.0, 1.0);
  let irid = iridescence(x * 0.85 + U.params.z * 0.00003);
  var base = mix(vec3<f32>(0.02, 0.05, 0.09), mix(vec3<f32>(0.05, 0.5, 0.55), irid, 0.5), smoothstep(0.02, 0.6, x));

  let viewDir = normalize(U.camPos.xyz - in.wpos);
  var lights = array<vec3<f32>, 3>(vec3<f32>(0.5, 0.8, 0.6), vec3<f32>(-0.6, 0.3, 0.5), vec3<f32>(0.1, -0.5, 0.8));
  var lcol = array<vec3<f32>, 3>(vec3<f32>(1.0, 0.96, 0.9), vec3<f32>(0.4, 0.6, 1.0), vec3<f32>(0.9, 0.5, 0.7));
  var col = base * 0.15;   // ambient
  for (var k = 0; k < 3; k = k + 1) {
    let L = normalize(lights[k]);
    let diff = max(dot(nrm, L), 0.0);
    let H = normalize(L + viewDir);
    let spec = pow(max(dot(nrm, H), 0.0), 48.0);
    col += base * diff * lcol[k] * 0.5 + irid * spec * 0.7 * lcol[k];
  }
  return vec4<f32>(col, 1.0);
}
`;

/**
 * @param {object} opts
 * @param {ReturnType<import('./sim.js').createPhysarumSim>} opts.sim
 * @param {HTMLCanvasElement} [opts.canvas]  omit for offscreen/headless use
 * @param {number} [opts.maxPixelRatio=2]
 */
// opts.geometry (optional): { verts: Float32Array interleaved pos3/nrm3/uv2,
// indices: Uint32Array, indexCount } — pass the cuttlefish GLB's attributes here
// to render the real mesh; omit for the procedural sphere stand-in.
export function createMeshRenderer({ sim, canvas, geometry = null, maxPixelRatio = 2 }) {
  const device = sim.device;
  const format = navigator.gpu.getPreferredCanvasFormat();
  const ctx = canvas ? canvas.getContext('webgpu') : null;
  if (ctx) ctx.configure({ device, format, alphaMode: 'opaque' });

  const geom = geometry || makeUvSphere();
  const vbo = device.createBuffer({ size: geom.verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vbo, 0, geom.verts);
  const ibo = device.createBuffer({ size: geom.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(ibo, 0, geom.indices);
  const ubo = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  const module = device.createShaderModule({ code: MESH_WGSL });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module, entryPoint: 'vs',
      buffers: [{
        arrayStride: 32,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
          { shaderLocation: 2, offset: 24, format: 'float32x2' },
        ],
      }],
    },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
  });

  // One bind group per field texture (sim ping-pongs); select by sim.getParity().
  const bind = sim.fieldTextures.map((tex) => device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: tex.createView() }],
  }));

  let depthTex = null, depthW = 0, depthH = 0;
  const ensureDepth = (w, h) => {
    if (depthTex && depthW === w && depthH === h) return;
    if (depthTex) depthTex.destroy();
    depthTex = device.createTexture({ size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    depthW = w; depthH = h;
  };

  const uni = new Float32Array(40);
  function writeUniforms(w, h, timeMs) {
    const a = (timeMs || 0) * 0.0003;
    const eye = [0, 0, 2.6];
    const model = M4.rotateY(a);
    const view = M4.lookAt(eye, [0, 0, 0], [0, 1, 0]);
    const proj = M4.perspective(Math.PI / 4, w / h, 0.1, 100);
    const mvp = M4.mul(proj, M4.mul(view, model));
    uni.set(mvp, 0); uni.set(model, 16);
    uni.set([sim.fieldSize, sim.params.foodClamp, timeMs || 0, 0], 32);
    uni.set([eye[0], eye[1], eye[2], 0], 36);
    device.queue.writeBuffer(ubo, 0, uni);
  }

  function encode(targetView, w, h) {
    ensureDepth(w, h);
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: targetView, clearValue: { r: 0.01, g: 0.01, b: 0.02, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depthTex.createView(), depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind[sim.getParity()]);
    pass.setVertexBuffer(0, vbo);
    pass.setIndexBuffer(ibo, 'uint32');
    pass.drawIndexed(geom.indexCount);
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  function resize() {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  }
  resize();

  function render(timeMs) {
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    writeUniforms(w, h, timeMs);
    encode(ctx.getCurrentTexture().createView(), w, h);
  }

  // Headless verification: render one frame to an offscreen RGBA8 target and read
  // back pixel stats (the hidden preview canvas is 1x1, so we can't sample it).
  async function renderTestFrame(size = 256, timeMs = 0) {
    const target = device.createTexture({
      size: [size, size], format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    writeUniforms(size, size, timeMs);
    encode(target.createView(), size, size);
    const bpr = Math.ceil(size * 4 / 256) * 256;
    const rb = device.createBuffer({ size: bpr * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer: rb, bytesPerRow: bpr, rowsPerImage: size }, [size, size]);
    device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(rb.getMappedRange());
    let nonBg = 0, maxLum = 0, total = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * bpr + x * 4, lum = px[i] + px[i + 1] + px[i + 2];
      total++; if (lum > 24) nonBg++; if (lum > maxLum) maxLum = lum;
    }
    rb.unmap(); rb.destroy(); target.destroy();
    return { nonBackgroundFrac: +(nonBg / total).toFixed(3), maxLum, size };
  }

  return { render, resize, renderTestFrame };
}
