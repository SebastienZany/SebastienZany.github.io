// Fixed-point crowd resolve kernel.
// Inputs: u32 atomic impulses after all agents have scattered.
// Output: r32float density ping-pong texture 0.
// Invariants: one invocation owns one texel; density persistence is absent by design.
// Anchors: main.js:17657 clear lifecycle and M3 fixes 4/7.

//#include "common.wgsl"

@group(0) @binding(1) var<storage, read_write> crowdAtomic: array<atomic<u32>>;
@group(0) @binding(2) var crowdOut: texture_storage_2d<r32float, write>;

@compute @workgroup_size(${FIELD_WORKGROUP_SIZE}, ${FIELD_WORKGROUP_SIZE})
fn resolveCrowd(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let size = fieldSize();
  if (invocation.x >= size || invocation.y >= size) { return; }
  let index = invocation.y * size + invocation.x;
  let scale = parameterFloat(${PARAM_SLOT_OAT}u, 3u);
  let density = f32(atomicLoad(&crowdAtomic[index])) / scale;
  textureStore(crowdOut, vec2<i32>(invocation.xy), vec4<f32>(density, 0.0, 0.0, 1.0));
}
