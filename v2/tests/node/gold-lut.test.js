import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  GOLD_WAFER_SOURCE,
  bakeGoldLut,
  buildGoldLutPixels,
  sampleGoldLutFast,
  sampleGoldWaferExact,
  validateGoldWaferTensor,
} from '../../tools/goldlut.mjs';
import {
  GOLD_LUT_FORMAT,
  loadGoldLut,
  parseGoldLut,
} from '../../src/render/gold-lut.js';

const sourcePath = fileURLToPath(new URL(
  '../../../material%20data/thicker_au_rgb_thickness_angle_tensor.json',
  import.meta.url,
));
const sourceTensor = JSON.parse(await readFile(sourcePath, 'utf8'));

test('gold tensor validation rejects every structural mismatch named by F1', async (t) => {
  await t.test('wrong angle list', () => {
    const invalid = { ...sourceTensor, axes: { ...sourceTensor.axes, angle_deg: [...sourceTensor.axes.angle_deg] } };
    invalid.axes.angle_deg[9] = 90;
    assert.throws(() => validateGoldWaferTensor(invalid), /angle 9 must be 85/);
  });

  await t.test('wrong declared dimensions', () => {
    const invalid = { ...sourceTensor, shape: [10, 599, 3] };
    assert.throws(() => validateGoldWaferTensor(invalid), /shape \[10, 600, 3\]/);
  });

  await t.test('wrong nested dimensions', () => {
    const invalidRows = [...sourceTensor.data];
    invalidRows[3] = invalidRows[3].slice(0, 599);
    assert.throws(
      () => validateGoldWaferTensor({ ...sourceTensor, data: invalidRows }),
      /row 3 must contain 600 samples/,
    );
  });

  await t.test('non-uint8 channel', () => {
    const invalidRows = [...sourceTensor.data];
    invalidRows[0] = [...invalidRows[0]];
    invalidRows[0][0] = [256, invalidRows[0][0][1], invalidRows[0][0][2]];
    assert.throws(
      () => validateGoldWaferTensor({ ...sourceTensor, data: invalidRows }),
      /not uint8 RGB/,
    );
  });
});

test('exact sampler matches hand-computed clamp, cubic, and non-uniform-angle vectors', () => {
  const lookup = validateGoldWaferTensor(makeArithmeticTensor());
  const cosAt = (degrees) => Math.cos(degrees * Math.PI / 180);
  const interiorThicknessNm = 10 + 600 * 100.5 / 599;

  // Thickness below 10 nm clamps to sample 0; cos(0°) selects row 0: [12, 10, 128].
  assertColorBytes(sampleGoldWaferExact(lookup, cosAt(0), -100), [12, 10, 128]);

  // Thickness above 610 nm clamps to sample 599; cos(85°) selects row 9: [212, 250, 128].
  assertColorBytes(sampleGoldWaferExact(lookup, cosAt(85), 900), [212, 250, 128]);

  // At thickness index 100.5 the Catmull weights are [-1, 9, 9, -1] / 16.
  // Red = (-20 + 9·40 + 9·80 - 100) / 16 = 60; row 0 supplies green 10.
  assertColorBytes(
    sampleGoldWaferExact(lookup, cosAt(0), interiorThicknessNm),
    [60, 10, 128],
  );

  // A Hermite knot has weights [0, 1, 0, 0], so cos(70°) returns row 7 exactly.
  assertColorBytes(sampleGoldWaferExact(lookup, cosAt(70), 200), [20, 225, 128]);

  // The last non-uniform boundary is 80°→85°; both endpoint knots must remain exact.
  assertColorBytes(sampleGoldWaferExact(lookup, cosAt(80), 200), [20, 240, 128]);
  assertColorBytes(sampleGoldWaferExact(lookup, cosAt(85), 200), [20, 250, 128]);

  // Halfway in cosine across 80°→85°: alpha=(c85-c80)/(c85-c70)=0.33936648163931415.
  // With s=1/2, green = 243.75 + 3.125·alpha = 244.81052025512287.
  const lastSegmentMidpoint = (cosAt(80) + cosAt(85)) / 2;
  assertColorBytes(
    sampleGoldWaferExact(lookup, lastSegmentMidpoint, 200),
    [20, 244.81052025512287, 128],
  );
});

