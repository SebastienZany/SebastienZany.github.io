// The gold body: the gilded skin revealed wherever slime has ever been.
//
// It is a metal lit only by reflections of the cage of lights. Its tint comes
// from measured data: the colour of a thin gold film on a wafer, by film
// thickness and viewing angle (assets/gold-film-tensor.json). Thickness follows
// the most slime each spot has ever carried (the display field's memory), so
// the body records where the slime has been.

import * as THREE from 'three';
import { MAX_LIGHTS, LIGHT_SKY_FRAGMENT } from './lights.js';

const SKY_WIDTH = 512;
const SKY_HEIGHT = 256;
const ANGLE_ROWS = 256;

/**
 * The measured table is sampled at ten uneven viewing angles. Resample it to
 * ANGLE_ROWS rows evenly spaced in cos(angle), with a smooth (Hermite) curve
 * through the measurements, so the shader needs a single filtered read.
 * @returns {{ texture, minNm, spanNm, cosMin, cosSpan }}
 */
export function buildGoldFilmLookup(tensor) {
  const angles = tensor?.axes?.angle_deg;
  const thicknesses = tensor?.axes?.thickness_nm;
  const data = tensor?.data;
  if (!Array.isArray(angles) || !Array.isArray(thicknesses) || !Array.isArray(data) || data.length !== angles.length) {
    throw new Error('gold film tensor: expected axes.angle_deg, axes.thickness_nm and data[angle][thickness][rgb]');
  }
  const cos = angles.map((degrees) => Math.cos(THREE.MathUtils.degToRad(degrees)));   // descending
  const last = cos.length - 1;
  const cosAt = (i) => cos[Math.max(0, Math.min(last, i))];
  const rowAt = (i) => data[Math.max(0, Math.min(last, i))];
  const width = thicknesses.length;
  const pixels = new Uint8Array(width * ANGLE_ROWS * 4);

  for (let y = 0; y < ANGLE_ROWS; y++) {
    const c = cos[last] + (cos[0] - cos[last]) * (y / (ANGLE_ROWS - 1));
    let segment = 0;
    while (segment < last - 1 && c < cos[segment + 1]) segment++;
    // Cubic Hermite between the measurements either side, with tangents from
    // their neighbours (the table's spacing is uneven, hence alpha and beta).
    const left = cosAt(segment), right = cosAt(segment + 1);
    const span = right - left;
    const alpha = span / (right - cosAt(segment - 1));
    const beta = span / (cosAt(segment + 2) - left);
    const s = (left - c) / (left - right);
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
    const weights = [-alpha * h10, h00 - beta * h11, h01 + alpha * h10, beta * h11];
    const rows = [rowAt(segment - 1), rowAt(segment), rowAt(segment + 1), rowAt(segment + 2)];
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < 3; channel++) {
        let value = 0;
        for (let j = 0; j < 4; j++) value += rows[j][x][channel] * weights[j];
        pixels[(y * width + x) * 4 + channel] = Math.max(0, Math.min(255, Math.round(value)));
      }
      pixels[(y * width + x) * 4 + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(pixels, width, ANGLE_ROWS, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return {
    texture,
    minNm: thicknesses[0],
    spanNm: thicknesses[width - 1] - thicknesses[0],
    cosMin: cos[last],
    cosSpan: cos[0] - cos[last],
  };
}

// Added to three.js's physical material. `reveal` is 0 where slime has never
// been (the body stays black and matte) and 1 where it has been thick.
const GOLD_DECLARATIONS = /* glsl */ `
uniform sampler2D uGoldMemory;
uniform sampler2D uGoldFilm;
uniform float uGoldMinNm;
uniform float uGoldSpanNm;
uniform float uGoldCosMin;
uniform float uGoldCosSpan;
uniform float uGoldThicknessMax;
uniform float uGoldFilmCurve;
uniform float uGoldFilmMinNm;
uniform float uGoldFilmMaxNm;
uniform float uGoldFade;
uniform float uGoldRoughness;
uniform float uGoldReflectivity;
uniform vec3 uGoldColor;
varying vec2 vGoldUv;

float goldMemory() { return max(texture2D(uGoldMemory, vGoldUv).r, 0.0); }
float goldReveal(float memory) {
  float amount = clamp(memory / max(uGoldThicknessMax, 0.0001), 0.0, 1.0);
  float fade = clamp(uGoldFade, 0.0001, 1.0);
  return amount >= fade ? 1.0 : smoothstep(0.0, fade, amount);
}
vec3 goldFilmColor(float memory, float cosView) {
  float top = max(uGoldThicknessMax, 0.0001);
  float curve = max(uGoldFilmCurve, 0.0001);
  float span = 1.0 - exp(-curve * top);
  float x = clamp(memory, 0.0, top);
  float film01 = span < 0.00001 ? x / top : clamp((1.0 - exp(-curve * x)) / span, 0.0, 1.0);
  float nm = mix(min(uGoldFilmMinNm, uGoldFilmMaxNm), max(uGoldFilmMinNm, uGoldFilmMaxNm), film01);
  float u = clamp((nm - uGoldMinNm) / uGoldSpanNm, 0.0, 1.0);
  float v = clamp((clamp(cosView, uGoldCosMin, 1.0) - uGoldCosMin) / max(uGoldCosSpan, 0.0001), 0.0, 1.0);
  return texture2D(uGoldFilm, vec2(u, v)).rgb;
}
`;

export function createGoldBody({ gpu, geometry, filmLookup, lightPositions, sculptNormals }) {
  const uniforms = {
    uGoldMemory: { value: null },
    uGoldFilm: { value: filmLookup.texture },
    uGoldMinNm: { value: filmLookup.minNm },
    uGoldSpanNm: { value: filmLookup.spanNm },
    uGoldCosMin: { value: filmLookup.cosMin },
    uGoldCosSpan: { value: filmLookup.cosSpan },
    uGoldThicknessMax: { value: 0.5 },
    uGoldFilmCurve: { value: 4 },
    uGoldFilmMinNm: { value: 220 },
    uGoldFilmMaxNm: { value: 760 },
    uGoldFade: { value: 0.15 },
    uGoldRoughness: { value: 0.33 },
    uGoldReflectivity: { value: 1 },
    uGoldColor: { value: new THREE.Color('#8a889e') },
  };

  const material = new THREE.MeshPhysicalMaterial({ metalness: 1, specularIntensity: 0, side: THREE.DoubleSide });
  material.defines = { ...material.defines, USE_UV: '' };
  if (sculptNormals && geometry.attributes.uv1) {
    material.normalMap = sculptNormals;
    material.normalMap.channel = 1;
    // Same handedness as the slime film: green points up the image, v runs down it.
    material.normalScale.set(1, -1);
  }
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGoldUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvGoldUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GOLD_DECLARATIONS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float goldRevealed = goldReveal(goldMemory());
        diffuseColor.rgb = clamp(uGoldColor, 0.0, 1.0) * goldRevealed;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(mix(1.0, uGoldRoughness, goldRevealed), 0.04, 1.0);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor *= goldRevealed;`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          float cosView = clamp(abs(dot(normalize(vNormal), normalize(vViewPosition))), 0.0, 1.0);
          vec3 tint = mix(vec3(1.0), goldFilmColor(goldMemory(), cosView), goldRevealed) * clamp(uGoldReflectivity, 0.0, 1.0);
          reflectedLight.directSpecular *= tint;
          reflectedLight.indirectSpecular *= tint;
        }`);
  };
  material.customProgramCacheKey = () => 'gold-body';

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;

  // The lights as a reflected environment.
  const sky = gpu.target(SKY_WIDTH, SKY_HEIGHT, { type: 'half', filter: 'linear', name: 'light-sky' });
  sky.texture.mapping = THREE.EquirectangularReflectionMapping;
  const skyPass = gpu.material(LIGHT_SKY_FRAGMENT, {
    u_lightDirections: lightPositions, u_lightCount: 12, u_lightRadianceScale: 1,
  });
  let environment = null;
  let environmentLights = -1;

  function setLights({ count, radianceScale }) {
    if (count === environmentLights) return;
    environmentLights = count;
    skyPass.uniforms.u_lightCount.value = count;
    skyPass.uniforms.u_lightRadianceScale.value = radianceScale;
    gpu.run(skyPass, sky);
    const generator = new THREE.PMREMGenerator(gpu.renderer);
    environment?.dispose();
    environment = generator.fromEquirectangular(sky.texture);
    generator.dispose();
    material.envMap = environment.texture;
    material.needsUpdate = true;
  }

  return {
    mesh,
    /** @param look the look params  @param memoryTexture display field memory  @param thicknessMax model.thicknessMax */
    sync(look, memoryTexture, thicknessMax, lights) {
      setLights(lights);
      uniforms.uGoldMemory.value = memoryTexture;
      uniforms.uGoldThicknessMax.value = thicknessMax;
      uniforms.uGoldFilmCurve.value = look.filmThicknessCurve;
      uniforms.uGoldFilmMinNm.value = look.iridescenceMinThickness;
      uniforms.uGoldFilmMaxNm.value = look.iridescenceThickness;
      uniforms.uGoldFade.value = look.goldBodyFade;
      uniforms.uGoldRoughness.value = look.goldBodyRoughness;
      uniforms.uGoldReflectivity.value = look.goldBodyReflectivity;
      uniforms.uGoldColor.value.set(look.goldBodyColor);
      material.roughness = look.goldBodyRoughness;
      material.reflectivity = look.goldBodyReflectivity;
      material.color.set(look.goldBodyColor);
      material.envMapIntensity = look.lightBrightness;
      if (material.normalMap) material.normalScale.set(look.sculptDetail, -look.sculptDetail);
    },
    dispose() {
      material.dispose();
      sky.dispose();
      skyPass.dispose();
      environment?.dispose();
    },
  };
}
