// Shader-side half of surface.js. Include SURFACE_GLSL in any fragment shader
// that works in the atlas, and give its material `surface.uniforms()`.
//
// With these few functions a shader never needs to know where the atlas is cut
// or how unevenly it is stretched:
//
//   onSurface(uv)                      is this point on the body?
//   surfaceMetric(uv)                  the metric texel (see surface.js)
//   worldLength(metric, duv)           world distance of an atlas step
//   surfaceStep(metric, dir, world)    atlas step that covers a world distance
//   surfaceReach(from, to, out, turn)  where a point reached from `from` really
//                                      is, crossing a cut if it has to; false
//                                      if it is off the body
//   seamImage(from, to, out)           the far-side image of a point beyond a cut

export const SURFACE_GLSL = /* glsl */ `
uniform sampler2D u_surfaceMetric;
uniform sampler2D u_surfaceSeam;

bool insideAtlas(vec2 uv) {
  return uv.x >= 0.0 && uv.y >= 0.0 && uv.x < 1.0 && uv.y < 1.0;
}
vec4 surfaceMetric(vec2 uv) {
  return texture(u_surfaceMetric, uv);
}
bool onSurface(vec2 uv) {
  return insideAtlas(uv) && texture(u_surfaceMetric, uv).a > 0.0;
}
// Relative world area of the texel at uv: 1 at the atlas mean, larger where the
// unwrap gives the skin fewer texels.
float texelArea(vec4 metric) {
  return max(metric.a, 1e-6);
}
float worldLength(vec4 metric, vec2 duv) {
  return sqrt(max(metric.r * duv.x * duv.x + 2.0 * metric.g * duv.x * duv.y + metric.b * duv.y * duv.y, 0.0));
}
vec2 surfaceStep(vec4 metric, vec2 direction, float distanceWorld) {
  return direction * (distanceWorld / max(worldLength(metric, direction), 1e-6));
}
// The image across the cut nearest to fromUv of a point toUv that lies beyond it.
bool seamImage(vec2 fromUv, vec2 toUv, out vec2 across) {
  across = toUv;
  if (!insideAtlas(fromUv)) return false;
  vec4 seam = texture(u_surfaceSeam, fromUv);
  if (dot(seam.xy, seam.xy) <= 0.0) return false;
  across = vec2(seam.x * toUv.x - seam.y * toUv.y, seam.y * toUv.x + seam.x * toUv.y) + seam.zw;
  return onSurface(across);
}
// turn is the angle a heading must rotate by when it crosses.
bool surfaceReach(vec2 fromUv, vec2 toUv, out vec2 reached, out float turn) {
  turn = 0.0;
  reached = toUv;
  if (onSurface(toUv)) return true;
  if (!seamImage(fromUv, toUv, reached)) return false;
  vec4 seam = texture(u_surfaceSeam, fromUv);
  turn = atan(seam.y, seam.x);
  return true;
}
`;
