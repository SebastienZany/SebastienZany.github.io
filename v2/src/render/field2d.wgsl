// Flat-field development renderer.
// Inputs: nearest-loaded canonical r32float food field; optional 32 B Agent records.
// Output: canvas colour plus one-pixel agent-dot overlay.
// Invariants: no sampler or atlas logic; drawIndirect limits dots to live agents.
// Anchors: M3 dev.html growth and webgpu/render2d.js technique reference.

struct Agent {
  uvPos: vec2<f32>,
  heading: f32,
  reserve: f32,
  idLo: u32,
  idHi: u32,
  flags: u32,
  padding: u32,
}

struct FieldVertex { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }

@group(0) @binding(0) var foodField: texture_2d<f32>;
@group(1) @binding(0) var<storage, read> agents: array<Agent>;

@vertex
fn fieldVertex(@builtin(vertex_index) index: u32) -> FieldVertex {
  let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  var output: FieldVertex;
  output.position = vec4<f32>(uv * 2.0 - vec2<f32>(1.0), 0.0, 1.0);
  output.uv = vec2<f32>(uv.x, 1.0 - uv.y);
  return output;
}

@fragment
fn fieldFragment(input: FieldVertex) -> @location(0) vec4<f32> {
  let size = textureDimensions(foodField);
  let texelPos = clamp(vec2<i32>(input.uv * vec2<f32>(size)), vec2<i32>(0), vec2<i32>(size) - vec2<i32>(1));
  let food = max(textureLoad(foodField, texelPos, 0).r, 0.0);
  let signal = pow(clamp(food * 2.0, 0.0, 1.0), 0.55);
  let deep = vec3<f32>(0.004, 0.012, 0.014);
  let middle = vec3<f32>(0.02, 0.35, 0.28);
  let bright = vec3<f32>(0.80, 1.0, 0.88);
  let colour = select(mix(deep, middle, signal * 2.0), mix(middle, bright, signal * 2.0 - 1.0), signal > 0.5);
  return vec4<f32>(colour, 1.0);
}

@vertex
fn agentVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let uvPos = agents[index].uvPos;
  return vec4<f32>(uvPos.x * 2.0 - 1.0, 1.0 - uvPos.y * 2.0, 0.0, 1.0);
}

@fragment
fn agentFragment() -> @location(0) vec4<f32> {
  return vec4<f32>(0.75, 1.0, 0.84, 0.72);
}
