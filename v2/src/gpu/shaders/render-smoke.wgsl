// Contract (M0 render smoke): draw one fullscreen triangle into rgba8unorm.
// Inputs: vertex index. Output: opaque linear RGB (0.2, 0.4, 0.6).
// Invariant: the center pixel differs from the pass clear colour.
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  return vec4f(positions[vertexIndex], 0.0, 1.0);
}

@fragment
fn fragmentMain() -> @location(0) vec4f {
  return vec4f(0.2, 0.4, 0.6, 1.0);
}
