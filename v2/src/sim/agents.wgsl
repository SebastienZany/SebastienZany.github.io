// Survivor advance kernel (allocator phase A).
// Inputs: live Agent set, dynamic/oat/crowd r32float fields, packed parameters.
// Output: surviving parents only, atomically compacted into the next Agent buffer.
// Invariants: countOut starts at zero; survivors<=previous population<=capacity;
// sensing is nearest and every UV read/move wraps on the flat torus.
// Anchors: main.js:3036–3222, M3 semantics and allocator fix 3b.

//#include "common.wgsl"

@group(0) @binding(1) var<storage, read> agentsIn: array<Agent>;
@group(0) @binding(2) var<storage, read_write> agentsOut: array<Agent>;
@group(0) @binding(3) var<storage, read_write> countIn: AtomicCount;
@group(0) @binding(4) var<storage, read_write> countOut: AtomicCount;
@group(0) @binding(5) var dynamicField: texture_2d<f32>;
@group(0) @binding(6) var oatField: texture_2d<f32>;
@group(0) @binding(7) var crowdField: texture_2d<f32>;

fn fieldAt(field: texture_2d<f32>, uvPos: vec2<f32>) -> f32 {
  return max(textureLoad(field, texelFromUv(uvPos), 0).r, 0.0);
}

fn rationedOat(uvPos: vec2<f32>, crowd: f32) -> f32 {
  let oatFood = fieldAt(oatField, uvPos);
  if (!flagEnabled(${PARAM_FLAG_OAT_RATIONING}u) || oatFood <= 0.0) { return oatFood; }
  let densityMass = max(parameterFloat(${PARAM_SLOT_OAT}u, 1u), 0.00001);
  let localReserveLoad = max(crowd / densityMass, 1.0);
  let uptakeRate = parameterFloat(${PARAM_SLOT_ECONOMY}u, 0u);
  let requestedUptake = localReserveLoad * uptakeRate * oatFood;
  let supply = max(parameterFloat(${PARAM_SLOT_OAT}u, 0u), 0.00001);
  let ration = clamp(supply / max(requestedUptake, supply), 0.0, 1.0);
  return oatFood * ration;
}

fn scoreAt(uvPos: vec2<f32>, sampleUvPos: vec2<f32>, reserve: f32) -> f32 {
  let crowd = fieldAt(crowdField, sampleUvPos);
  let food = fieldAt(dynamicField, sampleUvPos) + rationedOat(sampleUvPos, crowd);
  let foodSignal = 1.0 - exp(-1.2 * food); // main.js:3159
  let reproThreshold = parameterFloat(${PARAM_SLOT_MOVEMENT}u, 3u);
  let appetite = 1.0 - smoothstep(reproThreshold * 0.55, reproThreshold * 1.05, reserve);
  let target = max(parameterFloat(${PARAM_SLOT_CROWD}u, 2u), 0.001);
  let densityRatio = max(crowd / target, 0.0);
  let occupiedEnough = smoothstep(0.0, 1.0, densityRatio);
  let crowdRangeMax = max(1.0001, min(3.0, 1.0 / target));
  let tooCrowded = smoothstep(1.0, crowdRangeMax, densityRatio);
  let crowdCurve = max(parameterFloat(${PARAM_SLOT_CROWD}u, 1u), 1.0);
  let superlinearPenalty = tooCrowded * pow(max(densityRatio, 1.0), crowdCurve - 1.0);
  let crowdPreference = occupiedEnough - superlinearPenalty * 2.0;

  var repelPenalty = 0.0;
  if (flagEnabled(${PARAM_FLAG_REPEL_ACTIVE}u)) {
    var repelDelta = wrapUv(sampleUvPos) - parameters.slots[${PARAM_SLOT_REPEL}u].xy;
    repelDelta -= round(repelDelta);
    let radius = parameterFloat(${PARAM_SLOT_REPEL}u, 2u);
    let strength = parameterFloat(${PARAM_SLOT_REPEL}u, 3u);
    let normalizedDistanceSq = dot(repelDelta, repelDelta) / max(radius * radius, 0.0000001);
    repelPenalty = strength * exp(-normalizedDistanceSq * 2.0);
  }
  return parameterFloat(${PARAM_SLOT_ECONOMY}u, 3u) * foodSignal * appetite
    + parameterFloat(${PARAM_SLOT_CROWD}u, 0u) * crowdPreference - repelPenalty;
}

