// Contract (M0 format probe): prove a declared format can be storage-written.
// Output: one ${FORMAT} texel. Units: diagnostic scalar.
// Invariant: host supplies a matching explicit storage-texture layout.
@group(0) @binding(0) var target: texture_storage_2d<${FORMAT}, write>;

@compute @workgroup_size(1)
fn main() {
  textureStore(target, vec2u(0u), vec4f(0.25, 0.5, 0.75, 1.0));
}
