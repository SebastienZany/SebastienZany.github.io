// Shaders of the physarum model.
//
// State lives in textures:
//   agents  one texel per agent slot: xy = atlas position, z = heading (radians,
//           in atlas space), w = reserve (energy). w <= 0 marks an empty slot.
//   trail   the slime itself: red = thickness on that atlas texel.
//   food    red = food offered by oats on that texel.
//   crowd   red = how much agent "mass" is near that texel.
//   deposit red = agent mass standing exactly on that texel this step.
//
// One step: measure the crowd, move every agent (ADVANCE), let well-fed agents
// bud into empty slots (ALLOCATE), then update the trail from where the agents
// now stand (TRAIL).

import { SURFACE_GLSL } from '../../surface/surface-glsl.js';
import { PHYSARUM } from './params.js';

const f = (value) => Number(value).toFixed(6);

// Shared by ADVANCE and ALLOCATE: how an agent senses, moves and buds.
const AGENT_BEHAVIOUR = /* glsl */ `
uniform sampler2D u_trail;
uniform sampler2D u_food;
uniform sampler2D u_crowd;
uniform int u_agentSide;
uniform float u_time;
uniform float u_dt;
uniform float u_stepWorld;
uniform float u_size;           // the game's slime size: scales the fixed distances below
uniform float u_minMoveScale;
uniform float u_uptakeRate;
uniform float u_depositRate;
uniform float u_burnRate;
uniform float u_reproThreshold;
uniform float u_foodWeight;
uniform float u_crowdWeight;
uniform float u_crowdExponent;
uniform float u_densityTarget;
uniform float u_oatSupplyRate;
uniform int u_useOatRationing;
uniform vec2 u_disturbanceUv;
uniform float u_disturbanceRadiusWorld;
uniform float u_disturbanceStrength;
${SURFACE_GLSL}

const float SENSOR_DISTANCE = ${f(PHYSARUM.sensorDistanceWorld)};
const float SENSOR_ANGLE = ${f(PHYSARUM.sensorAngleRad)};
const float TURN_ANGLE = ${f(PHYSARUM.turnAngleRad)};
const float WANDER = ${f(PHYSARUM.wanderRad)};
const float REPRO_ANGLE = ${f(PHYSARUM.reproAngleRad)};
const float CHILD_STEP = ${f(PHYSARUM.childStepWorld)};
const float MAX_RESERVE = ${f(PHYSARUM.maxReserve)};
const float CROWD_MASS_SCALE = ${f(PHYSARUM.crowdMassScale)};
const float OFF_BODY_SCORE = -100000.0;

float hash(float n) {
  return fract(sin(n * 127.1 + u_time * 41.7) * 43758.5453123);
}
vec2 heading(float angle) {
  return vec2(cos(angle), sin(angle));
}

// An oat cannot feed an unlimited crowd: when rationing is on, the food each
// agent sees shrinks as more agent mass gathers on the same spot.
float rationedOatFood(float oatFood, float crowd) {
  if (u_useOatRationing == 0 || oatFood <= 0.0) return oatFood;
  float load = max(crowd / CROWD_MASS_SCALE, 1.0);
  float requested = load * u_uptakeRate * oatFood;
  float supply = max(u_oatSupplyRate, 0.00001);
  return oatFood * clamp(supply / max(requested, supply), 0.0, 1.0);
}

// How attractive the point toUv looks to an agent standing at fromUv.
float scoreAt(vec2 fromUv, vec2 toUv, float reserve) {
  vec2 p;
  float turn;
  if (!surfaceReach(fromUv, toUv, p, turn)) return OFF_BODY_SCORE;

  float crowd = texture(u_crowd, p).r;
  float food = max(texture(u_trail, p).r, 0.0) + rationedOatFood(max(texture(u_food, p).r, 0.0), crowd);
  float foodSignal = 1.0 - exp(-food * 1.2);
  // A nearly full agent stops caring about food.
  float appetite = 1.0 - smoothstep(u_reproThreshold * 0.55, u_reproThreshold * 1.05, reserve);

  // Agents like some company and dislike a crush.
  float target = max(u_densityTarget, 0.001);
  float ratio = max(crowd / target, 0.0);
  float company = smoothstep(0.0, 1.0, ratio);
  float crush = smoothstep(1.0, max(1.0001, min(3.0, 1.0 / target)), ratio);
  float crowdPreference = company - crush * pow(max(ratio, 1.0), max(u_crowdExponent, 1.0) - 1.0) * 2.0;

  float disturbance = 0.0;
  if (u_disturbanceStrength > 0.0 && u_disturbanceRadiusWorld > 0.0) {
    float d = worldLength(surfaceMetric(p), p - u_disturbanceUv) / u_disturbanceRadiusWorld;
    disturbance = u_disturbanceStrength * exp(-d * d * 2.0);
  }
  return u_foodWeight * foodSignal * appetite + u_crowdWeight * crowdPreference - disturbance;
}

// One step of one agent: look ahead, left and right, turn toward the best,
// move, then eat and pay the cost of living.
vec4 advance(vec4 agent, float seed) {
  if (agent.w <= 0.0) return vec4(0.0);
  vec2 pos = agent.xy;
  float angle = agent.z;
  if (!onSurface(pos)) return vec4(0.0);
  vec4 metric = surfaceMetric(pos);

  float front = scoreAt(pos, pos + surfaceStep(metric, heading(angle), SENSOR_DISTANCE * u_size), agent.w);
  float left = scoreAt(pos, pos + surfaceStep(metric, heading(angle + SENSOR_ANGLE), SENSOR_DISTANCE * u_size), agent.w);
  float right = scoreAt(pos, pos + surfaceStep(metric, heading(angle - SENSOR_ANGLE), SENSOR_DISTANCE * u_size), agent.w);
  float stay = scoreAt(pos, pos, agent.w);

  float best = front;
  float turn = (hash(seed + 11.0) - 0.5) * WANDER;
  if (left > front && left > right) {
    best = left;
    turn = TURN_ANGLE;
  } else if (right > front && right > left) {
    best = right;
    turn = -TURN_ANGLE;
  }
  // Slow down where nowhere nearby is better than here.
  float moveScale = max(u_minMoveScale, smoothstep(0.0, 0.08, best - stay));
  angle += turn + (hash(seed + 23.0) - 0.5) * WANDER * 0.5 * moveScale;

  vec2 next;
  float crossingTurn;
  if (surfaceReach(pos, pos + surfaceStep(metric, heading(angle), u_stepWorld * u_dt * moveScale), next, crossingTurn)) {
    angle += crossingTurn;
  } else {
    // Blocked by the edge of the body: stay put and turn away.
    next = pos;
    angle += (hash(seed + 59.0) < 0.5 ? -1.0 : 1.0) * TURN_ANGLE;
  }

  float crowd = texture(u_crowd, next).r;
  float food = max(texture(u_trail, next).r, 0.0) + rationedOatFood(max(texture(u_food, next).r, 0.0), crowd);
  float reserve = agent.w + (u_uptakeRate * food - u_depositRate - u_burnRate) * u_dt;
  if (reserve <= 0.0) return vec4(0.0);
  return vec4(next, angle, min(reserve, MAX_RESERVE));
}

// The child a parent would bud on one side (0 = left, 1 = right). It starts a
// short step away, heading outward, with a quarter of the parent's reserve.
vec4 childOf(vec4 parent, int side, float seed, out bool viable) {
  viable = false;
  if (parent.w <= u_reproThreshold) return vec4(0.0);
  float angle = parent.z + (side == 0 ? 1.0 : -1.0) * REPRO_ANGLE + (hash(seed + 37.0) - 0.5) * 0.18;
  vec2 at;
  float crossingTurn;
  if (!surfaceReach(parent.xy, parent.xy + surfaceStep(surfaceMetric(parent.xy), heading(angle), CHILD_STEP * u_size), at, crossingTurn)) {
    return vec4(0.0);
  }
  viable = true;
  return vec4(at, angle + crossingTurn, parent.w * 0.25);
}
`;

