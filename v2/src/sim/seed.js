import { AGENT_BYTES, DEFAULT_OAT_RADIUS, TAU } from './constants.js';
import { createSeedStream } from './rng.js';

export function buildSeedAgents({ count, randomSeed, params, oats }) {
  const data = new ArrayBuffer(count * AGENT_BYTES);
  const floats = new Float32Array(data);
  const uints = new Uint32Array(data);
  const stream = createSeedStream(randomSeed);
  const identities = new Set();
  const sources = oats.length > 0 ? oats : [{ uvPos: [0.5, 0.5], radiusUv: DEFAULT_OAT_RADIUS }];
  for (let index = 0; index < count; index += 1) {
    const source = sources[Math.floor(stream.nextFloat() * sources.length) % sources.length];
    const radiusUv = Math.max(source.radiusUv ?? DEFAULT_OAT_RADIUS, 0.004) * 2.5;
    const distance = Math.sqrt(stream.nextFloat()) * radiusUv;
    const angle = stream.nextFloat() * TAU;
    const base = index * 8;
    floats[base] = wrap(source.uvPos[0] + Math.cos(angle) * distance);
    floats[base + 1] = wrap(source.uvPos[1] + Math.sin(angle) * distance);
    floats[base + 2] = stream.nextFloat() * TAU;
    floats[base + 3] = params.reproThreshold * 0.6;
    let idLo;
    let idHi;
    let key;
    do {
      idLo = stream.nextU32();
      idHi = stream.nextU32();
      key = `${idHi}:${idLo}`;
    } while (identities.has(key));
    identities.add(key);
    uints[base + 4] = idLo;
    uints[base + 5] = idHi;
    uints[base + 6] = 0;
    uints[base + 7] = 0;
  }
  return data;
}

export function normalizeOats(oats, defaultPeakFood) {
  return oats.map((oat, index) => {
    const uvPos = oat.uvPos ?? oat.uv ?? [oat.x, oat.y];
    if (!Array.isArray(uvPos) || uvPos.length !== 2 || !uvPos.every(Number.isFinite)) {
      throw new TypeError(`Oat ${index} requires a finite UV position`);
    }
    const radiusUv = Number(oat.radiusUv ?? oat.radius ?? DEFAULT_OAT_RADIUS);
    const peakFood = Number(oat.peakFood ?? oat.power ?? defaultPeakFood);
    if (!Number.isFinite(radiusUv) || radiusUv <= 0 || !Number.isFinite(peakFood) || peakFood < 0) {
      throw new RangeError(`Oat ${index} has an invalid radius or peak`);
    }
    return { uvPos: [wrap(uvPos[0]), wrap(uvPos[1])], radiusUv, peakFood };
  });
}

export function packOats(oats, maxOats) {
  const packed = new Float32Array(maxOats * 4);
  for (let index = 0; index < oats.length; index += 1) {
    const oat = oats[index];
    packed.set([oat.uvPos[0], oat.uvPos[1], oat.radiusUv, oat.peakFood], index * 4);
  }
  return packed;
}

function wrap(value) {
  return ((value % 1) + 1) % 1;
}
