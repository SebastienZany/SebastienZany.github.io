// Oat-field refresh kernel.
// Inputs: Params UBO and up to 64 Oat records in UV-space.
// Output: write-only r32float oat field; overlap composition is max, never sum.
// Invariants: every texel is overwritten, so clearing oats removes influence immediately.
// Anchors: main.js:2282–2332 and M3 oat semantics.

//#include "common.wgsl"

struct Oat { uvPos: vec2<f32>, radiusUv: f32, peakFood: f32 }
@group(0) @binding(1) var<storage, read> oats: array<Oat>;
@group(0) @binding(2) var oatFieldOut: texture_storage_2d<r32float, write>;

@compute @workgroup_size(${FIELD_WORKGROUP_SIZE}, ${FIELD_WORKGROUP_SIZE})
fn refreshOatField(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let size = fieldSize();
  if (invocation.x >= size || invocation.y >= size) { return; }
  let uvPos = (vec2<f32>(invocation.xy) + vec2<f32>(0.5)) / f32(size);
  let oatCount = parameterUint(${PARAM_SLOT_OAT_META}u, 0u);
  var food = 0.0;
  for (var oatIndex = 0u; oatIndex < ${MAX_OATS}u; oatIndex += 1u) {
    if (oatIndex >= oatCount) { break; }
    let oat = oats[oatIndex];
    let radiusUv = max(oat.radiusUv, 0.001);
    var deltaUv = uvPos - oat.uvPos;
    deltaUv -= round(deltaUv);
    let supportRadiusUv = radiusUv * ${OAT_SUPPORT_SIGMAS};
    if (dot(deltaUv, deltaUv) > supportRadiusUv * supportRadiusUv) { continue; }
    let contribution = max(oat.peakFood, 0.0)
      * exp(-dot(deltaUv, deltaUv) / (2.0 * radiusUv * radiusUv));
    food = max(food, contribution);
  }
  textureStore(oatFieldOut, vec2<i32>(invocation.xy), vec4<f32>(food, 0.0, 0.0, 1.0));
}
