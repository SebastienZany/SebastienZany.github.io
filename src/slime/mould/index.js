// The mould model: a second, much simpler organism, here to show how little a
// behavioural model needs. It has no agents. Slime is a quantity on the skin
// that creeps outward, thrives near food and thins out away from it.
// Load the game with ?slime=mould to see it.
//
// Use this file as the template for a new model: it implements the whole
// SlimeModel interface (src/slime/model.js) in one shader pass.

import * as THREE from 'three';
import { SURFACE_GLSL } from '../../surface/surface-glsl.js';
import { createFoodField } from '../shared/food-field.js';
import { createCoverageProbe } from '../shared/coverage-probe.js';

export const paramSchema = [
  { section: 'Mould', items: [
    { key: 'growthRate', label: 'Growth', type: 'range', min: 0, max: 0.3, step: 0.005, default: 0.09, help: 'How fast the mould thickens where it is fed.' },
    { key: 'hunger', label: 'Hunger', type: 'range', min: 0, max: 0.02, step: 0.0005, default: 0.004, help: 'How fast it thins where there is no food.' },
    { key: 'creep', label: 'Creep', type: 'range', min: 0, max: 0.9, step: 0.01, default: 0.35, help: 'How readily it spreads to neighbouring skin.' },
    { key: 'foodReach', label: 'Food scent', type: 'range', min: 0, max: 1, step: 0.01, default: 0.03, help: 'How much it grows on scent alone, far from an oat.' },
    { key: 'stepsPerFrame', label: 'Steps per frame', type: 'range', min: 0, max: 8, step: 1, default: 1 },
  ] },
];

const MOULD = Object.freeze({
  thicknessMax: 0.5,           // what the renderer treats as "as thick as slime gets"
  ceiling: 0.2,                // where well-fed mould levels off; thicker reads as a white-out
  colonyRadiusWorld: 0.18,
  colonyStrength: 0.02,        // thickness added per step at the centre while a colony is released
  coverageRadiusWorld: 0.038,
});

const STEP_FRAGMENT = /* glsl */ `
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_mould;       // padded across the atlas's cuts
uniform sampler2D u_food;
uniform vec2 u_texel;
uniform float u_dt;
uniform float u_growthRate;
uniform float u_hunger;
uniform float u_creep;
uniform float u_foodReach;
uniform float u_max;
uniform vec3 u_colony;           // xy = atlas position, z = strength (0: none)
uniform float u_colonyRadiusWorld;
uniform vec4 u_disturbance;      // xy = atlas position, z = radius (world), w = strength
${SURFACE_GLSL}
void main() {
  if (!onSurface(v_uv)) {
    outColor = vec4(0.0);
    return;
  }
  vec4 metric = surfaceMetric(v_uv);
  float here = max(texture(u_mould, v_uv).r, 0.0);
  float around = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      around += max(texture(u_mould, v_uv + vec2(float(dx), float(dy)) * u_texel).r, 0.0);
    }
  }
  // Creep is per unit of skin: spread less, per texel, where texels are large.
  float mould = mix(here, around * 0.125, clamp(u_creep / texelArea(metric), 0.0, 0.9));

  float food = max(texture(u_food, v_uv).r, 0.0);
  float appetite = u_foodReach + food;
  mould += u_dt * (u_growthRate * mould * (1.0 - mould / u_max) * appetite - u_hunger * mould);

  if (u_colony.z > 0.0) {
    float d = worldLength(metric, v_uv - u_colony.xy) / u_colonyRadiusWorld;
    mould += u_colony.z * exp(-d * d) * u_dt;
  }
  if (u_disturbance.w > 0.0) {
    float d = worldLength(metric, v_uv - u_disturbance.xy) / max(u_disturbance.z, 0.0001);
    mould *= 1.0 - clamp(0.08 * u_disturbance.w * exp(-d * d * 2.0) * u_dt, 0.0, 1.0);
  }
  outColor = vec4(clamp(mould, 0.0, u_max), 0.0, 0.0, 1.0);
}
`;

/** @returns {import('../model.js').SlimeModel} */
export function createMould({ gpu, surface, sizeScale = 1 }) {
  const size = surface.fieldSize;
  const params = {};
  for (const section of paramSchema) for (const item of section.items) params[item.key] = item.default;

  const mould = gpu.pair(size, size, { type: 'float', filter: 'linear', name: 'mould' });
  const food = createFoodField({ gpu, surface });
  const coverage = createCoverageProbe({ gpu, surface });
  const stepPass = gpu.material(STEP_FRAGMENT, {
    u_mould: null, u_food: food.texture, u_texel: new THREE.Vector2(1 / size, 1 / size), u_dt: 1,
    u_growthRate: 0, u_hunger: 0, u_creep: 0, u_foodReach: 0, u_max: MOULD.ceiling,
    u_colony: new THREE.Vector3(), u_colonyRadiusWorld: MOULD.colonyRadiusWorld * sizeScale,
    u_disturbance: new THREE.Vector4(),
    ...surface.uniforms(),
  });
  let colony = null;       // { uv, untilMs } while a colony is being released
  let disturbance = null;

  function stepOnce(now, dt) {
    food.refresh();
    const u = stepPass.uniforms;
    u.u_mould.value = mould.read.texture;
    u.u_dt.value = dt;
    u.u_growthRate.value = params.growthRate;
    u.u_hunger.value = params.hunger;
    u.u_creep.value = params.creep;
    u.u_foodReach.value = params.foodReach;
    if (colony && now >= colony.untilMs) colony = null;
    u.u_colony.value.set(colony?.uv.x ?? 0, colony?.uv.y ?? 0, colony ? MOULD.colonyStrength : 0);
    if (disturbance) u.u_disturbance.value.set(disturbance.uv.x, disturbance.uv.y, disturbance.radiusWorld, disturbance.strength);
    else u.u_disturbance.value.set(0, 0, 0, 0);
    gpu.run(stepPass, mould.write);
    mould.swap();
    surface.pad(mould.read.texture, mould.write);
    mould.swap();
  }

  return {
    id: 'mould',
    paramSchema,
    params,
    get thickness() { return mould.read.texture; },
    thicknessMax: MOULD.thicknessMax,
    get isSeeding() { return colony !== null; },
    reset() {
      gpu.clear(mould.read);
      gpu.clear(mould.write);
      colony = null;
    },
    seed(now, { uv, durationMs }) { colony = { uv, untilMs: now + durationMs }; },
    setFood(sources) { food.set(sources); },
    setDisturbance(next) { disturbance = next; },
    step(now, dt) {
      const steps = Math.max(0, Math.min(8, Math.round(params.stepsPerFrame)));
      for (let s = 0; s < steps; s++) stepOnce(now, dt / steps);
    },
    coverageNear(uvs) { return coverage.near(mould.read.texture, uvs, MOULD.coverageRadiusWorld * sizeScale); },
    countAgents() { return 0; },
    readThickness() { return gpu.readFloats(mould.read); },
    dispose() {
      mould.dispose();
      food.dispose();
      coverage.dispose();
      stepPass.dispose();
    },
  };
}
