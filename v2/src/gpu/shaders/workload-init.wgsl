// Contract (M0 workload): initialize an r32float rehearsal field with deterministic noise.
// Output: one scalar per texel. Units: normalized field value.
// Invariant: every in-bounds texel is written exactly once.
@group(0) @binding(0) var outputField: texture_storage_2d<r32float, write>;

fn hash(value: u32) -> u32 {
  var mixed = value;
  mixed = (mixed ^ 61u) ^ (mixed >> 16u);
  mixed = mixed * 9u;
  mixed = mixed ^ (mixed >> 4u);
  mixed = mixed * 0x27d4eb2du;
  return mixed ^ (mixed >> 15u);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let dimensions = textureDimensions(outputField);
  if (any(invocation.xy >= dimensions)) { return; }
  let linearIndex = invocation.y * dimensions.x + invocation.x;
  let noise = f32(hash(linearIndex) & 65535u) / 65535.0;
  textureStore(outputField, invocation.xy, vec4f(noise, 0.0, 0.0, 0.0));
}

