import assert from 'node:assert/strict';
import test from 'node:test';
import { GpuRegistry, calculateTextureBytes } from '../../src/gpu/registry.js';

test('registry accounts buffers and texture bytes and forgets destroyed resources', () => {
  const destroyed = [];
  const fakeDevice = {
    createBuffer: (descriptor) => ({ descriptor, destroy: () => destroyed.push(descriptor.label) }),
    createTexture: (descriptor) => ({ descriptor, destroy: () => destroyed.push(descriptor.label) }),
  };
  const registry = new GpuRegistry(fakeDevice);
  const buffer = registry.createBuffer({ label: 'agents', size: 1024, usage: 1 });
  registry.createTexture({ label: 'field', size: [16, 8], format: 'r32float', usage: 1 });
  assert.equal(registry.totalBytes(), 1024 + 16 * 8 * 4);
  assert.deepEqual(registry.dump().map(({ label }) => label), ['agents', 'field']);
  assert.equal(registry.destroy(buffer), true);
  assert.deepEqual(destroyed, ['agents']);
});

test('texture byte math includes mip levels, array layers, and samples', () => {
  assert.equal(calculateTextureBytes({
    size: { width: 8, height: 4, depthOrArrayLayers: 2 },
    format: 'rgba16float',
    mipLevelCount: 3,
    sampleCount: 2,
  }), (8 * 4 * 2 + 4 * 2 * 2 + 2 * 1 * 2) * 8 * 2);
});

test('registry refuses unlabeled resources and unknown texture formats', () => {
  const fakeDevice = { createBuffer() {}, createTexture() {} };
  const registry = new GpuRegistry(fakeDevice);
  assert.throws(() => registry.createBuffer({ size: 4, usage: 1 }), /requires a label/);
  assert.throws(() => calculateTextureBytes({ size: [1, 1], format: 'mystery' }), /undefined/);
});

