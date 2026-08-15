// Iterated crowd filter and final quantization kernels.
// Inputs: nearest-loaded r32float density texture on a flat torus.
// Output: opposite r32float ping-pong texture.
// Invariants: each blur is a genuinely 2D near-isotropic 3x3 pass; variances add;
// quantization happens once after all passes, clamping to saturating RGBA8 parity.
// Anchors: PLAN §1.3 and M3 crowd-field requirements.

//#include "common.wgsl"

@group(0) @binding(1) var crowdIn: texture_2d<f32>;
@group(0) @binding(2) var crowdOut: texture_storage_2d<r32float, write>;

fn crowdAt(texelPos: vec2<i32>) -> f32 {
  return max(textureLoad(crowdIn, wrapTexel(texelPos), 0).r, 0.0);
}

@compute @workgroup_size(${FIELD_WORKGROUP_SIZE}, ${FIELD_WORKGROUP_SIZE})
fn blurCrowd(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let size = fieldSize();
  if (invocation.x >= size || invocation.y >= size) { return; }
  let texelPos = vec2<i32>(invocation.xy);
  let center = crowdAt(texelPos);
  var weighted = 0.0;
  for (var offsetY = -1; offsetY <= 1; offsetY += 1) {
    let weightY = select(1.0, 2.0, offsetY == 0);
    for (var offsetX = -1; offsetX <= 1; offsetX += 1) {
      let weightX = select(1.0, 2.0, offsetX == 0);
      weighted += crowdAt(texelPos + vec2<i32>(offsetX, offsetY)) * weightX * weightY;
    }
  }
  let filtered = weighted * (1.0 / 16.0);
  let alpha = parameterFloat(${PARAM_SLOT_CROWD_KERNEL}u, 3u);
  textureStore(crowdOut, texelPos, vec4<f32>(mix(center, filtered, alpha), 0.0, 0.0, 1.0));
}

@compute @workgroup_size(${FIELD_WORKGROUP_SIZE}, ${FIELD_WORKGROUP_SIZE})
fn quantizeCrowd(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let size = fieldSize();
  if (invocation.x >= size || invocation.y >= size) { return; }
  let texelPos = vec2<i32>(invocation.xy);
  var density = clamp(textureLoad(crowdIn, texelPos, 0).r, 0.0, 1.0);
  if (!flagEnabled(${PARAM_FLAG_CROWD_FLOAT}u)) { density = round(density * 255.0) / 255.0; }
  textureStore(crowdOut, texelPos, vec4<f32>(density, 0.0, 0.0, 1.0));
}