test('600×256 fast lookup stays within the derived two-byte quantization envelope', () => {
  const lookup = validateGoldWaferTensor(sourceTensor);
  const fastLookup = buildGoldLutPixels(lookup);

  // The source-wide cubic-cell extrema give 0.631399 byte thickness error. Hermite's absolute
  // weight sum is at most 43/27, and the 256-row cosine spacing plus the source's maximum angle
  // second derivative contributes 0.325080 byte. Add 0.5 byte RGBA8 rounding:
  // 0.631399·43/27 + 0.325080 + 0.5 = 1.830642 bytes, rounded outward to 2/255.
  const quantizationBound = 2 / 255;
  const thicknessSamples = 1201;
  const cosSamples = 1025;
  let worst = { error: -1 };

  for (let thicknessStep = 0; thicknessStep < thicknessSamples; thicknessStep += 1) {
    const thicknessNm = lookup.minThicknessNm
      + lookup.thicknessSpanNm * thicknessStep / (thicknessSamples - 1);
    for (let cosStep = 0; cosStep < cosSamples; cosStep += 1) {
      const cosTheta = lookup.cosMin + lookup.cosSpan * cosStep / (cosSamples - 1);
      const exact = sampleGoldWaferExact(lookup, cosTheta, thicknessNm);
      const fast = sampleGoldLutFast(fastLookup, cosTheta, thicknessNm);
      for (let channel = 0; channel < 3; channel += 1) {
        const error = Math.abs(exact[channel] - fast[channel]);
        if (error > worst.error) {
          worst = { error, thicknessNm, cosTheta, channel, exact: exact[channel], fast: fast[channel] };
        }
      }
    }
  }

  console.info(`gold LUT worst dense-grid cell: ${JSON.stringify(worst)}`);
  assert.ok(worst.error <= quantizationBound, `${worst.error} exceeds ${quantizationBound}`);
});

test('bakes are byte-deterministic and the gzip loader round-trips with CRC checks', async () => {
  const first = bakeGoldLut(sourceTensor);
  const second = bakeGoldLut(sourceTensor);
  assert.deepEqual(first.binary, second.binary);
  assert.deepEqual(first.compressed, second.compressed);
  assert.equal(first.compressedHash, second.compressedHash);

  const parsed = parseGoldLut(first.binary);
  const loaded = await loadGoldLut(first.compressed);
  for (const roundTrip of [parsed, loaded]) {
    assert.equal(roundTrip.width, 600);
    assert.equal(roundTrip.height, 256);
    assert.equal(roundTrip.channelCount, 4);
    assert.equal(roundTrip.contentHash, first.contentHash);
    assert.deepEqual(roundTrip.pixels, first.pixels);
  }

  const badPayload = first.binary.slice();
  badPayload[badPayload.length - 1] ^= 1;
  assert.throws(() => parseGoldLut(badPayload), /payload CRC32 mismatch/);

  const badHeader = first.binary.slice();
  badHeader[GOLD_LUT_FORMAT.offsets.cosMin] ^= 1;
  assert.throws(() => parseGoldLut(badHeader), /header CRC32 mismatch/);
});

function makeArithmeticTensor() {
  const greenByAngle = [10, 20, 40, 70, 110, 160, 200, 225, 240, 250];
  return {
    shape: [10, 600, 3],
    axes: {
      angle_deg: [...GOLD_WAFER_SOURCE.angleDegrees],
      thickness_nm: Array.from({ length: 600 }, (_, index) => 10 + 600 * index / 599),
    },
    data: Array.from({ length: 10 }, (_, angleIndex) => (
      Array.from({ length: 600 }, (_, thicknessIndex) => {
        let red = 20;
        if (thicknessIndex === 0) red = 12;
        if (thicknessIndex === 100) red = 40;
        if (thicknessIndex === 101) red = 80;
        if (thicknessIndex === 102) red = 100;
        if (thicknessIndex === 599) red = 212;
        return [red, greenByAngle[angleIndex], 128];
      })
    )),
  };
}

function assertColorBytes(actual, expectedBytes) {
  for (let channel = 0; channel < 3; channel += 1) {
    assert.ok(
      Math.abs(actual[channel] * 255 - expectedBytes[channel]) < 1e-10,
      `channel ${channel}: expected ${expectedBytes[channel]}, got ${actual[channel] * 255}`,
    );
  }
}
