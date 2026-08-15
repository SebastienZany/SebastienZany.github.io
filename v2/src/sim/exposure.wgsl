// Food-deposit exposure scatter kernel.
// Inputs: final post-birth Agent population and exact finalized count.
// Output: single-texel u32 fixed-point exposure, cleared before dispatch.
// Invariants: texel-snapped is intentional legacy parity for the <=1 px deposit sprite.
// Anchors: main.js:780/17690–17705 and M3 economy field-side contract.

//#include "common.wgsl"

@group(0) @binding(1) var<storage, read> agents: array<Agent>;
@group(0) @binding(2) var<storage, read_write> liveCount: AtomicCount;
@group(0) @binding(3) var<storage, read_write> exposureAtomic: array<atomic<u32>>;

@compute @workgroup_size(${AGENT_WORKGROUP_SIZE})
fn scatterExposure(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let agentIndex = invocation.x;
  if (agentIndex >= atomicLoad(&liveCount.value)) { return; }
  let agent = agents[agentIndex];
  let reserveCap = parameterFloat(${PARAM_SLOT_OAT}u, 2u);
  let densityMass = parameterFloat(${PARAM_SLOT_OAT}u, 1u);
  let amount = clamp(agent.reserve, 0.0, reserveCap) * densityMass;
  let texelPos = texelFromUv(agent.uvPos);
  let index = u32(texelPos.y) * fieldSize() + u32(texelPos.x);
  let scale = parameterFloat(${PARAM_SLOT_FIXED_POINT}u, 1u);
  atomicAdd(&exposureAtomic[index], roundedFixedPoint(amount, scale));
}
