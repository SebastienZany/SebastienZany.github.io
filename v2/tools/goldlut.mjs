import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  GOLD_LUT_FORMAT,
  crc32,
  goldLutHeaderCrc32,
} from '../src/render/gold-lut.js';

// Legacy anchors: main.js:191 and main.js:4959. These values define the shader contract.
export const GOLD_WAFER_SOURCE = Object.freeze({
  angleDegrees: Object.freeze([0, 10, 20, 30, 40, 50, 60, 70, 80, 85]),
  angleCount: 10,
  thicknessCount: 600,
  channelCount: 3,
  minThicknessNm: 10,
  maxThicknessNm: 610,
  fastAngleRows: 256,
});

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const V2_DIRECTORY = resolve(TOOL_DIRECTORY, '..');
const DEFAULT_TENSOR_PATH = resolve(
  V2_DIRECTORY,
  '../material data/thicker_au_rgb_thickness_angle_tensor.json',
);
const DEFAULT_ASSET_DIRECTORY = resolve(V2_DIRECTORY, 'assets');

export function validateGoldWaferTensor(tensor) {
  const expected = GOLD_WAFER_SOURCE;
  const shape = tensor?.shape;
  if (!Array.isArray(shape)
      || shape.length !== 3
      || shape[0] !== expected.angleCount
      || shape[1] !== expected.thicknessCount
      || shape[2] !== expected.channelCount) {
    throw new Error('gold wafer tensor must have shape [10, 600, 3]');
  }

  const angleAxis = tensor?.axes?.angle_deg;
  if (!Array.isArray(angleAxis) || angleAxis.length !== expected.angleCount) {
    throw new Error('gold wafer tensor angle axis must contain 10 rows');
  }
  for (let index = 0; index < expected.angleCount; index += 1) {
    if (Number(angleAxis[index]) !== expected.angleDegrees[index]) {
      throw new Error(
        `gold wafer tensor angle ${index} must be ${expected.angleDegrees[index]}, got ${angleAxis[index]}`,
      );
    }
  }

  const thicknessAxisNm = tensor?.axes?.thickness_nm;
  if (!Array.isArray(thicknessAxisNm) || thicknessAxisNm.length !== expected.thicknessCount) {
    throw new Error('gold wafer tensor thickness axis must match its 600 samples');
  }
  if (Number(thicknessAxisNm[0]) !== expected.minThicknessNm
      || Number(thicknessAxisNm.at(-1)) !== expected.maxThicknessNm) {
    throw new Error('gold wafer tensor thickness axis must run from 10 to 610 nm');
  }
  for (let index = 0; index < thicknessAxisNm.length; index += 1) {
    const thicknessNm = Number(thicknessAxisNm[index]);
    if (!Number.isFinite(thicknessNm)
        || (index > 0 && thicknessNm <= Number(thicknessAxisNm[index - 1]))) {
      throw new Error('gold wafer tensor thickness axis must be strictly increasing');
    }
  }

  const rgbRows = tensor?.data;
  if (!Array.isArray(rgbRows) || rgbRows.length !== expected.angleCount) {
    throw new Error('gold wafer tensor data must match its angle count');
  }
  for (let angleIndex = 0; angleIndex < rgbRows.length; angleIndex += 1) {
    const thicknessRow = rgbRows[angleIndex];
    if (!Array.isArray(thicknessRow) || thicknessRow.length !== expected.thicknessCount) {
      throw new Error(`gold wafer tensor row ${angleIndex} must contain 600 samples`);
    }
    for (let thicknessIndex = 0; thicknessIndex < thicknessRow.length; thicknessIndex += 1) {
      const rgb = thicknessRow[thicknessIndex];
      if (!Array.isArray(rgb) || rgb.length !== expected.channelCount) {
        throw new Error(`gold wafer tensor sample [${angleIndex}, ${thicknessIndex}] must be RGB`);
      }
      for (const channel of rgb) {
        if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
          throw new Error(
            `gold wafer tensor sample [${angleIndex}, ${thicknessIndex}] is not uint8 RGB`,
          );
        }
      }
    }
  }

  const cosRows = expected.angleDegrees.map((degrees) => Math.cos(degrees * Math.PI / 180));
  return Object.freeze({
    rgbRows,
    cosRows: Object.freeze(cosRows),
    width: expected.thicknessCount,
    angleCount: expected.angleCount,
    minThicknessNm: expected.minThicknessNm,
    thicknessSpanNm: expected.maxThicknessNm - expected.minThicknessNm,
    cosMin: cosRows.at(-1),
    cosSpan: cosRows[0] - cosRows.at(-1),
  });
}

