import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireDevice, withGpuErrorScope } from '../../src/gpu/device.js';

test('device acquisition reports WebGPU absence without throwing', async () => {
  const report = await acquireDevice({ gpu: null });
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'availability');
  assert.match(report.message, /not exposed/);
});

test('required-feature negotiation fails before requesting a device', async () => {
  let deviceRequested = false;
  const adapter = {
    info: { vendor: 'fixture', isFallbackAdapter: false },
    features: new Set(['shader-f16']),
    requestDevice: async () => { deviceRequested = true; },
  };
  const report = await acquireDevice({
    gpu: { requestAdapter: async () => adapter },
    requiredFeatures: ['float32-filterable'],
  });
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'feature-negotiation');
  assert.deepEqual(report.missingRequiredFeatures, ['float32-filterable']);
  assert.equal(deviceRequested, false);
});

test('supported optional features are enabled and device loss reaches the hook', async () => {
  let requestedDescriptor;
  let resolveLost;
  const lost = new Promise((resolve) => { resolveLost = resolve; });
  const device = { lost };
  const adapter = {
    info: { vendor: 'fixture', architecture: 'test', isFallbackAdapter: false },
    features: new Set(['shader-f16', 'float32-filterable']),
    requestDevice: async (descriptor) => { requestedDescriptor = descriptor; return device; },
  };
  const lostMessages = [];
  const report = await acquireDevice({
    gpu: { requestAdapter: async () => adapter },
    optionalFeatures: ['shader-f16', 'texture-formats-tier1'],
    onDeviceLost: (info) => lostMessages.push(info),
  });
  assert.equal(report.ok, true);
  assert.deepEqual(requestedDescriptor.requiredFeatures, ['shader-f16']);
  resolveLost({ reason: 'destroyed', message: 'fixture shutdown' });
  await Promise.resolve();
  assert.deepEqual(lostMessages, [{ reason: 'destroyed', message: 'fixture shutdown' }]);
});

test('development error scope always pops and reports validation errors', async () => {
  const calls = [];
  const device = {
    pushErrorScope: (filter) => calls.push(`push:${filter}`),
    popErrorScope: async () => ({ message: 'bad binding' }),
  };
  const reported = [];
  const result = await withGpuErrorScope(device, 'fixture', async () => 42, {
    onError: (error) => reported.push(error),
  });
  assert.equal(result.value, 42);
  assert.equal(result.error.message, 'bad binding');
  assert.deepEqual(calls, ['push:validation']);
  assert.equal(reported[0].label, 'fixture');
});

