// Slime mesh material (F2 material-look lane; main.js:3979-4376 semantics).
// Inputs: fixture position/normal/UV, camera/material/light UBOs, filterable r16float display field, gold LUT.
// Output: linear scene radiance with coverage alpha for One/OneMinusSrcAlpha layering over opaque gold.
// Units: positions are surface/world-space, UVs normalized, bump radius texel-space, film thickness nanometres.
// Invariants: 4 axial plus 4 diagonal height taps; direct reach <=2.33 texels; synthetic field proves no seams.

//#include "material-common.wgsl"

@vertex
fn slimeVertex(
  @location(0) worldPosition: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) uvPos: vec2<f32>,
) -> MaterialVertexOutput {
  return projectMaterialVertex(worldPosition, worldNormal, uvPos);
}

fn displayFoodAt(uvPos: vec2<f32>) -> f32 {
  let clampedUv = clamp(uvPos, vec2<f32>(0.0), vec2<f32>(1.0));
  if (surface.modes.w > 0.5) {
    return max(textureSample(displaySampleView, displayLinearSampler, clampedUv).r, 0.0);
  }
  return max(textureSample(displaySampleView, displayNearestSampler, clampedUv).r, 0.0);
}

fn slimeHeight(food: f32) -> f32 {
  return (1.0 - exp(-max(food, 0.0) * 4.0)) * surface.slimeShape.x;
}

