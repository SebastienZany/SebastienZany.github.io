// MESH1 is little-endian. Its 48-byte preamble carries version and mesh counts, followed by
// 24-byte section descriptors {id, offset, byteLength, CRC32, recordCount, recordStride}.
// Sections begin on eight-byte boundaries so browser and Node loaders can expose typed views.
const MAGIC_BYTES = Uint8Array.of(0x4d, 0x45, 0x53, 0x48, 0x31, 0, 0, 0);
const PREAMBLE_BYTES = 48;
const SECTION_ENTRY_BYTES = 24;

export const MESH_ASSET_VERSION = 1;
export const NO_SLIT_COMPONENT = 0xffffffff;

export const MESH_SECTIONS = Object.freeze({
  positions: { id: 1, stride: 12, countFrom: 'vertexCount' },
  normals: { id: 2, stride: 12, countFrom: 'vertexCount' },
  uv0: { id: 3, stride: 8, countFrom: 'vertexCount' },
  indices: { id: 4, stride: 4, countFrom: 'indexCount' },
  triangleChartIds: { id: 5, stride: 4, countFrom: 'triangleCount' },
  charts: { id: 6, stride: 32, countFrom: 'chartCount' },
  seamPairs: { id: 7, stride: 56, countFrom: 'seamPairCount' },
  slitComponents: { id: 8, stride: 24, countFrom: 'slitComponentCount' },
});

const SECTION_NAMES_BY_ID = new Map(
  Object.entries(MESH_SECTIONS).map(([name, definition]) => [definition.id, name]),
);

export function parseMeshAsset(input, { verifyCrc = true } = {}) {
  const bytes = alignedByteView(input);
  requireCondition(bytes.byteLength >= PREAMBLE_BYTES, 'MESH1: truncated header');
  for (let index = 0; index < MAGIC_BYTES.length; index += 1) {
    requireCondition(bytes[index] === MAGIC_BYTES[index], 'MESH1: invalid magic');
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  requireCondition(header.getUint32(8, true) === MESH_ASSET_VERSION, 'MESH1: unsupported version');
  const headerByteLength = header.getUint32(12, true);
  const sectionCount = header.getUint32(16, true);
  requireCondition(sectionCount === Object.keys(MESH_SECTIONS).length, 'MESH1: unexpected section count');
  requireCondition(
    headerByteLength === alignTo(PREAMBLE_BYTES + sectionCount * SECTION_ENTRY_BYTES, 8),
    'MESH1: invalid header length',
  );
  requireCondition(headerByteLength <= bytes.byteLength, 'MESH1: header overruns input');

  const counts = {
    vertexCount: header.getUint32(20, true),
    triangleCount: header.getUint32(24, true),
    chartCount: header.getUint32(28, true),
    seamPairCount: header.getUint32(32, true),
    directionalSideCount: header.getUint32(36, true),
    slitComponentCount: header.getUint32(40, true),
  };
  counts.indexCount = counts.triangleCount * 3;
  requireCondition(counts.directionalSideCount === counts.seamPairCount * 2, 'MESH1: side count mismatch');

  const sectionEntries = readSectionEntries(header, sectionCount, counts, headerByteLength, bytes.byteLength);
  const rawSections = {};
  for (const [name, entry] of Object.entries(sectionEntries)) {
    const sectionBytes = bytes.subarray(entry.byteOffset, entry.byteOffset + entry.byteLength);
    if (verifyCrc) {
      requireCondition(crc32(sectionBytes) === entry.crc32, `MESH1: CRC mismatch in ${name}`);
    }
    rawSections[name] = sectionBytes;
  }

  return {
    version: MESH_ASSET_VERSION,
    ...counts,
    positions: typedSection(Float32Array, rawSections.positions),
    normals: typedSection(Float32Array, rawSections.normals),
    uv0: typedSection(Float32Array, rawSections.uv0),
    indices: typedSection(Uint32Array, rawSections.indices),
    triangleChartIds: typedSection(Uint32Array, rawSections.triangleChartIds),
    charts: decodeCharts(rawSections.charts),
    seamPairs: decodeSeamPairs(rawSections.seamPairs),
    slitComponents: decodeSlitComponents(rawSections.slitComponents),
    rawSections,
    sectionEntries,
  };
}

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function meshAssetHeaderLayout() {
  return {
    magicBytes: MAGIC_BYTES.slice(),
    preambleBytes: PREAMBLE_BYTES,
    sectionEntryBytes: SECTION_ENTRY_BYTES,
    headerBytes: alignTo(PREAMBLE_BYTES + Object.keys(MESH_SECTIONS).length * SECTION_ENTRY_BYTES, 8),
  };
}

function readSectionEntries(header, sectionCount, counts, headerByteLength, assetByteLength) {
  const entries = {};
  const ranges = [];
  for (let entryIndex = 0; entryIndex < sectionCount; entryIndex += 1) {
    const offset = PREAMBLE_BYTES + entryIndex * SECTION_ENTRY_BYTES;
    const id = header.getUint32(offset, true);
    const name = SECTION_NAMES_BY_ID.get(id);
    requireCondition(name && !entries[name], `MESH1: unknown or duplicate section ${id}`);
    const entry = {
      id,
      byteOffset: header.getUint32(offset + 4, true),
      byteLength: header.getUint32(offset + 8, true),
      crc32: header.getUint32(offset + 12, true),
      recordCount: header.getUint32(offset + 16, true),
      recordStride: header.getUint32(offset + 20, true),
    };
    const definition = MESH_SECTIONS[name];
    requireCondition(entry.recordStride === definition.stride, `MESH1: invalid ${name} stride`);
    requireCondition(entry.recordCount === counts[definition.countFrom], `MESH1: invalid ${name} count`);
    requireCondition(entry.byteLength === entry.recordCount * entry.recordStride, `MESH1: invalid ${name} length`);
    requireCondition(entry.byteOffset % 8 === 0, `MESH1: unaligned ${name} section`);
    requireCondition(entry.byteOffset >= headerByteLength, `MESH1: ${name} overlaps the header`);
    requireCondition(entry.byteOffset + entry.byteLength <= assetByteLength, `MESH1: ${name} overruns input`);
    entries[name] = entry;
    ranges.push([entry.byteOffset, entry.byteOffset + entry.byteLength, name]);
  }
  requireCondition(Object.keys(entries).length === Object.keys(MESH_SECTIONS).length, 'MESH1: missing section');
  ranges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    requireCondition(ranges[index - 1][1] <= ranges[index][0], `MESH1: overlapping ${ranges[index][2]} section`);
  }
  return entries;
}