export const ADVANCE_FRAGMENT = /* glsl */ `
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_agents;
${AGENT_BEHAVIOUR}
void main() {
  ivec2 slot = ivec2(gl_FragCoord.xy);
  outColor = advance(texelFetch(u_agents, slot, 0), float(slot.y * u_agentSide + slot.x));
}
`;

// Budding without sorting. Each step pairs every slot with two other slots by
// two cyclic shifts that change every step. A parent may place its left child
// in its first partner slot and its right child in its second, if that slot is
// empty. Both the parent (which pays for the child) and the empty slot (which
// becomes the child) evaluate the same rule, so they always agree.
export const ALLOCATE_FRAGMENT = /* glsl */ `
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_advanced;
uniform sampler2D u_colony;
uniform ivec2 u_shift;
// While a colony is being released, its slots [0, u_colonyReserved) are kept
// for it, and slots in [u_colonyRelease.x, u_colonyRelease.y) are filled now.
uniform float u_colonyReserved;
uniform vec2 u_colonyRelease;
${AGENT_BEHAVIOUR}

int capacity() { return u_agentSide * u_agentSide; }
vec4 slotAt(int index) {
  return texelFetch(u_advanced, ivec2(index % u_agentSide, index / u_agentSide), 0);
}
bool isFree(int index) {
  return slotAt(index).w <= 0.0 && float(index) >= u_colonyReserved;
}
int partnerSlot(int parent, int side) { return (parent + u_shift[side]) % capacity(); }
int partnerParent(int slot, int side) { return (slot - u_shift[side] + capacity()) % capacity(); }
vec4 proposal(int parent, int side, out bool viable) {
  return childOf(slotAt(parent), side, float(parent * 2 + side + 1), viable);
}
// A left child always beats a right child competing for the same slot.
bool leftChildTakes(int slot) {
  bool viable;
  proposal(partnerParent(slot, 0), 0, viable);
  return viable;
}

void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  int index = pixel.y * u_agentSide + pixel.x;
  vec4 self = slotAt(index);

  if (self.w > 0.0) {
    // A living agent keeps its slot and pays a quarter of its reserve per child placed.
    float placed = 0.0;
    for (int side = 0; side < 2; side++) {
      int slot = partnerSlot(index, side);
      if (!isFree(slot)) continue;
      bool viable;
      proposal(index, side, viable);
      if (viable && (side == 0 || !leftChildTakes(slot))) placed += 1.0;
    }
    self.w = max(self.w - placed * self.w * 0.25, 0.0);
    outColor = self.w > 0.0 ? self : vec4(0.0);
    return;
  }

  float slotNumber = float(index);
  if (slotNumber >= u_colonyRelease.x && slotNumber < u_colonyRelease.y) {
    outColor = texelFetch(u_colony, pixel, 0);
    return;
  }
  if (slotNumber < u_colonyReserved) {
    outColor = vec4(0.0);
    return;
  }
  for (int side = 0; side < 2; side++) {
    bool viable;
    vec4 child = proposal(partnerParent(index, side), side, viable);
    if (viable) {
      outColor = child;
      return;
    }
  }
  outColor = vec4(0.0);
}
`;

