struct CameraUniforms {
  viewProjection: mat4x4<f32>,
  worldPosition: vec4<f32>,
}

struct SurfaceUniforms {
  // xy inverse field size, z bump tap radius in texels, w food clamp.
  field: vec4<f32>,
  // x height scale, y bump strength, z iridescence strength, w film curve.
  slimeShape: vec4<f32>,
  // x minimum nm, y maximum nm, z light brightness.
  filmAndLight: vec4<f32>,
  slimeBaseColour: vec4<f32>,
  // x fade fraction, y roughness, z reflectivity.
  goldShape: vec4<f32>,
  goldBaseColour: vec4<f32>,
  // x film-follows-height, y use gold film, z use gold body, w smooth sampling.
  modes: vec4<f32>,
  // x minimum nm, y span nm, z minimum cosine, w cosine span.
  lutMapping: vec4<f32>,
  // x active count, y per-light radiance scale.
  lightRig: vec4<f32>,
}

struct LightUniforms {
  worldPositions: array<vec4<f32>, 32>,
}

struct MaterialVertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) uvPos: vec2<f32>,
}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> surface: SurfaceUniforms;
@group(0) @binding(2) var<uniform> lights: LightUniforms;
@group(1) @binding(0) var displaySampleView: texture_2d<f32>;
@group(1) @binding(1) var displayLinearSampler: sampler;
@group(1) @binding(2) var displayNearestSampler: sampler;
@group(1) @binding(3) var maximumFoodHistory: texture_2d<f32>;
@group(1) @binding(4) var goldResponseLut: texture_2d<f32>;
@group(1) @binding(5) var goldResponseSampler: sampler;

const PI: f32 = 3.141592653589793;

fn projectMaterialVertex(worldPosition: vec3<f32>, worldNormal: vec3<f32>, uvPos: vec2<f32>) -> MaterialVertexOutput {
  var output: MaterialVertexOutput;
  output.clipPosition = camera.viewProjection * vec4<f32>(worldPosition, 1.0);
  output.worldPosition = worldPosition;
  output.worldNormal = normalize(worldNormal);
  output.uvPos = uvPos;
  return output;
}

fn schlickFresnel(f0: vec3<f32>, cosine: f32) -> vec3<f32> {
  let grazing = pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0);
  return f0 + (vec3<f32>(1.0) - f0) * grazing;
}

fn ggxDistribution(normalHalfCosine: f32, roughness: f32) -> f32 {
  let alpha = max(roughness * roughness, 0.001);
  let alphaSquared = alpha * alpha;
  let denominator = normalHalfCosine * normalHalfCosine * (alphaSquared - 1.0) + 1.0;
  return alphaSquared / max(PI * denominator * denominator, 0.00001);
}

fn smithMask(normalCosine: f32, roughness: f32) -> f32 {
  let shiftedRoughness = roughness + 1.0;
  let factor = shiftedRoughness * shiftedRoughness * 0.125;
  return normalCosine / max(normalCosine * (1.0 - factor) + factor, 0.00001);
}

fn microfacetSpecular(
  normal: vec3<f32>,
  viewDirection: vec3<f32>,
  lightDirection: vec3<f32>,
  f0: vec3<f32>,
  roughness: f32,
) -> vec3<f32> {
  let normalLightCosine = max(dot(normal, lightDirection), 0.0);
  let normalViewCosine = max(dot(normal, viewDirection), 0.001);
  let halfDirection = normalize(lightDirection + viewDirection);
  let normalHalfCosine = max(dot(normal, halfDirection), 0.0);
  let viewHalfCosine = max(dot(viewDirection, halfDirection), 0.0);
  let fresnel = schlickFresnel(f0, viewHalfCosine);
  let distribution = ggxDistribution(normalHalfCosine, roughness);
  let visibility = smithMask(normalLightCosine, roughness) * smithMask(normalViewCosine, roughness);
  let denominator = max(4.0 * normalLightCosine * normalViewCosine, 0.02);
  let lobe = min((distribution * visibility * normalLightCosine) / denominator, 7.5);
  return fresnel * lobe;
}

fn filmThicknessFraction(food: f32) -> f32 {
  let maximumFood = max(surface.field.w, 0.0001);
  let clampedFood = clamp(max(food, 0.0), 0.0, maximumFood);
  let curve = max(surface.slimeShape.w, 0.0001);
  let denominator = 1.0 - exp(-curve * maximumFood);
  if (denominator < 0.00001) {
    return clamp(clampedFood / maximumFood, 0.0, 1.0);
  }
  return clamp((1.0 - exp(-curve * clampedFood)) / denominator, 0.0, 1.0);
}

fn filmThicknessNm(food: f32) -> f32 {
  if (surface.modes.x <= 0.5) {
    return surface.filmAndLight.y;
  }
  let minimumNm = min(surface.filmAndLight.x, surface.filmAndLight.y);
  let maximumNm = max(surface.filmAndLight.x, surface.filmAndLight.y);
  return mix(minimumNm, maximumNm, filmThicknessFraction(food));
}

fn analyticThinFilm(normalViewCosine: f32, thicknessNm: f32) -> vec3<f32> {
  let filmIor = 1.36;
  let incidentSine = sqrt(max(1.0 - normalViewCosine * normalViewCosine, 0.0));
  let filmSine = clamp(incidentSine / filmIor, 0.0, 0.999);
  let filmCosine = sqrt(max(1.0 - filmSine * filmSine, 0.0));
  let opticalPathNm = 2.0 * filmIor * max(thicknessNm, 0.0) * filmCosine;
  let wavelengthsNm = vec3<f32>(680.0, 535.0, 440.0);
  let phase = opticalPathNm * (2.0 * PI) / wavelengthsNm;
  var interference = 0.5 + 0.5 * cos(phase + vec3<f32>(0.45, 2.35, 4.20));
  interference = interference * interference * (vec3<f32>(3.0) - 2.0 * interference);
  return clamp(interference * vec3<f32>(1.08, 1.18, 1.32), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn goldLutColour(normalViewCosine: f32, thicknessNm: f32) -> vec3<f32> {
  let thicknessCoordinate = clamp(
    (thicknessNm - surface.lutMapping.x) / surface.lutMapping.y,
    0.0,
    1.0,
  );
  let cosineCoordinate = clamp(
    (normalViewCosine - surface.lutMapping.z) / max(surface.lutMapping.w, 0.0001),
    0.0,
    1.0,
  );
  // F1 pre-evaluates the non-uniform angle interpolation, leaving one bilinear fetch.
  return textureSample(goldResponseLut, goldResponseSampler, vec2<f32>(thicknessCoordinate, cosineCoordinate)).rgb;
}

fn activeLightCount() -> u32 {
  return u32(surface.lightRig.x);
}

fn lightRadiance() -> vec3<f32> {
  return vec3<f32>(surface.filmAndLight.z * surface.lightRig.y);
}
