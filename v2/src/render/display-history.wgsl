// Synthetic display-history pass (F2 material-look lane).
// Inputs: current synthetic r32float field, previous r32float history, Surface display settings.
// Output: next r32float history in field-value units.
// Invariants: values stay finite and within foodClamp; this fixture-only pass contains no atlas logic.
// Semantics: temporal blend follows main.js:2864-2873; the broad synthetic blur is replaced in F4/M5.

struct DisplayUniforms {
  // x temporal weight, y spatial radius in texels, z history-ready flag, w food clamp.
  settings: vec4<f32>,
}

@group(0) @binding(0) var currentField: texture_2d<f32>;
@group(0) @binding(1) var previousHistory: texture_2d<f32>;
@group(0) @binding(2) var nextHistory: texture_storage_2d<r32float, write>;
@group(0) @binding(3) var<uniform> display: DisplayUniforms;

fn currentValueAt(texelPos: vec2<i32>, fieldSize: vec2<u32>) -> f32 {
  let maximum = vec2<i32>(fieldSize) - vec2<i32>(1);
  return max(textureLoad(currentField, clamp(texelPos, vec2<i32>(0), maximum), 0).r, 0.0);
}

@compute @workgroup_size(8, 8)
fn displayHistoryMain(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let fieldSize = textureDimensions(currentField);
  if (any(invocation.xy >= fieldSize)) {
    return;
  }

  let texelPos = vec2<i32>(invocation.xy);
  let spatialRadius = max(display.settings.y, 0.0);
  let tapDistance = i32(round(clamp(spatialRadius, 1.0, 10.0)));
  let center = currentValueAt(texelPos, fieldSize);
  var weighted = 0.0;
  var weightTotal = 0.0;
  for (var tapY = -1; tapY <= 1; tapY += 1) {
    for (var tapX = -1; tapX <= 1; tapX += 1) {
      let weightX = select(1.0, 2.0, tapX == 0);
      let weightY = select(1.0, 2.0, tapY == 0);
      let weight = weightX * weightY;
      let offset = vec2<i32>(tapX, tapY) * tapDistance;
      weighted += currentValueAt(texelPos + offset, fieldSize) * weight;
      weightTotal += weight;
    }
  }
  let spatialMix = smoothstep(0.0, 0.25, spatialRadius);
  let spatialValue = mix(center, weighted / weightTotal, spatialMix);

  var historyValue = spatialValue;
  if (display.settings.z > 0.5) {
    let temporalAmount = max(display.settings.x, 0.0);
    var temporalBlend = min(temporalAmount, 0.98);
    if (temporalAmount > 1.0) {
      temporalBlend = 1.0 - 0.02 / temporalAmount;
    }
    let previousValue = max(textureLoad(previousHistory, texelPos, 0).r, 0.0);
    historyValue = mix(spatialValue, previousValue, clamp(temporalBlend, 0.0, 0.995));
  }
  textureStore(nextHistory, texelPos, vec4<f32>(clamp(historyValue, 0.0, display.settings.w)));
}
