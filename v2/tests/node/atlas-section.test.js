import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
  loadAtlasManifest,
  loadAtlasSections,
  parseAtlasSection,
} from '../../src/atlas/asset.js';
import { buildAtlasBundle } from '../../tools/asset-bundle.mjs';
import { packAtlasSection } from '../../tools/section-pack.mjs';

test('ASEC2 round-trips named aligned typed arrays', () => {
  const packed = packAtlasSection({
    uv1: Float32Array.of(0.25, 0.75),
    owner: Uint32Array.of(0, 7, 65_536),
    flags: Uint8Array.of(1, 2, 3),
  }, { fieldSize: 64, role: 'fixture' });
  const parsed = parseAtlasSection(packed);
  assert.deepEqual(parsed.metadata, { fieldSize: 64, role: 'fixture' });
  assert.deepEqual([...parsed.arrays.uv1], [0.25, 0.75]);
  assert.deepEqual([...parsed.arrays.owner], [0, 7, 65_536]);
  assert.ok(parsed.descriptors.every(({ byteOffset }) => byteOffset % 8 === 0));
});

test('manifest root and each uncompressed content hash are independently enforced', async () => {
  const section = packAtlasSection({ values: Uint16Array.of(1, 2, 3) }, { fieldSize: 32 });
  const bundle = buildAtlasBundle([{ name: 'fixture', size: 32, bytes: section }], {
    targets: [{ fieldSize: 32 }],
  });
  const base = 'https://atlas.test/assets/atlas-manifest.json';
  const fetchImpl = bundleFetch(bundle, base);
  const loaded = await loadAtlasSections(base, {
    expectedRootHash: bundle.manifest.rootHash,
    expectedSchemaVersion: bundle.manifest.schemaVersion,
    fetchImpl,
    decompress: (bytes) => new Uint8Array(gunzipSync(bytes)),
  });
  assert.deepEqual([...loaded.sections.fixture.arrays.values], [1, 2, 3]);

  await assert.rejects(loadAtlasManifest(base, {
    expectedRootHash: '0'.repeat(64),
    expectedSchemaVersion: bundle.manifest.schemaVersion,
    fetchImpl,
  }), /incompatible with this build/);

  await assert.rejects(loadAtlasSections(base, {
    expectedRootHash: bundle.manifest.rootHash,
    expectedSchemaVersion: bundle.manifest.schemaVersion,
    fetchImpl,
    decompress: (bytes) => {
      const changed = new Uint8Array(gunzipSync(bytes));
      changed[changed.length - 1] ^= 1;
      return changed;
    },
  }), /section hash mismatch/);
});

function bundleFetch(bundle, manifestUrl) {
  const files = new Map([...bundle.files].map(([name, bytes]) => [new URL(name, manifestUrl).href, bytes]));
  files.set(manifestUrl, bundle.files.get('atlas-manifest.json'));
  return async (input) => {
    const bytes = files.get(String(input));
    return bytes ? new Response(bytes, { status: 200 }) : new Response('', { status: 404 });
  };
}
