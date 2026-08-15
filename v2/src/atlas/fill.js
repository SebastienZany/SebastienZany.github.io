import { GUTTER_RECORD_OFFSET, WEIGHT_QUANTIZATION_SUM } from '../../tools/atlas-constants.mjs';
import { applyFrame, transportHeading } from '../../tools/seams.mjs';

export function fillGutters(sourceField, gutter, { disabled = false, inPlace = false, quantized = false } = {}) {
  const output = inPlace ? sourceField : sourceField.slice();
  if (disabled) return output;
  for (let recordIndex = 0; recordIndex < gutter.recordCount; recordIndex += 1) {
    output[gutter.coords[recordIndex]] = gatherRecord(sourceField, gutter, recordIndex, quantized);
  }
  return output;
}

export function gatherRecord(sourceField, gutter, recordIndex, quantized = false) {
  let value = 0;
  for (let tap = 0; tap < 4; tap += 1) {
    const offset = recordIndex * 4 + tap;
    const weight = quantized
      ? gutter.quantizedWeights[offset] / WEIGHT_QUANTIZATION_SUM
      : gutter.weights[offset];
    value += weight * sourceField[gutter.tapIndices[offset]];
  }
  return value;
}

export function scatterAdjoint(output, ownership, gutter, texelIndex, value, { quantized = false } = {}) {
  const owner = ownership[texelIndex];
  if (owner > 0 && owner < GUTTER_RECORD_OFFSET) {
    output[texelIndex] += value;
    return;
  }
  if (owner < GUTTER_RECORD_OFFSET) throw new Error(`fill: texel ${texelIndex} is outside every footprint`);
  const recordIndex = owner - GUTTER_RECORD_OFFSET;
  for (let tap = 0; tap < 4; tap += 1) {
    const offset = recordIndex * 4 + tap;
    const weight = quantized
      ? gutter.quantizedWeights[offset] / WEIGHT_QUANTIZATION_SUM
      : gutter.weights[offset];
    output[gutter.tapIndices[offset]] += value * weight;
  }
}

export function transposeInnerProducts(authoritativeValues, gutterValues, gutter, texelCount, options = {}) {
  let gatherDot = 0;
  const scattered = new Float64Array(texelCount);
  for (let recordIndex = 0; recordIndex < gutter.recordCount; recordIndex += 1) {
    gatherDot += gatherRecord(authoritativeValues, gutter, recordIndex, options.quantized) * gutterValues[recordIndex];
    for (let tap = 0; tap < 4; tap += 1) {
      const offset = recordIndex * 4 + tap;
      const weight = options.quantized
        ? gutter.quantizedWeights[offset] / WEIGHT_QUANTIZATION_SUM
        : gutter.weights[offset];
      scattered[gutter.tapIndices[offset]] += gutterValues[recordIndex] * weight;
    }
  }
  let scatterDot = 0;
  for (let texelIndex = 0; texelIndex < texelCount; texelIndex += 1) {
    scatterDot += authoritativeValues[texelIndex] * scattered[texelIndex];
  }
  return { gatherDot, scatterDot, error: Math.abs(gatherDot - scatterDot) };
}

export function resolveAtlasStep({
  baseUv,
  candidateUv,
  heading,
  fieldSize,
  authoritativeOwner,
  boundaryIndex,
  frameTable,
}) {
  const baseTexel = uvTexelIndex(baseUv, fieldSize);
  if (baseTexel < 0) return failedResolve(baseUv, heading, 'base-outside');
  const baseChart = authoritativeOwner[baseTexel];
  if (!baseChart) return failedResolve(baseUv, heading, 'base-nonauthoritative');
  const candidateTexel = uvTexelIndex(candidateUv, fieldSize);
  if (candidateTexel >= 0 && authoritativeOwner[candidateTexel] === baseChart) {
    return { valid: true, uv: candidateUv, heading: normalize2(heading), frameId: 0, reason: 'same-chart' };
  }
  const frameCount = boundaryIndex.frameListCounts[baseTexel];
  for (let listIndex = 0; listIndex < frameCount; listIndex += 1) {
    const frameId = boundaryIndex.frameLists[baseTexel * 4 + listIndex];
    const frame = frameTable.frames[frameId - 1];
    if (!frame || frame.sourceChart !== baseChart) continue;
    const destinationUv = applyFrame(frame, candidateUv);
    const destinationTexel = uvTexelIndex(destinationUv, fieldSize);
    if (destinationTexel < 0 || authoritativeOwner[destinationTexel] !== frame.destinationChart) continue;
    return {
      valid: true,
      uv: destinationUv,
      heading: transportHeading(frame, heading),
      frameId,
      reason: 'seam',
    };
  }
  return failedResolve(baseUv, heading, 'conservative-failure');
}

