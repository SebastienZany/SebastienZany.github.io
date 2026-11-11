// The physarum model: a colony of simple agents that follow food and each
// other's trail, lay trail where they walk, bud when well fed and starve when
// not. This is the organism of the original game. shaders.js has the rules;
// this file owns the textures and runs the steps.

import * as THREE from 'three';
import { paramSchema, defaultParams, PHYSARUM } from './params.js';
import {
  ADVANCE_FRAGMENT, ALLOCATE_FRAGMENT, SPLAT_VERTEX, SPLAT_FRAGMENT, CROWD_FOLD_FRAGMENT, TRAIL_FRAGMENT,
} from './shaders.js';
import { createFoodField } from '../shared/food-field.js';
import { createCoverageProbe } from '../shared/coverage-probe.js';

/** @returns {import('../model.js').SlimeModel} */
export function createPhysarum({ gpu, surface, diag, sizeScale = 1, random = Math.random }) {
  const size = surface.fieldSize;
  const agentSide = size / 2;
  const capacity = agentSide * agentSide;
  const params = defaultParams();
  const surfaceUniforms = surface.uniforms();
  // Per-texel amounts were tuned for texels of a set world size; a smaller slime wants proportionally smaller ones.
  const referenceTexelWorld = PHYSARUM.referenceTexelWorld * sizeScale;

  // --- state ------------------------------------------------------------------
  const agents = gpu.pair(agentSide, agentSide, { type: 'float', name: 'agents' });
  const advanced = gpu.target(agentSide, agentSide, { type: 'float', name: 'agents-advanced' });
  const trail = gpu.pair(size, size, { type: 'float', filter: 'linear', name: 'trail' });
  const food = createFoodField({ gpu, surface });
  const crowdRaw = gpu.target(size, size, { type: 'byte', name: 'crowd-raw' });
  const crowd = gpu.target(size, size, { type: 'byte', name: 'crowd' });
  const deposit = gpu.blendableTarget(size, size, { name: 'deposit' });
  const coverage = createCoverageProbe({ gpu, surface });

  const colonyData = new Float32Array(capacity * 4);
  const colonyTexture = new THREE.DataTexture(colonyData, agentSide, agentSide, THREE.RGBAFormat, THREE.FloatType);
  colonyTexture.minFilter = THREE.NearestFilter;
  colonyTexture.magFilter = THREE.NearestFilter;
  let colony = null; // { startedAtMs, durationMs, count, released } while a colony is being released

  let disturbance = null;
  let stepCount = 0;

  // --- passes -----------------------------------------------------------------
  const behaviourUniforms = () => ({
    u_trail: null, u_food: food.texture, u_crowd: crowd.texture,
    u_agentSide: agentSide, u_time: 0, u_dt: 1,
    u_stepWorld: 0, u_size: sizeScale, u_minMoveScale: 0, u_uptakeRate: 0, u_depositRate: 0, u_burnRate: 0,
    u_reproThreshold: 0, u_foodWeight: 0, u_crowdWeight: 0, u_crowdExponent: 1, u_densityTarget: 0,
    u_oatSupplyRate: 0, u_useOatRationing: 0,
    u_disturbanceUv: new THREE.Vector2(), u_disturbanceRadiusWorld: 0, u_disturbanceStrength: 0,
    ...surfaceUniforms,
  });
  const advancePass = gpu.material(ADVANCE_FRAGMENT, { u_agents: null, ...behaviourUniforms() });
  const allocatePass = gpu.material(ALLOCATE_FRAGMENT, {
    u_advanced: advanced.texture, u_colony: colonyTexture,
    u_shift: new THREE.Vector2(1, 2), u_colonyReserved: 0, u_colonyRelease: new THREE.Vector2(0, 0),
    ...behaviourUniforms(),
  });
  const crowdFoldPass = gpu.material(CROWD_FOLD_FRAGMENT, { u_crowdRaw: crowdRaw.texture, ...surfaceUniforms });
  const trailPass = gpu.material(TRAIL_FRAGMENT, {
    u_trail: null, u_deposit: deposit.texture, u_texel: new THREE.Vector2(1 / size, 1 / size),
    u_diffusion: 0, u_decay: 1, u_clamp: 1, u_uptakeRate: 0, u_depositRate: 0, u_dt: 1,
    u_texelWorld: surface.texelWorld, u_referenceTexelWorld: referenceTexelWorld,
    ...surfaceUniforms,
  });

  // Every agent slot drawn as one point; empty slots are thrown off-screen.
  const splatUniforms = {
    u_agents: { value: null }, u_agentSide: { value: agentSide },
    u_pointWorld: { value: 0 }, u_texelWorld: { value: surface.texelWorld },
    u_referenceTexelWorld: { value: referenceTexelWorld },
    u_surfaceMetric: { value: surfaceUniforms.u_surfaceMetric }, u_surfaceSeam: { value: surfaceUniforms.u_surfaceSeam },
  };
  const splatMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: SPLAT_VERTEX,
    fragmentShader: SPLAT_FRAGMENT,
    uniforms: splatUniforms,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
  const splatGeometry = new THREE.BufferGeometry();
  splatGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
  const splatPoints = new THREE.Points(splatGeometry, splatMaterial);
  splatPoints.frustumCulled = false;
  const splatScene = new THREE.Scene();
  splatScene.add(splatPoints);

  function splat(target, pointWorld) {
    splatUniforms.u_agents.value = agents.read.texture;
    splatUniforms.u_pointWorld.value = pointWorld;
    gpu.draw(splatScene, target);
  }

  function setBehaviourUniforms(pass, now, dt) {
    const u = pass.uniforms;
    u.u_trail.value = trail.read.texture;
    u.u_time.value = now * 0.001;
    u.u_dt.value = dt;
    u.u_stepWorld.value = params.stepWorld * sizeScale;
    u.u_minMoveScale.value = params.minMoveScale;
    u.u_uptakeRate.value = params.uptakeRate;
    u.u_depositRate.value = params.depositRate;
    u.u_burnRate.value = params.burnRate;
    u.u_reproThreshold.value = params.reproThreshold;
    u.u_foodWeight.value = params.foodWeight;
    u.u_crowdWeight.value = params.crowdWeight;
    u.u_crowdExponent.value = params.crowdExponent;
    u.u_densityTarget.value = params.densityTarget;
    u.u_oatSupplyRate.value = params.oatSupplyRate;
    u.u_useOatRationing.value = params.useOatRationing ? 1 : 0;
    if (disturbance) {
      u.u_disturbanceUv.value.set(disturbance.uv.x, disturbance.uv.y);
      u.u_disturbanceRadiusWorld.value = disturbance.radiusWorld;
      u.u_disturbanceStrength.value = disturbance.strength;
    } else {
      u.u_disturbanceStrength.value = 0;
    }
  }

  // Which colony slots to release this step, as [from, to).
  function colonyRelease(now) {
    if (!colony) return { reserved: 0, from: 0, to: 0 };
    const progress = colony.durationMs <= 0 ? 1 : Math.min(1, Math.max(0, (now - colony.startedAtMs) / colony.durationMs));
    const from = colony.released;
    const to = Math.floor(colony.count * progress);
    const reserved = colony.count;
    colony.released = to;
    if (progress >= 1) colony = null;
    return { reserved, from, to };
  }

  function stepOnce(now, dt) {
    food.refresh();
    splat(crowdRaw, params.crowdKernelWorld * sizeScale);
    gpu.run(crowdFoldPass, crowd);

    setBehaviourUniforms(advancePass, now, dt);
    advancePass.uniforms.u_agents.value = agents.read.texture;
    gpu.run(advancePass, advanced);

    setBehaviourUniforms(allocatePass, now, dt);
    // Two different non-zero shifts, new every step, so over time every pair of slots meets.
    const shiftA = 1 + Math.floor(random() * (capacity - 1));
    let shiftB = 1 + Math.floor(random() * (capacity - 1));
    if (shiftB === shiftA) shiftB = (shiftA % (capacity - 1)) + 1;
    allocatePass.uniforms.u_shift.value.set(shiftA, shiftB);
    const release = colonyRelease(now);
    allocatePass.uniforms.u_colonyReserved.value = release.reserved;
    allocatePass.uniforms.u_colonyRelease.value.set(release.from, release.to);
    gpu.run(allocatePass, agents.write);
    agents.swap();

    splat(deposit, 0);
    const t = trailPass.uniforms;
    t.u_trail.value = trail.read.texture;
    t.u_diffusion.value = params.fieldDiffusion;
    t.u_decay.value = params.fieldDecay;
    t.u_clamp.value = params.foodClamp;
    t.u_uptakeRate.value = params.uptakeRate;
    t.u_depositRate.value = params.depositRate;
    t.u_dt.value = dt;
    gpu.run(trailPass, trail.write);
    trail.swap();
    // Give the texels just off the body their far-side values, so the next
    // step's neighbour reads and the display's filtering need no special cases.
    surface.pad(trail.read.texture, trail.write);
    trail.swap();
    stepCount++;
  }

  function buildColony(uv) {
    colonyData.fill(0);
    // Atlas offsets that are one world unit long along each atlas axis, here.
    const uPerWorld = 1 / Math.max(surface.worldDistance(uv, { x: uv.x + 1, y: uv.y }), 1e-6);
    const vPerWorld = 1 / Math.max(surface.worldDistance(uv, { x: uv.x, y: uv.y + 1 }), 1e-6);
    let placedAtCentre = 0;
    for (let i = 0; i < PHYSARUM.colonySize; i++) {
      let at = uv;
      for (let attempt = 0; attempt < PHYSARUM.colonyPlacementTries; attempt++) {
        // A normally distributed offset (Box-Muller).
        const radius = Math.sqrt(-2 * Math.log(Math.max(random(), Number.EPSILON))) * PHYSARUM.colonySpreadWorld * sizeScale;
        const angle = 2 * Math.PI * random();
        const candidate = { x: uv.x + Math.cos(angle) * radius * uPerWorld, y: uv.y + Math.sin(angle) * radius * vPerWorld };
        if (surface.isOnBody(candidate)) {
          at = candidate;
          break;
        }
      }
      if (at === uv) placedAtCentre++;
      colonyData.set([at.x, at.y, random() * 2 * Math.PI, PHYSARUM.colonyReserveMin + random() * PHYSARUM.colonyReserveSpan], i * 4);
    }
    colonyTexture.needsUpdate = true;
    if (placedAtCentre > PHYSARUM.colonySize / 4) diag.log('slime', `colony: ${placedAtCentre} agents fell back to the centre point`);
  }

  return {
    id: 'physarum',
    paramSchema,
    params,
    get thickness() { return trail.read.texture; },
    get thicknessMax() { return params.foodClamp; },
    get isSeeding() { return colony !== null; },

    reset() {
      for (const target of [agents.read, agents.write, advanced, trail.read, trail.write, crowdRaw, crowd, deposit]) gpu.clear(target);
      colony = null;
    },

    seed(now, { uv, durationMs }) {
      if (!surface.isOnBody(uv)) {
        diag.log('slime', 'seed point is off the body; no colony released');
        return;
      }
      buildColony(uv);
      colony = { startedAtMs: now, durationMs, count: PHYSARUM.colonySize, released: 0 };
    },

    setFood(sources) {
      food.set(sources);
    },

    setDisturbance(next) {
      disturbance = next;
    },

    step(now, dt) {
      const steps = Math.max(0, Math.min(8, Math.round(params.simulationSteps)));
      for (let s = 0; s < steps; s++) stepOnce(now + (s * dt * 16.6667) / steps, dt / steps);
    },

    coverageNear(uvs) {
      return coverage.near(trail.read.texture, uvs, PHYSARUM.coverageRadiusWorld * sizeScale);
    },

    /** Dev statistic: reads every agent back from the GPU. Slow. */
    countAgents() {
      const texels = gpu.readFloats(agents.read);
      let alive = 0;
      for (let i = 3; i < texels.length; i += 4) if (texels[i] > 0) alive++;
      return alive;
    },

    /** Dev statistic: the thickness texture read back as RGBA floats (red = thickness). Slow. */
    readThickness() { return gpu.readFloats(trail.read); },

    get stepCount() { return stepCount; },

    dispose() {
      for (const part of [advanced, crowdRaw, crowd, deposit, food, coverage]) part.dispose();
      agents.dispose();
      trail.dispose();
      colonyTexture.dispose();
      splatGeometry.dispose();
      for (const pass of [advancePass, allocatePass, crowdFoldPass, trailPass, splatMaterial]) pass.dispose();
    },
  };
}
