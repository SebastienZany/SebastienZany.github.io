// Small helpers for GPU passes that compute into textures.
//
// Everything the simulation and the display chain do is a "pass": draw one
// triangle that covers the whole target and let a fragment shader compute each
// texel. This file owns that triangle, the render-target formats, and the
// capability checks that differ between desktop and iOS.

import * as THREE from 'three';

const FULLSCREEN_VERTEX = /* glsl */ `
in vec3 position;
out vec2 v_uv;
void main() {
  v_uv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** `pretendMissing` lists capabilities to treat as absent, to exercise the phone code paths on a desktop. */
export function createGpu(renderer, { pretendMissing = [] } = {}) {
  const gl = renderer.getContext();
  if (!renderer.extensions.get('EXT_color_buffer_float')) {
    throw new Error('This browser cannot render to float textures (EXT_color_buffer_float).');
  }
  // iOS Safari has neither of these. Without float blending, additive splats go
  // to half-float targets; without linear float filtering, float fields are
  // point-sampled.
  const caps = Object.freeze({
    floatBlend: !pretendMissing.includes('floatBlend') && Boolean(renderer.extensions.get('EXT_float_blend')),
    linearFloat: !pretendMissing.includes('linearFloat') && Boolean(renderer.extensions.get('OES_texture_float_linear')),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  });

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const triangle = new THREE.BufferGeometry();
  triangle.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quad = new THREE.Mesh(triangle, null);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);

  const TYPES = { float: THREE.FloatType, half: THREE.HalfFloatType, byte: THREE.UnsignedByteType };

  /**
   * A texture to compute into.
   * type: 'float' (32-bit), 'half' (16-bit) or 'byte'.
   * filter: 'nearest' or 'linear' ('linear' silently becomes 'nearest' for
   * 32-bit float where the device cannot filter it).
   */
  function target(width, height, { type = 'float', filter = 'nearest', name = '' } = {}) {
    const canFilter = type !== 'float' || caps.linearFloat;
    const threeFilter = filter === 'linear' && canFilter ? THREE.LinearFilter : THREE.NearestFilter;
    const rt = new THREE.WebGLRenderTarget(width, height, {
      type: TYPES[type],
      format: THREE.RGBAFormat,
      minFilter: threeFilter,
      magFilter: threeFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
    rt.texture.name = name;
    clear(rt);
    return rt;
  }

  /** A float target that additive blending can draw into on every device. */
  function blendableTarget(width, height, options = {}) {
    return target(width, height, { ...options, type: caps.floatBlend ? 'float' : 'half' });
  }

  /** Two targets to ping-pong between: read from `read`, write to `write`, then swap(). */
  function pair(width, height, options = {}) {
    const state = {
      read: target(width, height, { ...options, name: `${options.name ?? ''}:a` }),
      write: target(width, height, { ...options, name: `${options.name ?? ''}:b` }),
      swap() {
        const previous = state.read;
        state.read = state.write;
        state.write = previous;
      },
      dispose() {
        state.read.dispose();
        state.write.dispose();
      },
    };
    return state;
  }

  /** A fragment-shader pass. `uniforms` is a plain { name: initialValue } map. */
  function material(fragmentShader, uniforms = {}, extras = {}) {
    const wrapped = {};
    for (const [name, value] of Object.entries(uniforms)) wrapped[name] = { value };
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: `precision highp float;\nprecision highp int;\nprecision highp sampler2D;\n${fragmentShader}`,
      uniforms: wrapped,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      ...extras,
    });
  }

  /** Run `passMaterial` over every texel of `renderTarget`. */
  function run(passMaterial, renderTarget) {
    const previous = renderer.getRenderTarget();
    quad.material = passMaterial;
    renderer.setRenderTarget(renderTarget);
    renderer.render(quadScene, camera);
    renderer.setRenderTarget(previous);
  }

  /** Draw an arbitrary scene (point splats, UV-space meshes) into a target. */
  function draw(scene, renderTarget, { clearFirst = true } = {}) {
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(renderTarget);
    if (clearFirst) {
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
    }
    renderer.render(scene, camera);
    renderer.setRenderTarget(previous);
  }

  function clear(renderTarget) {
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(renderTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(previous);
  }

  /** Read a float region back to the CPU, as RGBA float32. Slow; not for per-frame use. */
  function readFloats(renderTarget, x = 0, y = 0, width = renderTarget.width, height = renderTarget.height) {
    const isHalf = renderTarget.texture.type === THREE.HalfFloatType;
    const isByte = renderTarget.texture.type === THREE.UnsignedByteType;
    const count = width * height * 4;
    if (isByte) {
      const bytes = new Uint8Array(count);
      renderer.readRenderTargetPixels(renderTarget, x, y, width, height, bytes);
      return Float32Array.from(bytes, (b) => b / 255);
    }
    if (isHalf) {
      const halves = new Uint16Array(count);
      renderer.readRenderTargetPixels(renderTarget, x, y, width, height, halves);
      return Float32Array.from(halves, THREE.DataUtils.fromHalfFloat);
    }
    const floats = new Float32Array(count);
    renderer.readRenderTargetPixels(renderTarget, x, y, width, height, floats);
    return floats;
  }

  return { renderer, caps, camera, target, blendableTarget, pair, material, run, draw, clear, readFloats };
}