// CPU oracle for main.js:4220. Inputs are cosine of the view angle and film thickness in nm.
export function sampleGoldWaferExact(validatedTensor, cosTheta, thicknessNm) {
  const lookup = validatedTensor;
  const clampedCos = clamp(cosTheta, lookup.cosMin, lookup.cosMin + lookup.cosSpan);
  const clampedThicknessNm = clamp(
    thicknessNm,
    lookup.minThicknessNm,
    lookup.minThicknessNm + lookup.thicknessSpanNm,
  );
  const thicknessGridPos = (
    (clampedThicknessNm - lookup.minThicknessNm) / lookup.thicknessSpanNm
  ) * (lookup.width - 1);
  const leftThicknessIndex = clamp(Math.floor(thicknessGridPos), 0, lookup.width - 2);
  const thicknessWeights = catmullRomWeights(thicknessGridPos - leftThicknessIndex);
  const angleInterpolation = angleHermiteInterpolation(clampedCos, lookup.cosRows);

  const color = [0, 0, 0];
  for (let angleTap = 0; angleTap < 4; angleTap += 1) {
    const angleIndex = clamp(
      angleInterpolation.segmentIndex - 1 + angleTap,
      0,
      lookup.angleCount - 1,
    );
    for (let thicknessTap = 0; thicknessTap < 4; thicknessTap += 1) {
      const thicknessIndex = clamp(
        leftThicknessIndex - 1 + thicknessTap,
        0,
        lookup.width - 1,
      );
      const weight = angleInterpolation.weights[angleTap] * thicknessWeights[thicknessTap];
      const rgb = lookup.rgbRows[angleIndex][thicknessIndex];
      for (let channel = 0; channel < 3; channel += 1) {
        color[channel] += weight * rgb[channel] / 255;
      }
    }
  }
  return color.map((channel) => clamp(channel, 0, 1));
}

// main.js:5073 pre-evaluates only the non-uniform angle Hermite; thickness remains 600 samples.
export function buildGoldLutPixels(validatedTensor) {
  const lookup = validatedTensor;
  const height = GOLD_WAFER_SOURCE.fastAngleRows;
  const pixels = new Uint8Array(lookup.width * height * GOLD_LUT_FORMAT.channelCount);
  for (let y = 0; y < height; y += 1) {
    const cosTheta = lookup.cosMin + lookup.cosSpan * y / (height - 1);
    const interpolation = angleHermiteInterpolation(cosTheta, lookup.cosRows);
    for (let x = 0; x < lookup.width; x += 1) {
      const pixelOffset = (y * lookup.width + x) * GOLD_LUT_FORMAT.channelCount;
      for (let channel = 0; channel < 3; channel += 1) {
        let channelByte = 0;
        for (let tap = 0; tap < 4; tap += 1) {
          const angleIndex = clamp(interpolation.segmentIndex - 1 + tap, 0, lookup.angleCount - 1);
          channelByte += interpolation.weights[tap] * lookup.rgbRows[angleIndex][x][channel];
        }
        pixels[pixelOffset + channel] = clamp(Math.round(channelByte), 0, 255);
      }
      pixels[pixelOffset + 3] = 255;
    }
  }
  return {
    width: lookup.width,
    height,
    channelCount: GOLD_LUT_FORMAT.channelCount,
    minThicknessNm: lookup.minThicknessNm,
    thicknessSpanNm: lookup.thicknessSpanNm,
    cosMin: lookup.cosMin,
    cosSpan: lookup.cosSpan,
    pixels,
  };
}

export function sampleGoldLutFast(fastLookup, cosTheta, thicknessNm) {
  const x = clamp(
    (thicknessNm - fastLookup.minThicknessNm) / fastLookup.thicknessSpanNm,
    0,
    1,
  ) * (fastLookup.width - 1);
  const y = clamp((cosTheta - fastLookup.cosMin) / fastLookup.cosSpan, 0, 1)
    * (fastLookup.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, fastLookup.width - 1);
  const y1 = Math.min(y0 + 1, fastLookup.height - 1);
  const xFraction = x - x0;
  const yFraction = y - y0;

  const color = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const top = mix(pixelChannel(fastLookup, x0, y0, channel),
      pixelChannel(fastLookup, x1, y0, channel), xFraction);
    const bottom = mix(pixelChannel(fastLookup, x0, y1, channel),
      pixelChannel(fastLookup, x1, y1, channel), xFraction);
    color[channel] = mix(top, bottom, yFraction) / 255;
  }
  return color;
}

export function bakeGoldLut(tensor) {
  const validatedTensor = validateGoldWaferTensor(tensor);
  const fastLookup = buildGoldLutPixels(validatedTensor);
  const binary = serializeGoldLut(fastLookup);
  const compressed = new Uint8Array(gzipSync(binary, { level: 9, mtime: 0 }));
  return {
    ...fastLookup,
    binary,
    compressed,
    contentHash: sha256Hex(fastLookup.pixels),
    binaryHash: sha256Hex(binary),
    compressedHash: sha256Hex(compressed),
  };
}

