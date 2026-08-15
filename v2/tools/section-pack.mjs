import { ATLAS_SECTION_VERSION } from '../src/atlas/asset.js';

const MAGIC = Uint8Array.of(0x41, 0x53, 0x45, 0x43, 0x32, 0, 0, 0);
const PREAMBLE_BYTES = 16;
const LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(0x01020304).buffer)[0] === 4;

export function packAtlasSection(arrays, metadata = {}) {
  if (!LITTLE_ENDIAN) throw new Error('ASEC2 packer requires a little-endian host');
  const entries = Object.entries(arrays).map(([name, values]) => {
    if (!ArrayBuffer.isView(values) || values instanceof DataView) throw new TypeError(`ASEC2: ${name} must be a typed array`);
    if (!SUPPORTED_ARRAY_TYPES.has(values.constructor.name)) throw new TypeError(`ASEC2: ${name} has unsupported type ${values.constructor.name}`);
    return { name, values, type: values.constructor.name, length: values.length, byteLength: values.byteLength, byteOffset: 0 };
  });
  let headerBytes;
  let totalBytes;
  for (let pass = 0; pass < 8; pass += 1) {
    headerBytes = new TextEncoder().encode(JSON.stringify({
      metadata,
      arrays: entries.map(({ name, type, length, byteOffset, byteLength }) => ({ name, type, length, byteOffset, byteLength })),
    }));
    let nextOffset = alignTo(PREAMBLE_BYTES + headerBytes.length, 8);
    let changed = false;
    for (const entry of entries) {
      if (entry.byteOffset !== nextOffset) changed = true;
      entry.byteOffset = nextOffset;
      nextOffset = alignTo(nextOffset + entry.byteLength, 8);
    }
    totalBytes = nextOffset;
    if (!changed && pass > 0) break;
  }
  headerBytes = new TextEncoder().encode(JSON.stringify({
    metadata,
    arrays: entries.map(({ name, type, length, byteOffset, byteLength }) => ({ name, type, length, byteOffset, byteLength })),
  }));
  if (entries.length && alignTo(PREAMBLE_BYTES + headerBytes.length, 8) > entries[0].byteOffset) {
    throw new Error('ASEC2: section header layout did not converge');
  }
  const output = new Uint8Array(totalBytes);
  output.set(MAGIC);
  const view = new DataView(output.buffer);
  view.setUint32(8, ATLAS_SECTION_VERSION, true);
  view.setUint32(12, headerBytes.length, true);
  output.set(headerBytes, PREAMBLE_BYTES);
  for (const entry of entries) {
    output.set(new Uint8Array(entry.values.buffer, entry.values.byteOffset, entry.values.byteLength), entry.byteOffset);
  }
  return output;
}

function alignTo(value, alignment) { return Math.ceil(value / alignment) * alignment; }

const SUPPORTED_ARRAY_TYPES = new Set([
  'Float32Array',
  'Uint32Array',
  'Uint16Array',
  'Uint8Array',
  'Int32Array',
]);
