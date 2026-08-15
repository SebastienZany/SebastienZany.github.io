import {
  ATOMIC_FIXED_POINT_SCALE,
  DENSITY_MASS,
  MAX_DENSITY_RESERVE_MASS,
  SPLAT_REFERENCE_FIELD_SIZE,
} from './constants.js';
import { crowdKernelSettings } from './params-layout.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const quantizeUnorm8 = (value) => Math.round(clamp(value, 0, 1) * 255) / 255;

/** CPU image of main.js:3550–3603 for profile regression tests. */
export function legacyCrowdProfile({ size, agents, densityBlur, fieldSize = SPLAT_REFERENCE_FIELD_SIZE }) {
  const output = new Float64Array(size * size);
  const pointSize = Math.max(1, (densityBlur / 4) * (fieldSize / SPLAT_REFERENCE_FIELD_SIZE));
  const radius = pointSize * 0.5;
  for (const agent of agents) {
    const peak = clamp(agent.reserve, 0, MAX_DENSITY_RESERVE_MASS) * DENSITY_MASS;
    if (pointSize <= 1) {
      const texelX = wrapIndex(Math.floor(agent.texelX), size);
      const texelY = wrapIndex(Math.floor(agent.texelY), size);
      output[texelY * size + texelX] += peak;
      continue;
    }
    for (let texelY = 0; texelY < size; texelY += 1) {
      for (let texelX = 0; texelX < size; texelX += 1) {
        const dx = texelX + 0.5 - agent.texelX;
        const dy = texelY + 0.5 - agent.texelY;
        const normalizedRadiusSq = (dx * dx + dy * dy) / (radius * radius);
        if (normalizedRadiusSq <= 1) {
          output[texelY * size + texelX] += peak * reversedSmoothstep(normalizedRadiusSq);
        }
      }
    }
  }
  return output.map(quantizeUnorm8);
}

/** CPU twin of v2's fixed-point scatter + iterated two-dimensional 3x3 kernel. */
export function realizedCrowdProfile({ size, agents, densityBlur, fieldSize = SPLAT_REFERENCE_FIELD_SIZE }) {
  const settings = crowdKernelSettings(densityBlur, fieldSize);
  const atomic = new Uint32Array(size * size);
  for (const agent of agents) {
    const peak = clamp(agent.reserve, 0, MAX_DENSITY_RESERVE_MASS) * DENSITY_MASS;
    if (settings.pointSizeTexels <= 1) {
      addFixed(atomic, size, Math.floor(agent.texelX), Math.floor(agent.texelY), peak);
      continue;
    }
    const cornerX = Math.floor(agent.texelX - 0.5);
    const cornerY = Math.floor(agent.texelY - 0.5);
    const fractionX = agent.texelX - 0.5 - cornerX;
    const fractionY = agent.texelY - 0.5 - cornerY;
    const mass = peak * settings.kernelMass;
    addFixed(atomic, size, cornerX, cornerY, mass * (1 - fractionX) * (1 - fractionY));
    addFixed(atomic, size, cornerX + 1, cornerY, mass * fractionX * (1 - fractionY));
    addFixed(atomic, size, cornerX, cornerY + 1, mass * (1 - fractionX) * fractionY);
    addFixed(atomic, size, cornerX + 1, cornerY + 1, mass * fractionX * fractionY);
  }

  let input = Float64Array.from(atomic, (value) => value / ATOMIC_FIXED_POINT_SCALE);
  for (let iteration = 0; iteration < settings.blurIterations; iteration += 1) {
    const output = new Float64Array(input.length);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const center = input[y * size + x];
        const filtered = binomial3x3(input, size, x, y);
        output[y * size + x] = center + settings.blurAlpha * (filtered - center);
      }
    }
    input = output;
  }
  return input.map(quantizeUnorm8);
}

export function crowdProfileResidual(reference, candidate) {
  if (reference.length !== candidate.length) throw new RangeError('Profile images must have equal lengths');
  let squared = 0;
  let maximum = 0;
  let peak = 0;
  const plot = [];
  for (let index = 0; index < reference.length; index += 1) {
    const difference = candidate[index] - reference[index];
    squared += difference * difference;
    maximum = Math.max(maximum, Math.abs(difference));
    peak = Math.max(peak, reference[index]);
    if (Math.abs(difference) > 0) plot.push({ index, reference: reference[index], candidate: candidate[index], difference });
  }
  return {
    normalizedRmse: Math.sqrt(squared / reference.length) / Math.max(peak, 1 / 255),
    normalizedMax: maximum / Math.max(peak, 1 / 255),
    plot,
  };
}

export function crowdProfileResidualSvg(reference, candidate, size, { title = 'Crowd profile residual' } = {}) {
  const row = Math.floor(size / 2);
  const referenceRow = reference.slice(row * size, (row + 1) * size);
  const candidateRow = candidate.slice(row * size, (row + 1) * size);
  const width = 720;
  const height = 260;
  const pad = 28;
  const peak = Math.max(1 / 255, ...referenceRow, ...candidateRow);
  const points = (values, residual = false) => values.map((value, index) => {
    const x = pad + index * (width - pad * 2) / Math.max(1, size - 1);
    const normalized = residual ? 0.5 + value / (peak * 2) : 1 - value / peak;
    const y = pad + normalized * (height - pad * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  const differences = candidateRow.map((value, index) => value - referenceRow[index]);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#07100e"/>
  <text x="${pad}" y="18" fill="#dce7e4" font-family="monospace" font-size="12">${escapeXml(title)}</text>
  <line x1="${pad}" y1="${height / 2}" x2="${width - pad}" y2="${height / 2}" stroke="#4a5d57"/>
  <polyline fill="none" stroke="#7ee0a3" stroke-width="2" points="${points(referenceRow)}"/>
  <polyline fill="none" stroke="#76a9ff" stroke-width="1.5" points="${points(candidateRow)}"/>
  <polyline fill="none" stroke="#ff8c83" stroke-width="1" points="${points(differences, true)}"/>
  <text x="${pad}" y="${height - 8}" fill="#7ee0a3" font-family="monospace" font-size="10">legacy</text>
  <text x="${pad + 62}" y="${height - 8}" fill="#76a9ff" font-family="monospace" font-size="10">v2</text>
  <text x="${pad + 88}" y="${height - 8}" fill="#ff8c83" font-family="monospace" font-size="10">residual (zero at midline)</text>
</svg>`;
}

function binomial3x3(field, size, x, y) {
  let sum = 0;
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    const weightY = offsetY === 0 ? 2 : 1;
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const weightX = offsetX === 0 ? 2 : 1;
      sum += field[wrapIndex(y + offsetY, size) * size + wrapIndex(x + offsetX, size)] * weightX * weightY;
    }
  }
  return sum / 16;
}

function addFixed(target, size, x, y, amount) {
  const index = wrapIndex(y, size) * size + wrapIndex(x, size);
  target[index] = (target[index] + Math.round(Math.max(amount, 0) * ATOMIC_FIXED_POINT_SCALE)) >>> 0;
}

function reversedSmoothstep(normalizedRadiusSq) {
  const t = clamp(normalizedRadiusSq, 0, 1);
  return 1 - t * t * (3 - 2 * t);
}

function wrapIndex(value, size) {
  return ((value % size) + size) % size;
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
