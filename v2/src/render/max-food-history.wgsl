// Running maximum pass (F2 material-look lane; main.js:2972-2998 semantics).
// Inputs: current r32float display history and previous r32float running maximum.
// Output: next r32float running maximum in field-value units.
// Invariants: negative input is treated as zero; the result never decreases; fixtures fill the full domain.

@group(0) @binding(0) var currentDisplayField: texture_2d<f32>;
@group(0) @binding(1) var previousMaximum: texture_2d<f32>;
@group(0) @binding(2) var nextMaximum: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn maxFoodHistoryMain(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let fieldSize = textureDimensions(currentDisplayField);
  if (any(invocation.xy >= fieldSize)) {
    return;
  }
  let texelPos = vec2<i32>(invocation.xy);
  let currentValue = max(textureLoad(currentDisplayField, texelPos, 0).r, 0.0);
  let rememberedValue = max(textureLoad(previousMaximum, texelPos, 0).r, 0.0);
  textureStore(nextMaximum, texelPos, vec4<f32>(max(currentValue, rememberedValue)));
}
