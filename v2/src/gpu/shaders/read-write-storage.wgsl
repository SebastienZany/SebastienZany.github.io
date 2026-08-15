// Contract (M0 extension probe): load then store one r32float storage texel in place.
// Input/output: read_write r32float texture. Units: scalar field value.
// Invariant: compilation and dispatch require readonly_and_readwrite_storage_textures.
requires readonly_and_readwrite_storage_textures;

@group(0) @binding(0) var field: texture_storage_2d<r32float, read_write>;

@compute @workgroup_size(1)
fn main() {
  let value = textureLoad(field, vec2u(0u));
  textureStore(field, vec2u(0u), value + vec4f(1.0, 0.0, 0.0, 0.0));
}
