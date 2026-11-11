// The lights: a cage of point lights on the corners (and optionally the face
// centres) of an icosahedron around the body. The slime film shades itself with
// them directly; the gold body sees them as a reflected environment.

import * as THREE from 'three';

export const CORNER_LIGHTS = 12;
export const FACE_LIGHTS = 20;
export const MAX_LIGHTS = CORNER_LIGHTS + FACE_LIGHTS;
const RADIUS_IN_BODY_LENGTHS = 1.85;

const FACES = [
  [0, 1, 8], [0, 1, 9], [0, 4, 5], [0, 4, 8], [0, 5, 9], [1, 6, 7], [1, 6, 8], [1, 7, 9], [2, 3, 10], [2, 3, 11],
  [2, 4, 5], [2, 4, 10], [2, 5, 11], [3, 6, 7], [3, 6, 10], [3, 7, 11], [4, 8, 10], [5, 9, 11], [6, 8, 10], [7, 9, 11],
];

/** Positions of all 32 lights; the first 12 are the corners. */
export function lightPositions(bodyLengthWorld) {
  const phi = (1 + Math.sqrt(5)) / 2;
  const radius = bodyLengthWorld * RADIUS_IN_BODY_LENGTHS;
  const corners = [
    [0, 1, phi], [0, -1, phi], [0, 1, -phi], [0, -1, -phi], [1, phi, 0], [-1, phi, 0],
    [1, -phi, 0], [-1, -phi, 0], [phi, 0, 1], [-phi, 0, 1], [phi, 0, -1], [-phi, 0, -1],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z).normalize().multiplyScalar(radius));
  const faceCentres = FACES.map(([a, b, c]) =>
    corners[a].clone().add(corners[b]).add(corners[c]).multiplyScalar(1 / 3));
  return [...corners, ...faceCentres];
}

/** How many lights are on, and the factor that keeps total brightness the same either way. */
export function activeLights(useFaceLights) {
  const count = useFaceLights ? MAX_LIGHTS : CORNER_LIGHTS;
  return { count, radianceScale: CORNER_LIGHTS / count };
}

// The lights painted onto a sky panorama (longitude across, latitude up), each
// as a soft glow with a hot core. The gold body reflects this.
export const LIGHT_SKY_FRAGMENT = /* glsl */ `
in vec2 v_uv;
out vec4 outColor;
uniform vec3 u_lightDirections[${MAX_LIGHTS}];
uniform int u_lightCount;
uniform float u_lightRadianceScale;
const float PI = 3.141592653589793;
void main() {
  float longitude = v_uv.x * 2.0 * PI - PI;
  float latitude = (v_uv.y - 0.5) * PI;
  vec3 direction = vec3(cos(latitude) * cos(longitude), sin(latitude), cos(latitude) * sin(longitude));
  vec3 color = vec3(0.018, 0.022, 0.026);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= u_lightCount) break;
    float alignment = max(dot(direction, normalize(u_lightDirections[i])), 0.0);
    color += vec3(pow(alignment, 42.0) * 1.25 + pow(alignment, 360.0) * 22.0) * u_lightRadianceScale;
  }
  outColor = vec4(color, 1.0);
}
`;