export async function writeGoldLutAsset({
  tensorPath = DEFAULT_TENSOR_PATH,
  assetDirectory = DEFAULT_ASSET_DIRECTORY,
} = {}) {
  const tensor = JSON.parse(await readFile(tensorPath, 'utf8'));
  const baked = bakeGoldLut(tensor);
  await mkdir(assetDirectory, { recursive: true });
  const fileName = `gold-lut.${baked.compressedHash.slice(0, 8)}.bin.gz`;
  const outputPath = resolve(assetDirectory, fileName);
  await writeFile(outputPath, baked.compressed);
  return { outputPath, fileName, ...baked };
}

function serializeGoldLut(fastLookup) {
  const format = GOLD_LUT_FORMAT;
  const binary = new Uint8Array(format.headerBytes + fastLookup.pixels.byteLength);
  const header = new DataView(binary.buffer, binary.byteOffset, format.headerBytes);
  for (let index = 0; index < format.magic.length; index += 1) {
    binary[index] = format.magic.charCodeAt(index);
  }
  header.setUint16(format.offsets.version, format.version, true);
  header.setUint16(format.offsets.headerBytes, format.headerBytes, true);
  header.setUint32(format.offsets.width, fastLookup.width, true);
  header.setUint32(format.offsets.height, fastLookup.height, true);
  header.setUint16(format.offsets.channelCount, format.channelCount, true);
  header.setUint16(format.offsets.componentType, format.componentTypeUnorm8, true);
  header.setUint32(format.offsets.payloadBytes, fastLookup.pixels.byteLength, true);
  header.setUint32(format.offsets.payloadCrc32, crc32(fastLookup.pixels), true);
  header.setFloat64(format.offsets.minThicknessNm, fastLookup.minThicknessNm, true);
  header.setFloat64(format.offsets.thicknessSpanNm, fastLookup.thicknessSpanNm, true);
  header.setFloat64(format.offsets.cosMin, fastLookup.cosMin, true);
  header.setFloat64(format.offsets.cosSpan, fastLookup.cosSpan, true);
  binary.set(sha256Bytes(fastLookup.pixels), format.offsets.contentHash);
  header.setUint32(format.offsets.headerCrc32, goldLutHeaderCrc32(binary), true);
  binary.set(fastLookup.pixels, format.headerBytes);
  return binary;
}

function angleHermiteInterpolation(cosTheta, cosRows) {
  const segmentIndex = findAngleSegment(cosTheta, cosRows);
  const cosAt = (index) => cosRows[clamp(index, 0, cosRows.length - 1)];
  const leftCos = cosAt(segmentIndex);
  const rightCos = cosAt(segmentIndex + 1);
  const previousCos = cosAt(segmentIndex - 1);
  const nextCos = cosAt(segmentIndex + 2);
  const segmentWidth = rightCos - leftCos;
  const leftSlopeScale = segmentWidth / (rightCos - previousCos);
  const rightSlopeScale = segmentWidth / (nextCos - leftCos);
  const fraction = (leftCos - cosTheta) / (leftCos - rightCos);
  const fractionSquared = fraction * fraction;
  const fractionCubed = fractionSquared * fraction;
  const valueLeft = 2 * fractionCubed - 3 * fractionSquared + 1;
  const slopeLeft = fractionCubed - 2 * fractionSquared + fraction;
  const valueRight = -2 * fractionCubed + 3 * fractionSquared;
  const slopeRight = fractionCubed - fractionSquared;
  return {
    segmentIndex,
    weights: [
      -leftSlopeScale * slopeLeft,
      valueLeft - rightSlopeScale * slopeRight,
      valueRight + leftSlopeScale * slopeLeft,
      rightSlopeScale * slopeRight,
    ],
  };
}

function findAngleSegment(cosTheta, cosRows) {
  for (let index = 0; index < cosRows.length - 1; index += 1) {
    if (cosTheta >= cosRows[index + 1]) return index;
  }
  return cosRows.length - 2;
}

function catmullRomWeights(fraction) {
  const squared = fraction * fraction;
  const cubed = squared * fraction;
  return [
    (-cubed + 2 * squared - fraction) / 2,
    (3 * cubed - 5 * squared + 2) / 2,
    (-3 * cubed + 4 * squared + fraction) / 2,
    (cubed - squared) / 2,
  ];
}

function pixelChannel(lookup, x, y, channel) {
  return lookup.pixels[(y * lookup.width + x) * lookup.channelCount + channel];
}

function mix(left, right, fraction) {
  return left * (1 - fraction) + right * fraction;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest();
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function printablePath(path) {
  return relative(V2_DIRECTORY, path).split(sep).join('/');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baked = await writeGoldLutAsset();
  console.log(JSON.stringify({
    file: printablePath(baked.outputPath),
    sha256: baked.compressedHash,
    inflatedSha256: baked.binaryHash,
    payloadSha256: baked.contentHash,
    compressedBytes: baked.compressed.byteLength,
    inflatedBytes: baked.binary.byteLength,
    dimensions: [baked.width, baked.height, baked.channelCount],
    source: basename(DEFAULT_TENSOR_PATH),
  }, null, 2));
}
