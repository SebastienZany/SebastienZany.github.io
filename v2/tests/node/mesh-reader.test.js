import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readGlb } from '../../tools/glb.mjs';
import { boundsExtents, normalizeGeometry } from '../../tools/mesh.mjs';

const meshPath = fileURLToPath(new URL('../../../luyvwj-fwgyww.glb', import.meta.url));

test('known GLB reader returns the audited mesh attributes', async () => {
  const mesh = await readGlb(meshPath);
  assert.equal(mesh.positions.length / 3, 281_981);
  assert.equal(mesh.indices.length / 3, 501_428);
  assert.equal(mesh.normals.length, mesh.positions.length);
  assert.equal(mesh.uv0.length / 2, mesh.positions.length / 3);

  for (const [name, values] of Object.entries({
    positions: mesh.positions,
    normals: mesh.normals,
    uv0: mesh.uv0,
    indices: mesh.indices,
  })) {
    assert.ok(values.every(Number.isFinite), `${name} contains a non-finite value`);
  }
  let epsilonOutsideCount = 0;
  for (const value of mesh.uv0) {
    if (value < 0 || value > 1) epsilonOutsideCount += 1;
  }
  assert.equal(epsilonOutsideCount, 0, 'UV scalars outside [0, 1]');
});

test('normalization reproduces the legacy centered 9.6-unit frame', async () => {
  const mesh = await readGlb(meshPath);
  const sourceSnapshot = mesh.positions.slice();
  const normalized = normalizeGeometry(mesh.positions);
  assert.deepEqual(mesh.positions, sourceSnapshot, 'normalization mutated its input');

  const extents = boundsExtents(normalized.normalizedBounds);
  assert.ok(Math.abs(Math.max(...extents) - 9.6) <= 1e-5);
  for (let axis = 0; axis < 3; axis += 1) {
    const centered = normalized.normalizedBounds.min[axis] + normalized.normalizedBounds.max[axis];
    assert.ok(Math.abs(centered) <= 1e-5, `axis ${axis} is not centered`);
  }
});
