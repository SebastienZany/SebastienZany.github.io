// The slime film: the material that draws the slime on the body.
//
// It reads the display field (how thick the slime is at each atlas texel) and
// shades it as a wet, pearly layer: a body colour lit by the cage of lights, a
// thin-film interference colour that shifts with thickness and viewing angle,
// and two glossy highlights (the film itself and a clear wet coat over it).
// Where there is no slime it draws nothing, so the gold body shows through.

import * as THREE from 'three';
import { MAX_LIGHTS } from './lights.js';

const VERTEX = /* glsl */ `
in vec2 uv1;                 // the sculpt's own UVs, which its normal map was baked against
out vec2 v_uv;
out vec2 v_sculptUv;
out vec3 v_worldPos;
out vec3 v_worldNormal;
void main() {
  v_uv = uv;
  v_sculptUv = uv1;
  vec4 world = modelMatrix * vec4(position, 1.0);
  v_worldPos = world.xyz;
  v_worldNormal = normalize(mat3(modelMatrix) * normal);
  // Exactly the arithmetic three.js uses for the gold body beneath, so the two
  // layers land on identical depths instead of fighting.
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewPosition;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
in vec2 v_uv;
in vec2 v_sculptUv;
in vec3 v_worldPos;
in vec3 v_worldNormal;
out vec4 outColor;

uniform sampler2D u_thickness;       // display field, red = slime thickness
uniform sampler2D u_sculptNormals;
uniform float u_sculptDetail;
uniform vec2 u_texel;
uniform float u_thicknessMax;
uniform float u_heightScale;
uniform float u_bumpStrength;
uniform float u_bumpRadiusTexels;
uniform int u_diagonalBumpTaps;
uniform float u_iridescence;
uniform float u_filmMinNm;
uniform float u_filmMaxNm;
uniform float u_filmCurve;
uniform int u_filmFollowsHeight;
uniform vec3 u_baseColor;
uniform vec3 u_lightPositions[${MAX_LIGHTS}];
uniform int u_lightCount;
uniform float u_lightRadiance;
uniform vec3 u_cameraPos;
uniform int u_outline;
uniform int u_overGold;              // 1: output alpha so the gold body shows through thin slime
uniform int u_showRaw;               // 1: draw the thickness itself, for debugging

const float PI = 3.141592653589793;

float thicknessAt(vec2 uv) {
  return max(texture(u_thickness, uv).r, 0.0);
}
// Slime stands up quickly at first, then saturates.
float heightOf(float thickness) {
  return (1.0 - exp(-thickness * 4.0)) * u_heightScale;
}
// 0..1 position of this thickness between no slime and the most a texel can hold.
float film01(float thickness) {
  float top = max(u_thicknessMax, 0.0001);
  float x = clamp(thickness, 0.0, top);
  float curve = max(u_filmCurve, 0.0001);
  float span = 1.0 - exp(-curve * top);
  if (span < 0.00001) return x / top;
  return clamp((1.0 - exp(-curve * x)) / span, 0.0, 1.0);
}

vec3 fresnel(vec3 f0, float cosTheta) {
  return f0 + (vec3(1.0) - f0) * pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
}
// A glossy highlight from one light (GGX microfacets), capped so a single
// texel never blows out.
vec3 highlight(vec3 normal, vec3 viewDir, vec3 lightDir, vec3 f0, float roughness) {
  float nDotL = max(dot(normal, lightDir), 0.0);
  float nDotV = max(dot(normal, viewDir), 0.001);
  vec3 halfDir = normalize(lightDir + viewDir);
  float nDotH = max(dot(normal, halfDir), 0.0);
  float a = max(roughness * roughness, 0.001);
  float a2 = a * a;
  float denom = nDotH * nDotH * (a2 - 1.0) + 1.0;
  float distribution = a2 / max(PI * denom * denom, 1e-5);
  float k = (roughness + 1.0) * (roughness + 1.0) * 0.125;
  float visibility = (nDotL / max(nDotL * (1.0 - k) + k, 1e-5)) * (nDotV / max(nDotV * (1.0 - k) + k, 1e-5));
  float lobe = min(distribution * visibility * nDotL / max(4.0 * nDotL * nDotV, 0.02), 7.5);
  return fresnel(f0, max(dot(viewDir, halfDir), 0.0)) * lobe;
}
// Colour of light reflected by a thin transparent film of the given thickness:
// the two reflections interfere, differently for red, green and blue.
vec3 thinFilm(float nDotV, float thicknessNm) {
  const float filmIor = 1.36;
  float sinFilm = clamp(sqrt(max(1.0 - nDotV * nDotV, 0.0)) / filmIor, 0.0, 0.999);
  float path = 2.0 * filmIor * max(thicknessNm, 0.0) * sqrt(1.0 - sinFilm * sinFilm);
  vec3 phase = path * (2.0 * PI) / vec3(680.0, 535.0, 440.0);
  vec3 interference = 0.5 + 0.5 * cos(phase + vec3(0.45, 2.35, 4.20));
  interference = interference * interference * (3.0 - 2.0 * interference);
  return clamp(interference * vec3(1.08, 1.18, 1.32), 0.0, 1.0);   // a slight abalone tint
}

void main() {
  float thickness = thicknessAt(v_uv);
  if (u_showRaw == 1) {
    outColor = vec4(vec3(thickness / max(u_thicknessMax, 0.0001)), 1.0);
    return;
  }

  // Directions on the surface along the atlas's u and v axes, from screen derivatives.
  vec3 dp1 = dFdx(v_worldPos);
  vec3 dp2 = dFdy(v_worldPos);
  vec2 duv1 = dFdx(v_uv);
  vec2 duv2 = dFdy(v_uv);
  vec3 bodyNormal = normalize(v_worldNormal);
  if (!gl_FrontFacing) bodyNormal = -bodyNormal;
  vec3 dp2perp = cross(dp2, bodyNormal);
  vec3 dp1perp = cross(bodyNormal, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float longest = max(dot(T, T), dot(B, B));
  if (longest > 1e-24) {
    T *= inversesqrt(longest);
    B *= inversesqrt(longest);
  } else {
    vec3 up = abs(bodyNormal.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    T = normalize(cross(up, bodyNormal));
    B = normalize(cross(bodyNormal, T));
  }

  // The sculpt's fine detail. Its normal map has green pointing up the image;
  // B follows the atlas v axis, which runs down the image, hence the minus.
  if (u_sculptDetail > 0.0 && length(T) > 1e-6 && length(B) > 1e-6) {
    vec3 detail = texture(u_sculptNormals, v_sculptUv).xyz * 2.0 - 1.0;
    detail.xy *= u_sculptDetail;
    bodyNormal = normalize(normalize(T) * detail.x - normalize(B) * detail.y + bodyNormal * detail.z);
  }

  // The slime's own relief: tilt the normal down the slope of its height.
  float radius = max(u_bumpRadiusTexels, 1.0);
  vec2 d = u_texel * radius;
  float slopeX = (heightOf(thicknessAt(v_uv + vec2(d.x, 0.0))) - heightOf(thicknessAt(v_uv - vec2(d.x, 0.0)))) * 0.5;
  float slopeY = (heightOf(thicknessAt(v_uv + vec2(0.0, d.y))) - heightOf(thicknessAt(v_uv - vec2(0.0, d.y)))) * 0.5;
  if (u_diagonalBumpTaps == 1) {
    float upLeft = heightOf(thicknessAt(v_uv + vec2(-d.x, d.y)));
    float upRight = heightOf(thicknessAt(v_uv + d));
    float downLeft = heightOf(thicknessAt(v_uv - d));
    float downRight = heightOf(thicknessAt(v_uv + vec2(d.x, -d.y)));
    slopeX += (upRight + downRight - upLeft - downLeft) * 0.25;
    slopeY += (upLeft + upRight - downLeft - downRight) * 0.25;
  }
  vec3 normal = normalize(bodyNormal - (T * slopeX + B * slopeY) * (u_bumpStrength / radius));

  vec3 viewDir = normalize(u_cameraPos - v_worldPos);
  float nDotV = max(dot(normal, viewDir), 0.001);

  // How much slime is here, read several ways.
  float visible = 1.0 - exp(-thickness * 2.4);
  float trail = pow(visible, 0.68);                    // broad body of the slime
  float core = visible * visible * 0.55;               // its thick middle
  float gloss = smoothstep(0.02, 0.26, thickness);     // thick enough to be glassy
  float presence = smoothstep(0.006, 0.08, thickness); // any slime at all

  float filmNm = u_filmMaxNm;
  if (u_filmFollowsHeight == 1) {
    filmNm = mix(min(u_filmMinNm, u_filmMaxNm), max(u_filmMinNm, u_filmMaxNm), film01(thickness));
  }
  vec3 filmColor = thinFilm(nDotV, filmNm);

  // Split incoming light between what the film and the clear coat reflect and
  // what reaches the body underneath.
  vec3 filmF0 = clamp(mix(vec3(0.045), vec3(0.065) + filmColor * 0.34, clamp(u_iridescence, 0.0, 2.0)), 0.0, 1.0);
  vec3 filmReflects = fresnel(filmF0, nDotV) * presence;
  vec3 coatReflects = fresnel(vec3(0.035), nDotV) * presence * (0.22 + gloss * 0.58);
  vec3 reachesBody = max(vec3(0.0), vec3(1.0) - clamp(filmReflects + coatReflects * (vec3(1.0) - filmReflects), vec3(0.0), vec3(0.92)));

  vec3 base = clamp(u_baseColor, 0.0, 1.0);
  vec3 pearl = mix(base * vec3(0.32, 0.34, 0.36), base, trail);
  pearl = clamp(mix(pearl, pearl + filmColor * 0.11, presence * (0.30 + core * 0.35)), 0.0, 1.0);

  vec3 diffuse = vec3(0.22, 0.24, 0.26);               // ambient
  vec3 filmShine = vec3(0.0);
  vec3 coatShine = vec3(0.0);
  float filmRoughness = mix(0.34, 0.105, gloss);
  float coatRoughness = mix(0.18, 0.055, gloss);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= u_lightCount) break;
    vec3 lightDir = normalize(u_lightPositions[i] - v_worldPos);
    diffuse += u_lightRadiance * max(dot(normal, lightDir), 0.0);
    filmShine += highlight(normal, viewDir, lightDir, filmF0, filmRoughness) * u_lightRadiance;
    coatShine += highlight(normal, viewDir, lightDir, vec3(0.035), coatRoughness) * u_lightRadiance;
  }

  vec3 color = pearl * reachesBody * diffuse * max(trail, presence * 0.26);
  color += filmShine * presence * (0.42 + core * 0.85);
  color += coatShine * presence * (0.18 + gloss * 0.82);
  color += reachesBody * filmColor * presence * (0.018 + core * 0.045);

  float rim = 0.0;
  if (u_outline == 1) {
    rim = pow(1.0 - max(dot(bodyNormal, viewDir), 0.0), 3.0);
    color += vec3(0.18, 0.36, 0.55) * rim * 0.34;
  }

  color = pow(max(color, vec3(0.0)), vec3(0.78));
  float alpha = u_overGold == 1 ? clamp(max(max(presence * 0.82, trail * 0.68), rim), 0.0, 1.0) : 1.0;
  outColor = vec4(color, alpha);
}
`;

