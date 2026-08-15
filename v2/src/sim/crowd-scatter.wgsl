// Crowd scatter kernel.
// Inputs: final/current Agent set and exact atomic population count.
// Output: u32 fixed-point atomic density impulses, cleared before dispatch.
// Invariants: pointSize<=1 is texel-snapped; moving sprites scatter bilinearly;
// peak semantics scale total impulse by the legacy disc integral.
// Anchors: main.js:769–773/3550–3603, PLAN §1.3, M3 profile contract.

//#include "common.wgsl"

@group(0) @binding(1) var<storage, read> agents: array<Agent>;
@group(0) @binding(2) var<storage, read_write> liveCount: AtomicCount;
@group(0) @binding(3) var<storage, read_write> crowdAtomic: array<atomic<u32>>;

fn addCrowd(texelPos: vec2<i32>, amount: f32) {
  let wrapped = wrapTexel(texelPos);
  let index = u32(wrapped.y) * fieldSize() + u32(wrapped.x);
  let scale = parameterFloat(${PARAM_SLOT_FIXED_POINT}u, 0u);
  atomicAdd(&crowdAtomic[index], roundedFixedPoint(amount, scale));
}

@compute @workgroup_size(${AGENT_WORKGROUP_SIZE})
fn scatterCrowd(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let agentIndex = invocation.x;
  if (agentIndex >= atomicLoad(&liveCount.value)) { return; }
  let agent = agents[agentIndex];
  let densityMass = parameterFloat(${PARAM_SLOT_OAT}u, 1u);
  let reserveCap = parameterFloat(${PARAM_SLOT_OAT}u, 2u);
  let peak = clamp(agent.reserve, 0.0, reserveCap) * densityMass;
  let pointSizeTexels = parameterFloat(${PARAM_SLOT_CROWD_KERNEL}u, 0u);
  if (pointSizeTexels <= 1.0) {
    addCrowd(texelFromUv(agent.uvPos), peak);
    return;
  }

  let texelPos = wrapUv(agent.uvPos) * f32(fieldSize()) - vec2<f32>(0.5);
  let base = vec2<i32>(floor(texelPos));
  let fraction = fract(texelPos);
  let mass = peak * parameterFloat(${PARAM_SLOT_CROWD_KERNEL}u, 2u);
  addCrowd(base, mass * (1.0 - fraction.x) * (1.0 - fraction.y));
  addCrowd(base + vec2<i32>(1, 0), mass * fraction.x * (1.0 - fraction.y));
  addCrowd(base + vec2<i32>(0, 1), mass * (1.0 - fraction.x) * fraction.y);
  addCrowd(base + vec2<i32>(1, 1), mass * fraction.x * fraction.y);
}
