// Gold body mesh material (F2 material-look lane; main.js:2972,4948-4952,5165-5266 semantics).
// Inputs: mesh position/normal/original UV, camera/material/light UBOs, r32float running-max food, F1 LUT.
// Output: opaque linear scene radiance drawn before the slime film into a depth24plus pass.
// Units: positions are surface/world-space, history is field value, film thickness nanometres.
// Invariants: remembered food never decreases; the 600x256 LUT costs exactly one bilinear fetch per fragment.

//#include "material-common.wgsl"

@vertex
fn goldVertex(
  @location(0) worldPosition: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) uvPos: vec2<f32>,
) -> MaterialVertexOutput {
  return projectMaterialVertex(worldPosition, worldNormal, uvPos);
}

fn maximumFoodAt(uvPos: vec2<f32>) -> f32 {
  let fieldSize = textureDimensions(maximumFoodHistory);
  let texelPos = clamp(
    vec2<i32>(uvPos * vec2<f32>(fieldSize)),
    vec2<i32>(0),
    vec2<i32>(fieldSize) - vec2<i32>(1),
  );
  return max(textureLoad(maximumFoodHistory, texelPos, 0).r, 0.0);
}

fn goldBodyFilmThicknessNm(food: f32) -> f32 {
  let minimumNm = min(surface.filmAndLight.x, surface.filmAndLight.y);
  let maximumNm = max(surface.filmAndLight.x, surface.filmAndLight.y);
  return mix(minimumNm, maximumNm, filmThicknessFraction(food));
}

@fragment
fn goldFragment(input: MaterialVertexOutput, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
  let rememberedFood = maximumFoodAt(input.uvPos);
  let normalizedFood = clamp(rememberedFood / max(surface.field.w, 0.0001), 0.0, 1.0);
  let fadeFraction = clamp(surface.goldShape.x, 0.0001, 1.0);
  var goldFade = smoothstep(0.0, fadeFraction, normalizedFood);
  if (normalizedFood >= fadeFraction) {
    goldFade = 1.0;
  }

  let normal = normalize(select(-input.worldNormal, input.worldNormal, frontFacing));
  let viewDirection = normalize(camera.worldPosition.xyz - input.worldPosition);
  let normalViewCosine = clamp(abs(dot(normal, viewDirection)), 0.0, 1.0);
  let responseColour = goldLutColour(normalViewCosine, goldBodyFilmThicknessNm(rememberedFood));
  let roughness = clamp(mix(1.0, surface.goldShape.y, goldFade), 0.04, 1.0);
  let reflectivity = clamp(surface.goldShape.z, 0.0, 1.0);
  let metallicResponse = mix(vec3<f32>(0.04), responseColour, goldFade * reflectivity);
  let radiance = lightRadiance();
  var diffuseLight = vec3<f32>(0.06, 0.065, 0.07);
  var directSpecular = vec3<f32>(0.0);
  var environmentResponse = 0.0;
  let reflectedDirection = reflect(-viewDirection, normal);

  for (var lightIndex = 0u; lightIndex < 32u; lightIndex += 1u) {
    if (lightIndex >= activeLightCount()) {
      break;
    }
    let lightDirection = normalize(lights.worldPositions[lightIndex].xyz - input.worldPosition);
    diffuseLight += radiance * max(dot(normal, lightDirection), 0.0);
    directSpecular += microfacetSpecular(
      normal,
      viewDirection,
      lightDirection,
      metallicResponse,
      roughness,
    ) * radiance;
    let environmentAlignment = max(dot(reflectedDirection, normalize(lights.worldPositions[lightIndex].xyz)), 0.0);
    environmentResponse += surface.lightRig.y * (
      pow(environmentAlignment, 42.0) * 1.25
      + pow(environmentAlignment, 360.0) * 22.0
    ); // main.js:2064 procedural environment anchors
  }

  let goldBase = clamp(surface.goldBaseColour.rgb, vec3<f32>(0.0), vec3<f32>(1.0));
  let diffuseShare = 1.0 - goldFade;
  var colour = goldBase * goldFade * (diffuseLight * diffuseShare + vec3<f32>(0.10));
  colour += directSpecular * goldFade;
  colour += responseColour * reflectivity * goldFade * environmentResponse * 0.08;
  return vec4<f32>(max(colour, vec3<f32>(0.0)), 1.0);
}
