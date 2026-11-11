// Food field: the oats painted into the atlas, for slime models that want to
// read "how much food is here" from a texture.
//
// Each food source is a Gaussian bump in world distance; where bumps overlap
// the larger wins. A source next to a cut feeds both sides of it.

import * as THREE from 'three';
import { SURFACE_GLSL } from '../../surface/surface-glsl.js';

export const MAX_FOOD_SOURCES = 64;
// Food is ignored beyond this many radii, where it has fallen to a thousandth of its peak.
const SUPPORT_SIGMAS = Math.sqrt(-2 * Math.log(0.001));

const FOOD_FRAGMENT = /* glsl */ `
in vec2 v_uv;
out vec4 outColor;
#define MAX_SOURCES ${MAX_FOOD_SOURCES}
uniform int u_sourceCount;
uniform vec4 u_sources[MAX_SOURCES];   // xy = atlas position, z = radius (world), w = power
${SURFACE_GLSL}
void main() {
  if (!onSurface(v_uv)) {
    outColor = vec4(0.0);
    return;
  }
  vec4 metric = surfaceMetric(v_uv);
  // The same texel seen from the far side of the nearest cut.
  vec4 seam = texture(u_surfaceSeam, v_uv);
  float seamScale = length(seam.xy);
  vec2 beyond = vec2(seam.x * v_uv.x - seam.y * v_uv.y, seam.y * v_uv.x + seam.x * v_uv.y) + seam.zw;
  float isoWorldPerUv = sqrt(max(sqrt(max(metric.r * metric.b - metric.g * metric.g, 0.0)), 1e-12));

  float food = 0.0;
  for (int i = 0; i < MAX_SOURCES; i++) {
    if (i >= u_sourceCount) break;
    vec4 source = u_sources[i];
    float radius = max(source.z, 0.0001);
    float distance = worldLength(metric, v_uv - source.xy);
    if (seamScale > 0.0) {
      distance = min(distance, length(beyond - source.xy) / seamScale * isoWorldPerUv);
    }
    if (distance > radius * ${SUPPORT_SIGMAS.toFixed(6)}) continue;
    food = max(food, max(source.w, 0.0) * exp(-distance * distance / (2.0 * radius * radius)));
  }
  outColor = vec4(food, 0.0, 0.0, 1.0);
}
`;

export function createFoodField({ gpu, surface }) {
  const size = surface.fieldSize;
  const target = gpu.target(size, size, { type: 'half', name: 'food' });
  const pass = gpu.material(FOOD_FRAGMENT, {
    u_sourceCount: 0,
    u_sources: Array.from({ length: MAX_FOOD_SOURCES }, () => new THREE.Vector4()),
    ...surface.uniforms(),
  });
  let sources = [];
  let dirty = true;

  return {
    /** Red = food on that texel. Call refresh() before reading it in a step. */
    texture: target.texture,
    /** @param {import('../model.js').FoodSource[]} next */
    set(next) {
      sources = next;
      dirty = true;
    },
    /** Repaint if the sources changed since the last call. */
    refresh() {
      if (!dirty) return;
      dirty = false;
      const count = Math.min(sources.length, MAX_FOOD_SOURCES);
      pass.uniforms.u_sourceCount.value = count;
      for (let i = 0; i < count; i++) {
        const source = sources[i];
        pass.uniforms.u_sources.value[i].set(source.uv.x, source.uv.y, source.radiusWorld, source.power);
      }
      gpu.run(pass, target);
    },
    dispose() {
      target.dispose();
      pass.dispose();
    },
  };
}
