// Dynamic-field diffuse/decay and exposure-delta kernels.
// Inputs: r32float dynamic field and fixed-point exposure after final population.
// Outputs: r32float field ping-pong, one owner per texel.
// Invariants: all 3x3 reads wrap; diffuse precedes delta, so fresh deposits spread
// only on the next step. Delta preserves every normalization/cap/dt/clamp term.
// Anchors: main.js:2532–2567/3674–3714/18098 and M3 economy contract.

//#include "common.wgsl"

@group(0) @binding(1) var fieldIn: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> exposureAtomic: array<atomic<u32>>;
@group(0) @binding(3) var fieldOut: texture_storage_2d<r32float, write>;

fn foodAt(texelPos: vec2<i32>) -> f32 {
  return max(textureLoad(fieldIn, wrapTexel(texelPos), 0).r, 0.0);
}

@compute @workgroup_size(${FIELD_WORKGROUP_SIZE}, ${FIELD_WORKGROUP_SIZE})
fn diffuseField(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let size = fieldSize();
  if (invocation.x >= size || invocation.y >= size) { return; }
  let texelPos = vec2<i32>(invocation.xy);
  let center = foodAt(texelPos);
  var neighbors = 0.0;
  for (var offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (var offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX != 0 || offsetY != 0) {
        neighbors += foodAt(texelPos + vec2<i32>(offsetX, offsetY));
      }
    }
  }
  let blurred = neighbors * 0.125;
  let diffusion = parameterFloat(${PARAM_SLOT_FIELD}u, 0u);
  let decay = parameterFloat(${PARAM_SLOT_FIELD}u, 1u);
  let foodClamp = parameterFloat(${PARAM_SLOT_FIELD}u, 3u);
  let nextFood = clamp(mix(center, blurred, diffusion) * decay, 0.0, foodClamp);
  textureStore(fieldOut, texelPos, vec4<f32>(nextFood, 0.0, 0.0, 1.0));
}

@compute @workgroup_size(${FIELD_WORKGROUP_SIZE}, ${FIELD_WORKGROUP_SIZE})
fn applyExposureDelta(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let size = fieldSize();
  if (invocation.x >= size || invocation.y >= size) { return; }
  let texelPos = vec2<i32>(invocation.xy);
  let index = invocation.y * size + invocation.x;
  let food = foodAt(texelPos);
  let scale = parameterFloat(${PARAM_SLOT_FIXED_POINT}u, 1u);
  let density = f32(atomicLoad(&exposureAtomic[index])) / scale;
  let densityMass = parameterFloat(${PARAM_SLOT_OAT}u, 1u);
  let exposureCap = parameterFloat(${PARAM_SLOT_OAT}u, 2u);
  let agentLoad = min(density / densityMass, exposureCap);
  let exposure = agentLoad * parameterFloat(${PARAM_SLOT_FIELD}u, 2u)
    * parameterFloat(${PARAM_SLOT_SENSING}u, 0u);
  let deposited = parameterFloat(${PARAM_SLOT_ECONOMY}u, 1u) * exposure;
  let uptake = food * (1.0 - exp(-parameterFloat(${PARAM_SLOT_ECONOMY}u, 0u) * exposure));
  let nextFood = clamp(food + deposited - uptake, 0.0, parameterFloat(${PARAM_SLOT_FIELD}u, 3u));
  textureStore(fieldOut, texelPos, vec4<f32>(nextFood, 0.0, 0.0, 1.0));
}