export function createSlimeFilm({ lightPositions, fieldSize, sculptNormals }) {
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.DoubleSide,
    uniforms: {
      u_thickness: { value: null },
      u_sculptNormals: { value: sculptNormals },
      u_sculptDetail: { value: 0 },
      u_texel: { value: new THREE.Vector2(1 / fieldSize, 1 / fieldSize) },
      u_thicknessMax: { value: 0.5 },
      u_heightScale: { value: 1 },
      u_bumpStrength: { value: 1 },
      u_bumpRadiusTexels: { value: 1 },
      u_diagonalBumpTaps: { value: 1 },
      u_iridescence: { value: 0.8 },
      u_filmMinNm: { value: 220 },
      u_filmMaxNm: { value: 760 },
      u_filmCurve: { value: 4 },
      u_filmFollowsHeight: { value: 1 },
      u_baseColor: { value: new THREE.Color('#ffffff') },
      u_lightPositions: { value: lightPositions },
      u_lightCount: { value: 12 },
      u_lightRadiance: { value: 1 },
      u_cameraPos: { value: new THREE.Vector3() },
      u_outline: { value: 0 },
      u_overGold: { value: 0 },
      u_showRaw: { value: 0 },
    },
  });
  // Over the gold body the film keeps its full brightness and its alpha only
  // decides how much gold shows through (premultiplied-style blending).
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

  function setOverGold(overGold) {
    if (material.transparent === overGold) return;
    material.transparent = overGold;
    material.depthWrite = !overGold;
    material.blending = overGold ? THREE.CustomBlending : THREE.NormalBlending;
    material.uniforms.u_overGold.value = overGold ? 1 : 0;
    material.needsUpdate = true;
  }

  return { material, setOverGold, dispose: () => material.dispose() };
}