// Agents drawn as points into the atlas. u_pointWorld > 0 draws a soft disc of
// that world diameter (the crowd map); u_pointWorld == 0 marks the single texel
// the agent stands on, weighted so that the same agents lay the same amount of
// trail per unit of skin whatever the local texel size (the deposit map).
export const SPLAT_VERTEX = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
in vec3 position;
flat out float v_mass;
uniform sampler2D u_agents;
uniform int u_agentSide;
uniform float u_pointWorld;
uniform float u_texelWorld;          // mean world size of a texel of this atlas
uniform float u_referenceTexelWorld; // texel size the deposit amounts were tuned for
${SURFACE_GLSL}
void main() {
  vec4 agent = texelFetch(u_agents, ivec2(gl_VertexID % u_agentSide, gl_VertexID / u_agentSide), 0);
  if (agent.w <= 0.0 || !onSurface(agent.xy)) {
    v_mass = 0.0;
    gl_PointSize = 0.0;
    gl_Position = vec4(-2.0, -2.0, 0.0, 1.0);
    return;
  }
  float localTexelWorld = u_texelWorld * sqrt(texelArea(surfaceMetric(agent.xy)));
  float mass = min(agent.w, ${f(PHYSARUM.crowdMassCap)}) * ${f(PHYSARUM.crowdMassScale)};
  if (u_pointWorld > 0.0) {
    v_mass = mass;
    gl_PointSize = clamp(u_pointWorld / localTexelWorld, 1.0, 64.0);
    gl_Position = vec4(agent.xy * 2.0 - 1.0, 0.0, 1.0);
  } else {
    float ratio = u_referenceTexelWorld / localTexelWorld;
    v_mass = mass * min(ratio * ratio, 16.0);
    // A one-texel point lands on the agent's texel; the fragment shader's soft
    // disc then weights it by how near the agent is to the texel's centre.
    gl_PointSize = 1.0;
    gl_Position = vec4(agent.xy * 2.0 - 1.0, 0.0, 1.0);
  }
}
`;
export const SPLAT_FRAGMENT = /* glsl */ `
precision highp float;
flat in float v_mass;
out vec4 outColor;
void main() {
  vec2 fromCentre = gl_PointCoord * 2.0 - 1.0;
  float distSq = dot(fromCentre, fromCentre);
  if (v_mass <= 0.0 || distSq > 1.0) discard;
  outColor = vec4(smoothstep(1.0, 0.0, distSq) * v_mass, 0.0, 0.0, 1.0);
}
`;

// A crowd disc drawn near a cut spills off the body instead of reaching the
// skin on the far side. Fold each texel's spill back in from across the cut.
export const CROWD_FOLD_FRAGMENT = /* glsl */ `
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_crowdRaw;
${SURFACE_GLSL}
void main() {
  if (!onSurface(v_uv)) {
    outColor = vec4(0.0);
    return;
  }
  float crowd = texture(u_crowdRaw, v_uv).r;
  vec4 seam = texture(u_surfaceSeam, v_uv);
  if (dot(seam.xy, seam.xy) > 0.0) {
    vec2 beyond = vec2(seam.x * v_uv.x - seam.y * v_uv.y, seam.y * v_uv.x + seam.x * v_uv.y) + seam.zw;
    if (insideAtlas(beyond) && !onSurface(beyond)) crowd += texture(u_crowdRaw, beyond).r;
  }
  outColor = vec4(min(crowd, 1.0), 0.0, 0.0, 1.0);
}
`;

// The trail spreads a little, fades a little, is eaten where agents stand and
// is laid down where agents stand.
export const TRAIL_FRAGMENT = /* glsl */ `
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_trail;      // padded: texels just off the body hold their far-side values
uniform sampler2D u_deposit;
uniform vec2 u_texel;
uniform float u_diffusion;
uniform float u_decay;
uniform float u_clamp;
uniform float u_uptakeRate;
uniform float u_depositRate;
uniform float u_dt;
uniform float u_texelWorld;
uniform float u_referenceTexelWorld;
${SURFACE_GLSL}
void main() {
  if (!onSurface(v_uv)) {
    outColor = vec4(0.0);
    return;
  }
  float centre = max(texture(u_trail, v_uv).r, 0.0);
  float around = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      around += max(texture(u_trail, v_uv + vec2(float(dx), float(dy)) * u_texel).r, 0.0);
    }
  }
  // Spreading is tuned per texel of the reference atlas; where texels cover
  // more skin the same spread is a smaller fraction of a texel.
  float ratio = u_referenceTexelWorld / (u_texelWorld * sqrt(texelArea(surfaceMetric(v_uv))));
  float spread = clamp(u_diffusion * ratio * ratio, 0.0, 0.9);
  float trail = clamp(mix(centre, around * 0.125, spread) * u_decay, 0.0, u_clamp);

  float load = min(max(texture(u_deposit, v_uv).r, 0.0) / ${f(PHYSARUM.crowdMassScale)}, ${f(PHYSARUM.crowdMassCap)});
  float exposure = load * ${f(PHYSARUM.deltaScale)} * u_dt;
  float laid = u_depositRate * exposure;
  float eaten = trail * (1.0 - exp(-u_uptakeRate * exposure));
  outColor = vec4(clamp(trail + laid - eaten, 0.0, u_clamp), 0.0, 0.0, 1.0);
}
`;
