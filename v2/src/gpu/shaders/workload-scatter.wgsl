// Contract (M0 workload): rehearse fixed-point agent scatter into a full-size atomic buffer.
// Input: synthetic agent invocation. Output: one atomic u32 contribution per agent.
// Units: texel index / fixed-point count. Invariant: indices stay within FIELD_TEXEL_COUNT.
@group(0) @binding(0) var<storage, read_write> scatterField: array<atomic<u32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  if (invocation.x >= ${AGENT_COUNT}u) { return; }
  let texelIndex = (invocation.x * 1664525u + 1013904223u) % ${FIELD_TEXEL_COUNT}u;
  atomicAdd(&scatterField[texelIndex], 300u);
}

