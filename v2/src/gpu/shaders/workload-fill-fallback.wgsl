// Contract (M0 workload): fill gutters from a copied r32float source into the live field.
// Inputs: immutable staging texture + authoritative donor stencils. Output: live r32float field.
// Units: linear texel indices and unorm16 weights.
// Invariant: source was copied before dispatch, exactly rehearsing the non-extension path.
@group(0) @binding(0) var sourceField: texture_2d<f32>;
@group(0) @binding(1) var outputField: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var<storage, read> records: array<u32>;

fn loadLinear(index: u32, width: u32) -> f32 {
  return textureLoad(sourceField, vec2u(index % width, index / width), 0).x;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let recordIndex = invocation.x;
  if (recordIndex >= ${RECORD_COUNT}u) { return; }
  let base = recordIndex * 7u;
  let dimensions = textureDimensions(outputField);
  let packed01 = records[base + 5u];
  let packed23 = records[base + 6u];
  let weights = vec4f(
    f32(packed01 & 65535u), f32(packed01 >> 16u),
    f32(packed23 & 65535u), f32(packed23 >> 16u)
  ) / 65535.0;
  let value = loadLinear(records[base + 1u], dimensions.x) * weights.x
    + loadLinear(records[base + 2u], dimensions.x) * weights.y
    + loadLinear(records[base + 3u], dimensions.x) * weights.z
    + loadLinear(records[base + 4u], dimensions.x) * weights.w;
  let destination = records[base];
  textureStore(outputField, vec2u(destination % dimensions.x, destination / dimensions.x), vec4f(value, 0.0, 0.0, 0.0));
}
