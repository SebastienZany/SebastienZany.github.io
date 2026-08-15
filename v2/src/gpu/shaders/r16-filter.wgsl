// Contract (M0 format probe): render to r16float, then filter-sample it into rgba8unorm.
// Input: filterable r16float texture and filtering sampler. Output: diagnostic colour.
// Invariant: bind-group creation proves the texture is accepted as filterable float.
@group(0) @binding(0) var sourceField: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[vertexIndex], 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let value = textureSample(sourceField, sourceSampler, position.xy / vec2f(4.0));
  return vec4f(value.r, value.r, value.r, 1.0);
}

