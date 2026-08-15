// Display sample-view copy (F2 material-look lane; PLAN §2 formats).
// Input: unfilterable r32float EMA history in field-value units.
// Output: core-renderable r16float sample view, later read through nearest or bilinear sampling.
// Invariants: one source texel maps to one destination texel; no mips or atlas/seam behavior exists here.

@group(0) @binding(0) var displayHistory: texture_2d<f32>;

@vertex
fn sampleViewVertex(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}

@fragment
fn sampleViewFragment(@builtin(position) fragmentPosition: vec4<f32>) -> @location(0) f32 {
  let fieldSize = textureDimensions(displayHistory);
  let texelPos = clamp(
    vec2<i32>(fragmentPosition.xy),
    vec2<i32>(0),
    vec2<i32>(fieldSize) - vec2<i32>(1),
  );
  return max(textureLoad(displayHistory, texelPos, 0).r, 0.0);
}