@fragment
fn slimeFragment(input: MaterialVertexOutput, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
  let food = displayFoodAt(input.uvPos);
  let geometricNormal = normalize(select(-input.worldNormal, input.worldNormal, frontFacing));
  let worldDx = dpdx(input.worldPosition);
  let worldDy = dpdy(input.worldPosition);
  let uvDx = dpdx(input.uvPos);
  let uvDy = dpdy(input.uvPos);
  let worldDyPerpendicular = cross(worldDy, geometricNormal);
  let worldDxPerpendicular = cross(geometricNormal, worldDx);
  var tangent = worldDyPerpendicular * uvDx.x + worldDxPerpendicular * uvDy.x;
  var bitangent = worldDyPerpendicular * uvDx.y + worldDxPerpendicular * uvDy.y;
  let tangentMagnitudeSquared = max(dot(tangent, tangent), dot(bitangent, bitangent));
  if (tangentMagnitudeSquared > 0.000000000000000000000001) {
    let inverseMagnitude = inverseSqrt(tangentMagnitudeSquared);
    tangent *= inverseMagnitude;
    bitangent *= inverseMagnitude;
  } else {
    let fallbackUp = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(geometricNormal.y) < 0.999);
    tangent = normalize(cross(fallbackUp, geometricNormal));
    bitangent = normalize(cross(geometricNormal, tangent));
  }

  let tapRadius = max(surface.field.z, 1.0);
  let texelOffset = surface.field.xy * tapRadius;
  let bumpScale = surface.slimeShape.y / tapRadius;
  let leftHeight = slimeHeight(displayFoodAt(input.uvPos - vec2<f32>(texelOffset.x, 0.0)));
  let rightHeight = slimeHeight(displayFoodAt(input.uvPos + vec2<f32>(texelOffset.x, 0.0)));
  let downHeight = slimeHeight(displayFoodAt(input.uvPos - vec2<f32>(0.0, texelOffset.y)));
  let upHeight = slimeHeight(displayFoodAt(input.uvPos + vec2<f32>(0.0, texelOffset.y)));
  let upperLeft = slimeHeight(displayFoodAt(input.uvPos + vec2<f32>(-texelOffset.x, texelOffset.y)));
  let upperRight = slimeHeight(displayFoodAt(input.uvPos + texelOffset));
  let lowerLeft = slimeHeight(displayFoodAt(input.uvPos - texelOffset));
  let lowerRight = slimeHeight(displayFoodAt(input.uvPos + vec2<f32>(texelOffset.x, -texelOffset.y)));
  let gradientX = (rightHeight - leftHeight) * 0.5
    + (upperRight + lowerRight - upperLeft - lowerLeft) * 0.25;
  let gradientY = (upHeight - downHeight) * 0.5
    + (upperLeft + upperRight - lowerLeft - lowerRight) * 0.25;
  let normal = normalize(geometricNormal - tangent * gradientX * bumpScale - bitangent * gradientY * bumpScale);

  let viewDirection = normalize(camera.worldPosition.xyz - input.worldPosition);
  let normalViewCosine = max(dot(normal, viewDirection), 0.001);
  let foodVisual = 1.0 - exp(-food * 2.4);
  let trail = pow(foodVisual, 0.68);
  let trailCore = foodVisual * foodVisual * 0.55;
  let glossMask = smoothstep(0.02, 0.26, food);
  let slimePresence = smoothstep(0.006, 0.08, food);
  let thicknessNm = filmThicknessNm(food);
  var filmColour = analyticThinFilm(normalViewCosine, thicknessNm);
  if (surface.modes.y > 0.5) {
    filmColour = goldLutColour(normalViewCosine, thicknessNm);
  }

  let iridescence = clamp(surface.slimeShape.z, 0.0, 2.0);
  var filmF0 = clamp(
    mix(vec3<f32>(0.045), vec3<f32>(0.065) + filmColour * 0.34, iridescence),
    vec3<f32>(0.0),
    vec3<f32>(1.0),
  );
  if (surface.modes.y > 0.5) {
    filmF0 = clamp(mix(vec3<f32>(0.045), filmColour, iridescence), vec3<f32>(0.0), vec3<f32>(1.0));
  }
  let filmAtView = schlickFresnel(filmF0, normalViewCosine) * slimePresence;
  let clearAtView = schlickFresnel(vec3<f32>(0.035), normalViewCosine)
    * slimePresence * (0.22 + glossMask * 0.58);
  let reflectedBudget = clamp(
    filmAtView + clearAtView * (vec3<f32>(1.0) - filmAtView),
    vec3<f32>(0.0),
    vec3<f32>(0.92),
  );
  let bodyBudget = max(vec3<f32>(0.0), vec3<f32>(1.0) - reflectedBudget);
  let liquidBody = clamp(surface.slimeBaseColour.rgb, vec3<f32>(0.0), vec3<f32>(1.0));
  let deepBody = liquidBody * vec3<f32>(0.32, 0.34, 0.36);
  var pearlBody = mix(deepBody, liquidBody, trail);
  pearlBody = mix(pearlBody, pearlBody + filmColour * 0.11, slimePresence * (0.30 + trailCore * 0.35));
  pearlBody = clamp(pearlBody, vec3<f32>(0.0), vec3<f32>(1.0));

  var diffuseLight = vec3<f32>(0.22, 0.24, 0.26);
  var filmSpecular = vec3<f32>(0.0);
  var clearSpecular = vec3<f32>(0.0);
  let bodyRoughness = mix(0.34, 0.105, glossMask);
  let clearRoughness = mix(0.18, 0.055, glossMask);
  let radiance = lightRadiance();
  for (var lightIndex = 0u; lightIndex < 32u; lightIndex += 1u) {
    if (lightIndex >= activeLightCount()) {
      break;
    }
    let lightDirection = normalize(lights.worldPositions[lightIndex].xyz - input.worldPosition);
    diffuseLight += radiance * max(dot(normal, lightDirection), 0.0);
    filmSpecular += microfacetSpecular(normal, viewDirection, lightDirection, filmF0, bodyRoughness) * radiance;
    clearSpecular += microfacetSpecular(normal, viewDirection, lightDirection, vec3<f32>(0.035), clearRoughness) * radiance;
  }
  clearSpecular *= slimePresence * (0.18 + glossMask * 0.82);

  let pearlMask = max(trail, slimePresence * 0.26);
  var colour = pearlBody * bodyBudget * diffuseLight * pearlMask;
  colour += filmSpecular * slimePresence * (0.42 + trailCore * 0.85);
  colour += clearSpecular;
  colour += bodyBudget * filmColour * slimePresence * (0.018 + trailCore * 0.045);
  let displayedColour = pow(max(colour, vec3<f32>(0.0)), vec3<f32>(0.78));
  let layerAlpha = clamp(max(slimePresence * 0.82, trail * 0.68), 0.0, 1.0);
  let outputAlpha = select(1.0, layerAlpha, surface.modes.z > 0.5);
  return vec4<f32>(displayedColour, outputAlpha);
}
