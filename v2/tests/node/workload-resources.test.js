import assert from 'node:assert/strict';
import test from 'node:test';
import { GpuRegistry } from '../../src/gpu/registry.js';
import { createWorkloadResources, destroyWorkloadResources } from '../../src/gpu/probe/workload-resources.js';

test('1024 rehearsal allocates the full set with structure-valid measured-volume donors', () => {
  globalThis.GPUTextureUsage = Object.freeze({
    COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
  });
  globalThis.GPUBufferUsage = Object.freeze({ STORAGE: 1, COPY_DST: 2 });
  const destroyed = [];
  const fakeDevice = {
    createTexture: ({ label }) => ({ label, destroy: () => destroyed.push(label) }),
    createBuffer: ({ label, size, mappedAtCreation }) => {
      const mapped = mappedAtCreation ? new ArrayBuffer(size) : null;
      return {
        label,
        mapped,
        getMappedRange: () => mapped,
        unmap() {},
        destroy: () => destroyed.push(label),
      };
    },
  };
  const registry = new GpuRegistry(fakeDevice);
  const resources = createWorkloadResources(fakeDevice, registry, 1024, {
    r16RenderAndFilter: true,
    rgba16Storage: true,
  });
  assert.equal(resources.gutterFraction, 0.47);
  assert.equal(resources.gutterRecordCount, Math.floor(1024 ** 2 * 0.47));
  assert.equal(resources.displayFormat, 'r16float');
  assert.ok(registry.totalBytes() > 120 * 2 ** 20 && registry.totalBytes() < 170 * 2 ** 20);

  const records = new Uint32Array(resources.donorRecords.mapped);
  for (let recordIndex = 0; recordIndex < resources.gutterRecordCount; recordIndex += 1) {
    const base = recordIndex * 7;
    assert.ok(records[base] >= resources.authoritativeTexelCount);
    assert.ok(records[base] < resources.textureCount);
    for (let donor = 1; donor <= 4; donor += 1) {
      assert.ok(records[base + donor] < resources.authoritativeTexelCount);
    }
  }
  destroyWorkloadResources(registry, resources);
  assert.equal(registry.totalBytes(), 0);
  assert.equal(destroyed.length, resources.all.length);
});
