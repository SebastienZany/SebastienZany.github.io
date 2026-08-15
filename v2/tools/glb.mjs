import { readFile } from 'node:fs/promises';

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

export async function readGlb(filePath) {
  return parseGlb(await readFile(filePath), filePath);
}

export function parseGlb(input, sourceName = 'GLB input') {
  const bytes = asByteView(input, sourceName);
  const header = viewAt(bytes, 0, 12, `${sourceName} header`);
  expect(header.getUint32(0, true) === GLB_MAGIC, `${sourceName}: invalid GLB magic`);
  expect(header.getUint32(4, true) === GLB_VERSION, `${sourceName}: expected GLB version 2`);
  expect(
    header.getUint32(8, true) === bytes.byteLength,
    `${sourceName}: declared byte length does not match the file`,
  );

  const chunks = readChunks(bytes, sourceName);
  expect(chunks.length === 2, `${sourceName}: expected exactly JSON and BIN chunks`);
  expect(chunks[0].type === JSON_CHUNK, `${sourceName}: first chunk is not JSON`);
  expect(chunks[1].type === BIN_CHUNK, `${sourceName}: second chunk is not BIN`);

  let document;
  try {
    document = JSON.parse(new TextDecoder().decode(chunks[0].bytes).trimEnd());
  } catch (error) {
    throw new Error(`${sourceName}: invalid JSON chunk`, { cause: error });
  }
  validateDocumentShape(document, chunks[1].bytes.byteLength, sourceName);

  const primitive = document.meshes[0].primitives[0];
  const accessorContext = { document, bin: chunks[1].bytes, sourceName };
  const positions = readFloatAccessor(accessorContext, primitive.attributes.POSITION, 'POSITION', 'VEC3');
  const normals = readFloatAccessor(accessorContext, primitive.attributes.NORMAL, 'NORMAL', 'VEC3');
  const uv0 = readFloatAccessor(accessorContext, primitive.attributes.TEXCOORD_0, 'TEXCOORD_0', 'VEC2');
  const indices = readIndexAccessor(accessorContext, primitive.indices);

  expect(normals.length === positions.length, `${sourceName}: NORMAL count differs from POSITION`);
  expect(uv0.length / 2 === positions.length / 3, `${sourceName}: TEXCOORD_0 count differs from POSITION`);
  expect(indices.length % 3 === 0, `${sourceName}: index count is not divisible by three`);

  return { positions, normals, uv0, indices, document };
}

function readChunks(bytes, sourceName) {
  const chunks = [];
  let byteOffset = 12;
  while (byteOffset < bytes.byteLength) {
    const chunkHeader = viewAt(bytes, byteOffset, 8, `${sourceName} chunk header`);
    const byteLength = chunkHeader.getUint32(0, true);
    const type = chunkHeader.getUint32(4, true);
    expect(byteLength % 4 === 0, `${sourceName}: chunk length is not four-byte aligned`);
    const payloadOffset = byteOffset + 8;
    viewAt(bytes, payloadOffset, byteLength, `${sourceName} chunk payload`);
    chunks.push({ type, bytes: bytes.subarray(payloadOffset, payloadOffset + byteLength) });
    byteOffset = payloadOffset + byteLength;
  }
  expect(byteOffset === bytes.byteLength, `${sourceName}: chunk table overruns the file`);
  return chunks;
}

function validateDocumentShape(document, binChunkLength, sourceName) {
  expect(!document.extensionsUsed?.length, `${sourceName}: GLB extensions are unsupported`);
  expect(!document.extensionsRequired?.length, `${sourceName}: required GLB extensions are unsupported`);
  expect(document.buffers?.length === 1, `${sourceName}: expected one buffer`);
  expect(document.buffers[0].byteLength <= binChunkLength, `${sourceName}: BIN chunk is shorter than its buffer`);
  expect(document.meshes?.length === 1, `${sourceName}: expected one mesh`);
  expect(document.meshes[0].primitives?.length === 1, `${sourceName}: expected one mesh primitive`);
  const primitive = document.meshes[0].primitives[0];
  expect((primitive.mode ?? 4) === 4, `${sourceName}: primitive is not a triangle list`);
  expect(Number.isInteger(primitive.indices), `${sourceName}: primitive has no index accessor`);
  expect(
    Object.keys(primitive.attributes ?? {}).sort().join(',') === 'NORMAL,POSITION,TEXCOORD_0',
    `${sourceName}: expected exactly POSITION, NORMAL, and TEXCOORD_0 attributes`,
  );
}