export function diffuseWithLedger(field, atlas, {
  deposits,
  depletion,
  upperClamp = Infinity,
  wrongTapOffset = 0,
} = {}) {
  const { authoritativeOwner, gutter } = atlas;
  const filled = fillGutters(field, gutter);
  const diffused = new Float64Array(field.length);
  for (let texelIndex = 0; texelIndex < authoritativeOwner.length; texelIndex += 1) {
    if (!authoritativeOwner[texelIndex]) continue;
    const x = texelIndex % atlas.fieldSize; const y = Math.floor(texelIndex / atlas.fieldSize);
    let sum = 0;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const sampleX = clamp(x + dx + wrongTapOffset, 0, atlas.fieldSize - 1);
      const sampleY = clamp(y + dy, 0, atlas.fieldSize - 1);
      sum += filled[sampleY * atlas.fieldSize + sampleX];
    }
    diffused[texelIndex] = sum / 9;
  }
  const TPrev = weightedTotal(field, atlas);
  const TDiff = weightedTotal(diffused, atlas);
  const post = diffused.slice();
  let depositTotal = 0; let acceptedDepletion = 0; let upperClampLoss = 0;
  for (let texelIndex = 0; texelIndex < authoritativeOwner.length; texelIndex += 1) {
    if (!authoritativeOwner[texelIndex]) continue;
    const area = texelArea(atlas, authoritativeOwner[texelIndex]);
    const deposit = deposits?.[texelIndex] ?? 0;
    const requestedDepletion = Math.max(0, depletion?.[texelIndex] ?? 0);
    depositTotal += deposit * area;
    const beforeDepletion = post[texelIndex] + deposit;
    const accepted = Math.min(requestedDepletion, Math.max(0, beforeDepletion));
    acceptedDepletion += accepted * area;
    const unclamped = beforeDepletion - accepted;
    const clamped = Math.min(upperClamp, unclamped);
    upperClampLoss += (unclamped - clamped) * area;
    post[texelIndex] = clamped;
  }
  const TPost = weightedTotal(post, atlas);
  const seamFlux = TDiff - TPrev;
  const residual = TPost - (TDiff + depositTotal - acceptedDepletion - upperClampLoss);
  return {
    field: fillGutters(post, gutter),
    ledger: {
      T_prev: TPrev,
      T_diff: TDiff,
      T_post: TPost,
      deposits: depositTotal,
      acceptedDepletion,
      upperClampLoss,
      seamFlux,
      residual,
    },
  };
}

export function weightedTotal(field, atlas) {
  let total = 0;
  for (let texelIndex = 0; texelIndex < atlas.authoritativeOwner.length; texelIndex += 1) {
    const chartId = atlas.authoritativeOwner[texelIndex];
    if (chartId) total += field[texelIndex] * texelArea(atlas, chartId);
  }
  return total;
}

function texelArea(atlas, chartId) {
  return atlas.chartTable?.[chartId - 1]?.worldAreaPerTexel ?? 1;
}

function uvTexelIndex(uv, fieldSize) {
  if (uv[0] < 0 || uv[1] < 0 || uv[0] >= 1 || uv[1] >= 1) return -1;
  return Math.floor(uv[1] * fieldSize) * fieldSize + Math.floor(uv[0] * fieldSize);
}

function failedResolve(uv, heading, reason) {
  return { valid: false, uv: [...uv], heading: normalize2(heading), frameId: 0, reason };
}

function normalize2(vector) {
  const length = Math.hypot(...vector);
  return length > 0 ? vector.map((value) => value / length) : [1, 0];
}

function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