@compute @workgroup_size(${AGENT_WORKGROUP_SIZE})
fn advanceSurvivors(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let sourceIndex = invocation.x;
  if (sourceIndex >= atomicLoad(&countIn.value) || sourceIndex >= capacity()) { return; }
  var agent = agentsIn[sourceIndex];
  if (agent.reserve <= 0.0) { return; }

  let sensorDistance = parameterFloat(${PARAM_SLOT_SENSING}u, 1u);
  let sensorAngle = parameterFloat(${PARAM_SLOT_SENSING}u, 2u);
  let turnAngle = parameterFloat(${PARAM_SLOT_SENSING}u, 3u);
  let wander = parameterFloat(${PARAM_SLOT_MOVEMENT}u, 0u);
  let frontDirection = vec2<f32>(cos(agent.heading), sin(agent.heading));
  let leftDirection = vec2<f32>(cos(agent.heading + sensorAngle), sin(agent.heading + sensorAngle));
  let rightDirection = vec2<f32>(cos(agent.heading - sensorAngle), sin(agent.heading - sensorAngle));
  let front = scoreAt(agent.uvPos, agent.uvPos + frontDirection * sensorDistance, agent.reserve);
  let left = scoreAt(agent.uvPos, agent.uvPos + leftDirection * sensorDistance, agent.reserve);
  let right = scoreAt(agent.uvPos, agent.uvPos + rightDirection * sensorDistance, agent.reserve);
  let stay = scoreAt(agent.uvPos, agent.uvPos, agent.reserve);

  var moveScore = front;
  var angleDelta = (counterRandom(agent.idLo, agent.idHi, 11u) - 0.5) * wander;
  if (left > front && left > right) {
    moveScore = left;
    angleDelta = turnAngle;
  } else if (right > front && right > left) {
    moveScore = right;
    angleDelta = -turnAngle;
  }
  let preference = moveScore - stay;
  let moveScale = max(parameterFloat(${PARAM_SLOT_MOVEMENT}u, 2u), smoothstep(0.0, 0.08, preference));
  agent.heading += angleDelta;
  agent.heading += (counterRandom(agent.idLo, agent.idHi, 23u) - 0.5) * wander * 0.5 * moveScale;
  let direction = vec2<f32>(cos(agent.heading), sin(agent.heading));
  let dt = parameterFloat(${PARAM_SLOT_SENSING}u, 0u);
  agent.uvPos = wrapUv(agent.uvPos + direction * parameterFloat(${PARAM_SLOT_MOVEMENT}u, 1u) * dt * moveScale);

  let localCrowd = fieldAt(crowdField, agent.uvPos);
  let effectiveFood = fieldAt(dynamicField, agent.uvPos) + rationedOat(agent.uvPos, localCrowd);
  let uptakeRate = parameterFloat(${PARAM_SLOT_ECONOMY}u, 0u);
  let depositRate = parameterFloat(${PARAM_SLOT_ECONOMY}u, 1u);
  let burnRate = parameterFloat(${PARAM_SLOT_ECONOMY}u, 2u);
  agent.reserve += (uptakeRate * effectiveFood - depositRate - burnRate) * dt;
  if (agent.reserve <= 0.0) { return; }
  agent.reserve = min(agent.reserve, parameterFloat(${PARAM_SLOT_REPRODUCTION}u, 2u));
  let survivorSlot = atomicAdd(&countOut.value, 1u);
  agentsOut[survivorSlot] = agent;
}
