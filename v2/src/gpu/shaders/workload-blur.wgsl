// Contract (M0 workload): one near-isotropic 3×3 scalar-field blur pass.
// Input: immutable r32float texture. Output: separate r32float storage texture.
// Units: texel-space radius 1. Invariant: host refills gutters before another pass consumes it.
@group(0) @binding(0) var sourceField: texture_2d<f32>;
@group(0) @binding(1) var outputField: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  let dimensions = textureDimensions(outputField);
  if (any(invocation.xy >= dimensions)) { return; }
  var sum = 0.0;
  for (var offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (var offsetX = -1; offsetX <= 1; offsetX += 1) {
      let sourcePos = clamp(vec2i(invocation.xy) + vec2i(offsetX, offsetY), vec2i(0), vec2i(dimensions) - 1);
      sum += textureLoad(sourceField, sourcePos, 0).x;
    }
  }
  textureStore(outputField, invocation.xy, vec4f(sum / 9.0, 0.0, 0.0, 0.0));
}