function readFloatAccessor(context, accessorIndex, semantic, expectedType) {
  const { accessor, bytes } = accessorBytes(context, accessorIndex, semantic, FLOAT, expectedType);
  return copyTypedArray(Float32Array, bytes, accessor.count * componentCount(expectedType), semantic);
}

function readIndexAccessor(context, accessorIndex) {
  const { accessor, bytes } = accessorBytes(context, accessorIndex, 'indices', undefined, 'SCALAR');
  expect(
    accessor.componentType === UNSIGNED_SHORT || accessor.componentType === UNSIGNED_INT,
    `${context.sourceName}: indices must use unsigned 16-bit or 32-bit components`,
  );
  if (accessor.componentType === UNSIGNED_INT) {
    return copyTypedArray(Uint32Array, bytes, accessor.count, 'indices');
  }
  const source = copyTypedArray(Uint16Array, bytes, accessor.count, 'indices');
  return Uint32Array.from(source);
}

function accessorBytes(context, accessorIndex, semantic, expectedComponentType, expectedType) {
  const { document, bin, sourceName } = context;
  expect(Number.isInteger(accessorIndex), `${sourceName}: ${semantic} accessor is missing`);
  const accessor = document.accessors?.[accessorIndex];
  expect(accessor, `${sourceName}: ${semantic} accessor ${accessorIndex} does not exist`);
  expect(!accessor.sparse, `${sourceName}: sparse ${semantic} accessors are unsupported`);
  expect(!accessor.normalized, `${sourceName}: normalized ${semantic} accessors are unsupported`);
  expect(accessor.type === expectedType, `${sourceName}: ${semantic} must be ${expectedType}`);
  if (expectedComponentType !== undefined) {
    expect(
      accessor.componentType === expectedComponentType,
      `${sourceName}: ${semantic} has unexpected component type ${accessor.componentType}`,
    );
  }
  expect(Number.isInteger(accessor.count) && accessor.count > 0, `${sourceName}: ${semantic} has invalid count`);

  const bufferView = document.bufferViews?.[accessor.bufferView];
  expect(bufferView, `${sourceName}: ${semantic} bufferView ${accessor.bufferView} does not exist`);
  expect(bufferView.buffer === 0, `${sourceName}: ${semantic} does not reference buffer zero`);
  const scalarBytes = bytesPerComponent(accessor.componentType, sourceName, semantic);
  const packedStride = componentCount(expectedType) * scalarBytes;
  expect(
    bufferView.byteStride === undefined || bufferView.byteStride === packedStride,
    `${sourceName}: ${semantic} is not tightly packed`,
  );
  const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const byteLength = accessor.count * packedStride;
  expect(
    byteOffset + byteLength <= (bufferView.byteOffset ?? 0) + bufferView.byteLength,
    `${sourceName}: ${semantic} accessor overruns its bufferView`,
  );
  expect(byteOffset + byteLength <= bin.byteLength, `${sourceName}: ${semantic} accessor overruns the BIN chunk`);
  return { accessor, bytes: bin.subarray(byteOffset, byteOffset + byteLength) };
}

function copyTypedArray(ArrayType, bytes, length, semantic) {
  expect(bytes.byteLength === length * ArrayType.BYTES_PER_ELEMENT, `${semantic}: byte length mismatch`);
  const copy = bytes.slice();
  return new ArrayType(copy.buffer, copy.byteOffset, length).slice();
}

function componentCount(type) {
  return { SCALAR: 1, VEC2: 2, VEC3: 3 }[type];
}

function bytesPerComponent(componentType, sourceName, semantic) {
  const byteLength = { [FLOAT]: 4, [UNSIGNED_SHORT]: 2, [UNSIGNED_INT]: 4 }[componentType];
  expect(byteLength, `${sourceName}: ${semantic} uses unsupported component type ${componentType}`);
  return byteLength;
}

function viewAt(bytes, byteOffset, byteLength, context) {
  expect(byteOffset + byteLength <= bytes.byteLength, `${context}: truncated data`);
  return new DataView(bytes.buffer, bytes.byteOffset + byteOffset, byteLength);
}

function asByteView(input, sourceName) {
  expect(ArrayBuffer.isView(input) || input instanceof ArrayBuffer, `${sourceName}: expected binary data`);
  return input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}
