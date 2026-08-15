import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  hardwareAdapter: [async ({ page }, use, testInfo) => {
    const identity = await page.evaluate(async () => {
      if (!navigator.gpu) return null;
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      const info = adapter.info || await adapter.requestAdapterInfo?.() || {};
      return {
        vendor: info.vendor ?? '',
        architecture: info.architecture ?? '',
        device: info.device ?? '',
        description: info.description ?? '',
        isFallbackAdapter: info.isFallbackAdapter,
      };
    });
    expect(identity, 'The browser must expose a WebGPU adapter').not.toBeNull();
    expect(
      identity.isFallbackAdapter,
      `Hardware adapter required; secondary identity: ${JSON.stringify(identity)}`,
    ).toBe(false);
    const diagnostic = JSON.stringify(identity);
    testInfo.annotations.push({ type: 'adapter', description: diagnostic });
    await testInfo.attach('adapter-identity.json', {
      body: Buffer.from(`${JSON.stringify(identity, null, 2)}\n`),
      contentType: 'application/json',
    });
    await use(identity);
  }, { auto: true }],
});

export { expect } from '@playwright/test';

