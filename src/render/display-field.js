// The display field: the slime thickness as it is drawn.
//
// The organism's raw thickness is noisy from texel to texel and from frame to
// frame. Before drawing, it is blurred a little in space and blended with the
// previous frame, which is what gives the slime its wet, continuous look. This
// file also keeps the "memory" texture: the most slime each texel has ever
// shown, which is what reveals the gold body.

const SMOOTH_FRAGMENT = /* glsl */ `
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_current;
uniform sampler2D u_previous;
uniform vec2 u_texel;
uniform vec2 u_direction;
uniform float u_radiusTexels;
uniform float u_temporal;      // 0 for the first of the two blur passes
uniform float u_max;
uniform int u_taps;
void main() {
  float radius = max(u_radiusTexels, 0.0);
  float centre = max(texture(u_current, v_uv).r, 0.0);
  float sum = centre;
  float weightSum = 1.0;
  float sigma = max(radius * 0.42, 0.35);
  int taps = clamp(u_taps, 0, 14);
  for (int i = 1; i <= 14; i++) {
    if (i > taps) break;
    float offset = float(i) * radius / float(max(taps, 1));
    float weight = exp(-0.5 * offset * offset / (sigma * sigma));
    vec2 step = u_direction * u_texel * offset;
    sum += (max(texture(u_current, v_uv + step).r, 0.0) + max(texture(u_current, v_uv - step).r, 0.0)) * weight;
    weightSum += weight * 2.0;
  }
  // Fade the blur in over the first quarter-texel of radius so radius 0 is exactly "off".
  float value = mix(centre, sum / weightSum, smoothstep(0.0, 0.25, radius));
  if (u_temporal > 0.0) {
    // Above 1 the setting keeps asymptotically more of the past, never all of it.
    float keep = u_temporal > 1.0 ? 1.0 - 0.02 / u_temporal : min(u_temporal, 0.98);
    value = mix(value, max(texture(u_previous, v_uv).r, 0.0), clamp(keep, 0.0, 0.995));
  }
  outColor = vec4(clamp(value, 0.0, u_max), 0.0, 0.0, 1.0);
}
`;

const MEMORY_FRAGMENT = /* glsl */ `
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_current;
uniform sampler2D u_previous;
void main() {
  outColor = vec4(max(max(texture(u_current, v_uv).r, texture(u_previous, v_uv).r), 0.0), 0.0, 0.0, 1.0);
}
`;

// The temporal blend keeps converging for a while after the slime stops
// changing; after this many still frames the passes are skipped.
const SETTLE_FRAMES = 600;

export function createDisplayField({ gpu, surface, smoothingTaps }) {
  const size = surface.fieldSize;
  const scratch = gpu.target(size, size, { type: 'float', name: 'display-scratch' });
  const history = gpu.pair(size, size, { type: 'float', name: 'display-history' });
  // What the materials sample: half-float so every device can filter it.
  const display = gpu.target(size, size, { type: 'half', filter: 'linear', name: 'display' });
  const memory = gpu.pair(size, size, { type: 'half', filter: 'linear', name: 'display-memory' });

  const smoothPass = gpu.material(SMOOTH_FRAGMENT, {
    u_current: null, u_previous: null, u_texel: [1 / size, 1 / size], u_direction: [1, 0],
    u_radiusTexels: 0, u_temporal: 0, u_max: 1, u_taps: smoothingTaps,
  });
  const memoryPass = gpu.material(MEMORY_FRAGMENT, { u_current: display.texture, u_previous: null });

  let framesUntilSettled = SETTLE_FRAMES;
  let hasHistory = false;
  let lastSettings = '';

  return {
    /** Smoothed thickness, red channel, filterable, padded across the atlas's cuts. */
    get texture() { return display.texture; },
    /** The most thickness each texel has ever shown. */
    get memoryTexture() { return memory.read.texture; },

    /** Call whenever the slime may have changed. */
    markChanged() { framesUntilSettled = SETTLE_FRAMES; },

    /**
     * @param thickness  the model's thickness texture (already padded)
     * @param look       { spatialSmoothing, temporalSmoothing }
     * @param max        the model's thicknessMax
     * @param keepMemory whether anything is reading the memory texture
     */
    update(thickness, look, max, keepMemory) {
      const settings = `${look.spatialSmoothing}|${look.temporalSmoothing}|${max}`;
      if (settings !== lastSettings) {
        lastSettings = settings;
        framesUntilSettled = SETTLE_FRAMES;
      }
      if (framesUntilSettled > 0) {
        framesUntilSettled--;
        const u = smoothPass.uniforms;
        u.u_radiusTexels.value = look.spatialSmoothing;
        u.u_max.value = max;
        u.u_current.value = thickness;
        u.u_direction.value = [1, 0];
        u.u_temporal.value = 0;
        gpu.run(smoothPass, scratch);
        u.u_current.value = scratch.texture;
        u.u_previous.value = history.read.texture;
        u.u_direction.value = [0, 1];
        u.u_temporal.value = hasHistory ? look.temporalSmoothing : 0;
        gpu.run(smoothPass, history.write);
        history.swap();
        hasHistory = true;
        surface.pad(history.read.texture, display);
      }
      if (keepMemory) {
        memoryPass.uniforms.u_previous.value = memory.read.texture;
        gpu.run(memoryPass, memory.write);
        memory.swap();
      }
    },

    /** Forget everything (the world was reset). */
    reset() {
      for (const target of [scratch, history.read, history.write, display, memory.read, memory.write]) gpu.clear(target);
      hasHistory = false;
      framesUntilSettled = SETTLE_FRAMES;
    },

    dispose() {
      scratch.dispose();
      history.dispose();
      display.dispose();
      memory.dispose();
      smoothPass.dispose();
      memoryPass.dispose();
    },
  };
}
