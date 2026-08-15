// Order-independent state hash and non-finite scan kernels.
// Inputs: current Agent set and canonical r32float dynamic field.
// Output: commutative u32 sum/xor accumulators plus a NaN/Inf counter.
// Invariants: slot order never enters an agent hash; atomic sum/xor are associative.
// Anchors: M3 determinism fix 3 and NaN/Inf acceptance gate.

//#include "common.wgsl"

struct StateHash {
  agentSum: atomic<u32>,
  agentXor: atomic<u32>,
  fieldSum: atomic<u32>,
  fieldXor: atomic<u32>,
  nonFinite: atomic<u32>,
  padding0: atomic<u32>,
  padding1: atomic<u32>,
  padding2: atomic<u32>,
}

@group(0) @binding(1) var<storage, read> agents: array<Agent>;
@group(0) @binding(2) var<storage, read_write> liveCount: AtomicCount;
@group(0) @binding(3) var field: texture_2d<f32>;
@group(0) @binding(4) var<storage, read_write> stateHash: StateHash;

@compute @workgroup_size(${AGENT_WORKGROUP_SIZE})
fn hashAgents(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let agentIndex = invocation.x;
  if (agentIndex >= atomicLoad(&liveCount.value)) { return; }
  let agent = agents[agentIndex];
  var hash = pcgHash32(agent.idLo ^ rotateLeft32(agent.idHi, 16u));
  hash = pcgHash32(hash ^ bitcast<u32>(agent.uvPos.x));
  hash = pcgHash32(hash ^ bitcast<u32>(agent.uvPos.y));
  hash = pcgHash32(hash ^ bitcast<u32>(agent.heading));
  hash = pcgHash32(hash ^ bitcast<u32>(agent.reserve));
  hash = pcgHash32(hash ^ agent.flags);
  atomicAdd(&stateHash.agentSum, hash);
  atomicXor(&stateHash.agentXor, rotateLeft32(hash, 13u));
  if (any(isNan(agent.uvPos)) || any(isInf(agent.uvPos))
      || isNan(agent.heading) || isInf(agent.heading)
      || isNan(agent.reserve) || isInf(agent.reserve)) {
    atomicAdd(&stateHash.nonFinite, 1u);
  }
}

@compute @workgroup_size(${FIELD_WORKGROUP_SIZE}, ${FIELD_WORKGROUP_SIZE})
fn hashField(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let size = fieldSize();
  if (invocation.x >= size || invocation.y >= size) { return; }
  let value = textureLoad(field, vec2<i32>(invocation.xy), 0).r;
  let index = invocation.y * size + invocation.x;
  let hash = pcgHash32(bitcast<u32>(value) ^ pcgHash32(index));
  atomicAdd(&stateHash.fieldSum, hash);
  atomicXor(&stateHash.fieldXor, rotateLeft32(hash, 7u));
  if (isNan(value) || isInf(value)) { atomicAdd(&stateHash.nonFinite, 1u); }
}