function decodeCharts(bytes) {
  const view = dataView(bytes);
  const records = [];
  for (let byteOffset = 0; byteOffset < bytes.byteLength; byteOffset += MESH_SECTIONS.charts.stride) {
    records.push({
      triangleCount: view.getUint32(byteOffset, true),
      uvBounds: [0, 1, 2, 3].map((index) => view.getFloat32(byteOffset + 8 + index * 4, true)),
      uvArea: view.getFloat64(byteOffset + 24, true),
    });
  }
  return records;
}

function decodeSeamPairs(bytes) {
  const view = dataView(bytes);
  const records = [];
  for (let byteOffset = 0; byteOffset < bytes.byteLength; byteOffset += MESH_SECTIONS.seamPairs.stride) {
    const side0 = {
      triangleIndex: view.getUint32(byteOffset, true),
      vertex0: view.getUint32(byteOffset + 8, true),
      vertex1: view.getUint32(byteOffset + 12, true),
      chartId: view.getUint32(byteOffset + 24, true),
      uvAltitude: view.getFloat32(byteOffset + 44, true),
    };
    const side1 = {
      triangleIndex: view.getUint32(byteOffset + 4, true),
      vertex0: view.getUint32(byteOffset + 16, true),
      vertex1: view.getUint32(byteOffset + 20, true),
      chartId: view.getUint32(byteOffset + 28, true),
      uvAltitude: view.getFloat32(byteOffset + 48, true),
    };
    records.push({
      sides: [side0, side1],
      slitComponentId: view.getUint32(byteOffset + 32, true),
      isSlit: Boolean(view.getUint32(byteOffset + 36, true) & 1),
      foldAngleRadians: view.getFloat32(byteOffset + 40, true),
      coincidenceError: view.getFloat32(byteOffset + 52, true),
    });
  }
  return records;
}

function decodeSlitComponents(bytes) {
  const view = dataView(bytes);
  const records = [];
  for (let byteOffset = 0; byteOffset < bytes.byteLength; byteOffset += MESH_SECTIONS.slitComponents.stride) {
    records.push({
      chartId: view.getUint32(byteOffset, true),
      edgeCount: view.getUint32(byteOffset + 4, true),
      maxBranchDegree: view.getUint32(byteOffset + 8, true),
      branchVertexCount: view.getUint32(byteOffset + 12, true),
      closedLoop: Boolean(view.getUint32(byteOffset + 16, true)),
    });
  }
  return records;
}

function typedSection(ArrayType, bytes) {
  return new ArrayType(bytes.buffer, bytes.byteOffset, bytes.byteLength / ArrayType.BYTES_PER_ELEMENT);
}

function dataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function alignedByteView(input) {
  requireCondition(ArrayBuffer.isView(input) || input instanceof ArrayBuffer, 'MESH1: expected binary input');
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return bytes.byteOffset % 8 === 0 ? bytes : bytes.slice();
}

