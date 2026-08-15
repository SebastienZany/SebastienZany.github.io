const PROBE_FEATURES = Object.freeze([
  'shader-f16',
  'float32-filterable',
  'texture-formats-tier1',
]);

/**
 * Acquires an adapter and device without turning expected capability gaps into thrown errors.
 * Callers render the returned report; only programmer errors passed into hooks may escape.
 */
export async function acquireDevice({
  gpu = globalThis.navigator?.gpu,
  powerPreference = 'high-performance',
  forceFallbackAdapter = false,
  requiredFeatures = [],
  optionalFeatures = PROBE_FEATURES,
  requiredLimits,
  onDeviceLost,
} = {}) {
  const report = {
    ok: false,
    stage: 'availability',
    message: '',
    adapter: null,
    device: null,
    adapterInfo: {},
    adapterFeatures: [],
    enabledFeatures: [],
    missingRequiredFeatures: [],
  };

  if (!gpu) {
    report.message = 'WebGPU is not exposed by this browser.';
    return report;
  }

  try {
    report.stage = 'adapter';
    report.adapter = await gpu.requestAdapter({ powerPreference, forceFallbackAdapter });
    if (!report.adapter) {
      report.message = 'No WebGPU adapter matched the request.';
      return report;
    }

    report.adapterInfo = await readAdapterInfo(report.adapter);
    report.adapterFeatures = [...report.adapter.features].sort();
    report.missingRequiredFeatures = requiredFeatures.filter((feature) => !report.adapter.features.has(feature));
    if (report.missingRequiredFeatures.length > 0) {
      report.message = `Required WebGPU features are unavailable: ${report.missingRequiredFeatures.join(', ')}`;
      report.stage = 'feature-negotiation';
      return report;
    }

    report.enabledFeatures = [...new Set([...requiredFeatures, ...optionalFeatures])]
      .filter((feature) => report.adapter.features.has(feature));
    report.stage = 'device';
    report.device = await report.adapter.requestDevice({
      requiredFeatures: report.enabledFeatures,
      ...(requiredLimits ? { requiredLimits } : {}),
    });
    report.device.lost.then((lostInfo) => {
      onDeviceLost?.({ reason: lostInfo.reason, message: lostInfo.message });
    });
    report.ok = true;
    report.stage = 'ready';
    report.message = 'WebGPU device acquired.';
    return report;
  } catch (error) {
    report.message = error instanceof Error ? error.message : String(error);
    report.errorName = error?.name || 'Error';
    return report;
  }
}

export async function readAdapterInfo(adapter) {
  let info = adapter.info;
  if (!info && typeof adapter.requestAdapterInfo === 'function') info = await adapter.requestAdapterInfo();
  if (!info) return {};
  const names = new Set([
    ...Object.keys(info),
    'vendor', 'architecture', 'device', 'description', 'isFallbackAdapter', 'subgroupMinSize', 'subgroupMaxSize',
  ]);
  return Object.fromEntries([...names]
    .filter((name) => info[name] !== undefined)
    .map((name) => [name, info[name]]));
}

/**
 * A development-only validation scope. It always balances push/pop, even when operation throws.
 */
export async function withGpuErrorScope(device, label, operation, {
  enabled = true,
  filter = 'validation',
  onError,
} = {}) {
  if (!enabled) return { value: await operation(), error: null };
  device.pushErrorScope(filter);
  let value;
  let thrown;
  try {
    value = await operation();
  } catch (error) {
    thrown = error;
  }
  const error = await device.popErrorScope();
  if (error) onError?.({ label, filter, message: error.message });
  if (thrown) throw thrown;
  return { value, error };
}
