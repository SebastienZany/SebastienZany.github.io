import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { manifestBinding, stableStringify } from '../src/atlas/asset.js';
import { ATLAS_SCHEMA_VERSION, MAX_SECTION_BYTES } from './atlas-constants.mjs';

export const ATLAS_MANIFEST_NAME = 'atlas-manifest.json';

// Hashes bind the uncompressed section contents. Compression is transport-only and may change
// without changing the manifest identity or allowing mismatched tables to load together.
export function buildAtlasBundle(sectionInputs, {
  schemaVersion = ATLAS_SCHEMA_VERSION,
  targets,
  bakeUuid,
} = {}) {
  if (!Array.isArray(sectionInputs) || sectionInputs.length === 0) {
    throw new Error('atlas bundle: at least one section is required');
  }
  const names = new Set();
  const files = new Map();
  const sections = sectionInputs.map(({ name, size, bytes }) => {
    if (!name || names.has(name)) throw new Error(`atlas bundle: duplicate or empty section name ${name ?? ''}`);
    names.add(name);
    const source = byteView(bytes);
    const sha256 = hashHex(source);
    const compressed = gzipSync(source, { level: 9, mtime: 0 });
    assertFileSize(compressed.byteLength, name);
    const file = `atlas-${size}.${name}.${sha256.slice(0, 8)}.bin.gz`;
    files.set(file, new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength));
    return {
      name,
      size,
      file,
      sha256,
      uncompressedBytes: source.byteLength,
      compressedBytes: compressed.byteLength,
    };
  });
  sections.sort((left, right) => left.size - right.size || left.name.localeCompare(right.name));
  const deterministicUuid = bakeUuid ?? uuidFromHash(hashHex(stableStringify({ schemaVersion, sections, targets })));
  const manifest = { bakeUuid: deterministicUuid, schemaVersion, targets, sections };
  manifest.rootHash = hashHex(stableStringify(manifestBinding(manifest)));
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  assertFileSize(manifestBytes.byteLength, ATLAS_MANIFEST_NAME);
  files.set(ATLAS_MANIFEST_NAME, manifestBytes);
  return { manifest, files };
}

export async function writeAtlasBundle(outputDirectory, bundle) {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([...bundle.files].map(([name, bytes]) => writeFile(resolve(outputDirectory, name), bytes)));
}

export function freshBakeUuid() { return randomUUID(); }

function byteView(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (!ArrayBuffer.isView(input)) throw new TypeError('atlas bundle: section bytes must be binary');
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

function assertFileSize(byteLength, name) {
  if (byteLength >= MAX_SECTION_BYTES) {
    throw new Error(`atlas bundle: ${name} is ${byteLength} bytes; every emitted file must be below ${MAX_SECTION_BYTES}`);
  }
}

function hashHex(value) { return createHash('sha256').update(value).digest('hex'); }

function uuidFromHash(hash) {
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