function alignTo(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

const ATLAS_SECTION_MAGIC = Uint8Array.of(0x41, 0x53, 0x45, 0x43, 0x32, 0, 0, 0);
const ATLAS_SECTION_PREAMBLE_BYTES = 16;

export const ATLAS_SECTION_VERSION = 2;

export function parseAtlasSection(input) {
  const bytes = alignedByteView(input);
  requireCondition(bytes.byteLength >= ATLAS_SECTION_PREAMBLE_BYTES, 'ASEC2: truncated preamble');
  for (let index = 0; index < ATLAS_SECTION_MAGIC.length; index += 1) {
    requireCondition(bytes[index] === ATLAS_SECTION_MAGIC[index], 'ASEC2: invalid magic');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  requireCondition(view.getUint32(8, true) === ATLAS_SECTION_VERSION, 'ASEC2: unsupported version');
  const headerLength = view.getUint32(12, true);
  requireCondition(ATLAS_SECTION_PREAMBLE_BYTES + headerLength <= bytes.byteLength, 'ASEC2: truncated header');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(
    ATLAS_SECTION_PREAMBLE_BYTES,
    ATLAS_SECTION_PREAMBLE_BYTES + headerLength,
  )));
  requireCondition(Array.isArray(header.arrays), 'ASEC2: missing array table');
  const arrays = {};
  for (const descriptor of header.arrays) {
    const ArrayType = ARRAY_TYPES[descriptor.type];
    requireCondition(ArrayType && typeof descriptor.name === 'string', 'ASEC2: invalid array descriptor');
    requireCondition(descriptor.byteOffset % 8 === 0, `ASEC2: ${descriptor.name} is unaligned`);
    requireCondition(
      descriptor.byteOffset + descriptor.byteLength <= bytes.byteLength,
      `ASEC2: ${descriptor.name} overruns section`,
    );
    requireCondition(
      descriptor.byteLength === descriptor.length * ArrayType.BYTES_PER_ELEMENT,
      `ASEC2: ${descriptor.name} length mismatch`,
    );
    requireCondition(!arrays[descriptor.name], `ASEC2: duplicate ${descriptor.name}`);
    arrays[descriptor.name] = new ArrayType(
      bytes.buffer,
      bytes.byteOffset + descriptor.byteOffset,
      descriptor.length,
    );
  }
  return { metadata: header.metadata ?? {}, arrays, descriptors: header.arrays };
}

export async function loadAtlasManifest(manifestUrl, {
  expectedRootHash,
  expectedSchemaVersion,
  fetchImpl = fetch,
} = {}) {
  const response = await fetchImpl(manifestUrl);
  if (!response.ok) throw new Error(`Atlas manifest request failed (${response.status})`);
  const manifest = await response.json();
  const schemaVersion = expectedSchemaVersion ?? manifest.schemaVersion;
  if (manifest.schemaVersion !== schemaVersion) {
    throw new Error(`Atlas assets are incompatible: schema ${manifest.schemaVersion}, code expects ${schemaVersion}`);
  }
  const calculatedRoot = await sha256Hex(new TextEncoder().encode(stableStringify(manifestBinding(manifest))));
  if (manifest.rootHash !== calculatedRoot) throw new Error('Atlas manifest is corrupt: root hash disagrees with its contents');
  if (expectedRootHash && manifest.rootHash !== expectedRootHash) {
    throw new Error('Atlas assets are incompatible with this build; refresh the page to clear cached files');
  }
  return manifest;
}

export async function loadAtlasSections(manifestUrl, options = {}) {
  const manifest = await loadAtlasManifest(manifestUrl, options);
  const sections = {};
  for (const entry of manifest.sections) {
    const response = await (options.fetchImpl ?? fetch)(new URL(entry.file, manifestUrl));
    if (!response.ok) throw new Error(`Atlas section request failed for ${entry.name} (${response.status})`);
    const compressed = new Uint8Array(await response.arrayBuffer());
    const inflated = options.decompress
      ? await options.decompress(compressed)
      : await decompressGzip(compressed);
    const bytes = inflated instanceof Uint8Array ? inflated : new Uint8Array(inflated);
    const actualHash = await sha256Hex(bytes);
    if (actualHash !== entry.sha256) throw new Error(`Atlas section hash mismatch: ${entry.name}`);
    sections[entry.name] = parseAtlasSection(bytes);
  }
  return { manifest, sections };
}

export function readAtlasShellBinding(documentImpl = document) {
  const rootHash = documentImpl.querySelector('meta[name="atlas-manifest-root"]')?.content;
  const schemaText = documentImpl.querySelector('meta[name="atlas-schema-version"]')?.content;
  const schemaVersion = Number(schemaText);
  if (!rootHash || rootHash === 'unbaked' || !Number.isInteger(schemaVersion)) {
    throw new Error('Atlas assets are not bound to this build; run the matching M2 bake');
  }
  return { expectedRootHash: rootHash, expectedSchemaVersion: schemaVersion };
}

export function loadAtlasSectionsFromShell(manifestUrl, options = {}) {
  const binding = readAtlasShellBinding(options.documentImpl);
  return loadAtlasSections(manifestUrl, { ...options, ...binding });
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function manifestBinding(manifest) {
  return {
    bakeUuid: manifest.bakeUuid,
    schemaVersion: manifest.schemaVersion,
    sections: manifest.sections,
    targets: manifest.targets,
  };
}

async function decompressGzip(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot decompress atlas gzip sections');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

const ARRAY_TYPES = Object.freeze({
  Float32Array,
  Uint32Array,
  Uint16Array,
  Uint8Array,
  Int32Array,
});
