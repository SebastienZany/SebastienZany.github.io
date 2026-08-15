// Contract (M0 workload): fill gutter texels in place from authoritative donor stencils.
// Input/output: read_write r32float field; input: 28-byte records (dst, four donors, weights).
// Units: linear texel indices and unorm16 weights.
// Invariant: every donor index designates an authoritative texel, so reads cannot race writes.
enable readonly_and_readwrite_storage_textures;

@group(0) @binding(0) var field: texture_storage_2d<r32float, read_write>;
@group(0) @binding(1) var<storage, read> records: array<u32>;

fn loadLinear(index: u32, width: u32) -> f32 {
  return textureLoad(field, vec2u(index % width, index / width)).x;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let recordIndex = invocation.x;
  if (recordIndex >= ${RECORD_COUNT}u) { return; }
  let base = recordIndex * 7u;
  let dimensions = textureDimensions(field);
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
  textureStore(field, vec2u(destination % dimensions.x, destination / dimensions.x), vec4f(value, 0.0, 0.0, 0.0));
}
