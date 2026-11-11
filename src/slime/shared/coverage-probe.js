// Coverage probe: "how much slime is near these points?" answered on the GPU
// and read back without stalling the frame. Any slime model can use it to
// implement coverageNear().

import * as THREE from 'three';
import { SURFACE_GLSL } from '../../surface/surface-glsl.js';

const MAX_POINTS = 64;

// One output texel per point: the peak of the texture's red channel within a
// world radius of it.
const PROBE_FRAGMENT = /* glsl */ `
in vec2 v_uv;
out vec4 outColor;
#define MAX_POINTS ${MAX_POINTS}
uniform sampler2D u_field;
uniform int u_pointCount;
uniform vec2 u_points[MAX_POINTS];
uniform float u_fieldSize;
uniform float u_radiusWorld;
uniform float u_texelWorld;
${SURFACE_GLSL}
void main() {
  int index = int(gl_FragCoord.x);
  if (index >= u_pointCount) {
    outColor = vec4(0.0);
    return;
  }
  vec2 centre = clamp(u_points[index], vec2(0.0), vec2(0.999999));
  float radiusTexels = clamp(u_radiusWorld / (u_texelWorld * sqrt(texelArea(surfaceMetric(centre)))), 1.0, 12.0);
  float peak = 0.0;
  const int RINGS = 4;
  for (int dy = -RINGS; dy <= RINGS; dy++) {
    for (int dx = -RINGS; dx <= RINGS; dx++) {
      vec2 uv = centre + vec2(float(dx), float(dy)) / float(RINGS) * radiusTexels / u_fieldSize;
      if (onSurface(uv)) peak = max(peak, texture(u_field, uv).r);
    }
  }
  outColor = vec4(peak, 0.0, 0.0, 1.0);
}
`;

export function createCoverageProbe({ gpu, surface }) {
  const target = gpu.target(MAX_POINTS, 1, { type: 'float', name: 'coverage' });
  const pass = gpu.material(PROBE_FRAGMENT, {
    u_field: null, u_pointCount: 0,
    u_points: Array.from({ length: MAX_POINTS }, () => new THREE.Vector2()),
    u_fieldSize: surface.fieldSize, u_radiusWorld: 0, u_texelWorld: surface.texelWorld,
    ...surface.uniforms(),
  });

  return {
    /** Peak red value of `field` within `radiusWorld` of each atlas point. Points beyond the 64th read 0. */
    async near(field, uvs, radiusWorld) {
      const count = Math.min(uvs.length, MAX_POINTS);
      if (count === 0) return [];
      const u = pass.uniforms;
      u.u_field.value = field;
      u.u_pointCount.value = count;
      u.u_radiusWorld.value = radiusWorld;
      for (let i = 0; i < count; i++) u.u_points.value[i].set(uvs[i].x, uvs[i].y);
      gpu.run(pass, target);
      const texels = new Float32Array(MAX_POINTS * 4);
      await gpu.renderer.readRenderTargetPixelsAsync(target, 0, 0, MAX_POINTS, 1, texels);
      return Array.from({ length: uvs.length }, (_, i) => (i < count ? texels[i * 4] : 0));
    },
    dispose() {
      target.dispose();
      pass.dispose();
    },
  };
}
