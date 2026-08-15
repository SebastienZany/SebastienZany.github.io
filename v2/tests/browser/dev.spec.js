import { test, expect } from './gpu-fixture.js';

test('dev harness presents a live flat-torus simulation without uncaptured errors', async ({ page }, testInfo) => {
  await page.goto('/v2/dev.html?field=64&cap=512&seed=128&paused=1');
  await page.evaluate(() => window.__v2.ready);
  const result = await page.evaluate(async () => ({
    uncapturedErrors: [...window.__v2.uncapturedErrors],
    registryBytes: window.__v2.registry.totalBytes(),
    count: await window.__v2.sim.count(),
    api: ['step', 'seed', 'count', 'hashState'].map((name) => typeof window.__v2.sim[name]),
  }));
  expect(result.uncapturedErrors).toEqual([]);
  expect(result.count).toBe(128);
  expect(result.api).toEqual(['function', 'function', 'function', 'function']);
  expect(result.registryBytes).toBeGreaterThan(256);
  await expect(page.locator('#errors')).toBeHidden();
  await expect(page.locator('#controls input')).toHaveCount(10);
  await page.evaluate(async () => {
    for (let index = 0; index < 40; index += 1) window.__v2.sim.step(1);
    await window.__v2.device.queue.onSubmittedWorkDone();
  });
  await page.waitForTimeout(100);
  await testInfo.attach('m3-dev-growth.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
