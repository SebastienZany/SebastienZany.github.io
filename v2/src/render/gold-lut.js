const CRC32_TABLE = makeCrc32Table();

export const GOLD_LUT_FORMAT = Object.freeze({
  magic: 'GLUT',
  version: 1,
  headerBytes: 96,
  channelCount: 4,
  componentTypeUnorm8: 1,
  offsets: Object.freeze({
    magic: 0,
    version: 4,
    headerBytes: 6,
    width: 8,
    height: 12,
    channelCount: 16,
    componentType: 18,
    payloadBytes: 20,
    payloadCrc32: 24,
    headerCrc32: 28,
    minThicknessNm: 32,
    thicknessSpanNm: 40,
    cosMin: 48,
    cosSpan: 56,
    contentHash: 64,
  }),
});

export function crc32(input) {
  const bytes = asByteView(input);
  let checksum = 0xffff_ffff;
  for (const byte of bytes) checksum = CRC32_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  return (checksum ^ 0xffff_ffff) >>> 0;
}

export function goldLutHeaderCrc32(input) {
  const bytes = asByteView(input);
  if (bytes.byteLength < GOLD_LUT_FORMAT.headerBytes) {
    throw new Error('gold LUT is shorter than its header');
  }
  const header = bytes.slice(0, GOLD_LUT_FORMAT.headerBytes);
  const crcOffset = GOLD_LUT_FORMAT.offsets.headerCrc32;
  header.fill(0, crcOffset, crcOffset + 4);
  return crc32(header);
}

export function parseGoldLut(input) {
  const bytes = asByteView(input);
  const format = GOLD_LUT_FORMAT;
  if (bytes.byteLength < format.headerBytes) throw new Error('gold LUT is shorter than its header');

  const header = new DataView(bytes.buffer, bytes.byteOffset, format.headerBytes);
  assertMagic(bytes);
  assertEqual(header.getUint16(format.offsets.version, true), format.version, 'version');
  assertEqual(header.getUint16(format.offsets.headerBytes, true), format.headerBytes, 'header size');
  assertEqual(header.getUint16(format.offsets.channelCount, true), format.channelCount, 'channel count');
  assertEqual(
    header.getUint16(format.offsets.componentType, true),
    format.componentTypeUnorm8,
    'component type',
  );

  const storedHeaderCrc = header.getUint32(format.offsets.headerCrc32, true);
  const actualHeaderCrc = goldLutHeaderCrc32(bytes);
  if (actualHeaderCrc !== storedHeaderCrc) throw new Error('gold LUT header CRC32 mismatch');

  const width = header.getUint32(format.offsets.width, true);
  const height = header.getUint32(format.offsets.height, true);
  const payloadByteLength = header.getUint32(format.offsets.payloadBytes, true);
  const expectedPayloadBytes = width * height * format.channelCount;
  if (width === 0 || height === 0 || !Number.isSafeInteger(expectedPayloadBytes)) {
    throw new Error('gold LUT dimensions are invalid');
  }
  if (payloadByteLength !== expectedPayloadBytes) {
    throw new Error('gold LUT payload size does not match its dimensions');
  }
  if (bytes.byteLength !== format.headerBytes + payloadByteLength) {
    throw new Error('gold LUT file size does not match its header');
  }

  const minThicknessNm = header.getFloat64(format.offsets.minThicknessNm, true);
  const thicknessSpanNm = header.getFloat64(format.offsets.thicknessSpanNm, true);
  const cosMin = header.getFloat64(format.offsets.cosMin, true);
  const cosSpan = header.getFloat64(format.offsets.cosSpan, true);
  if (![minThicknessNm, thicknessSpanNm, cosMin, cosSpan].every(Number.isFinite)
      || thicknessSpanNm <= 0 || cosSpan <= 0) {
    throw new Error('gold LUT coordinate mapping is invalid');
  }

  const pixels = bytes.subarray(format.headerBytes);
  const storedPayloadCrc = header.getUint32(format.offsets.payloadCrc32, true);
  if (crc32(pixels) !== storedPayloadCrc) throw new Error('gold LUT payload CRC32 mismatch');

  const hashOffset = format.offsets.contentHash;
  const contentHash = bytesToHex(bytes.subarray(hashOffset, hashOffset + 32));
  return {
    width,
    height,
    channelCount: format.channelCount,
    minThicknessNm,
    thicknessSpanNm,
    cosMin,
    cosSpan,
    contentHash,
    pixels,
  };
}

export async function loadGoldLut(source) {
  const compressedBytes = await readCompressedBytes(source);
  if (typeof DecompressionStream !== 'function') {
    throw new Error('this runtime cannot decompress the gold LUT gzip asset');
  }
  const compressedStream = new Blob([compressedBytes]).stream();
  const inflatedStream = compressedStream.pipeThrough(new DecompressionStream('gzip'));
  const inflatedBytes = await new Response(inflatedStream).arrayBuffer();
  return parseGoldLut(inflatedBytes);
}

function assertMagic(bytes) {
  for (let index = 0; index < GOLD_LUT_FORMAT.magic.length; index += 1) {
    if (bytes[index] !== GOLD_LUT_FORMAT.magic.charCodeAt(index)) {
      throw new Error('gold LUT magic is invalid');
    }
  }
}

function assertEqual(actual, expected, field) {
  if (actual !== expected) throw new Error(`gold LUT ${field} ${actual} is unsupported`);
}

async function readCompressedBytes(source) {
  if (typeof source === 'string' || source instanceof URL || source instanceof Request) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`gold LUT request failed with HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  if (source instanceof Response) {
    if (!source.ok) throw new Error(`gold LUT response failed with HTTP ${source.status}`);
    return new Uint8Array(await source.arrayBuffer());
  }
  if (source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  return asByteView(source);
}

function asByteView(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('gold LUT bytes must be an ArrayBuffer or typed-array view');
}

function bytesToHex(bytes) {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function makeCrc32Table() {
  const polynomial = 0xedb8_8320;
  return Uint32Array.from({ length: 256 }, (_, seed) => {
    let value = seed;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) === 1 ? polynomial : 0);
    }
    return value >>> 0;
  });
}
