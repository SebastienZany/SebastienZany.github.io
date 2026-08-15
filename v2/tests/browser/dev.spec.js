import { test, expect } from './gpu-fixture.js';

test('dev harness clears to the legacy scene colour without uncaptured errors', async ({ page }) => {
  await page.goto('/v2/dev.html');
  await page.evaluate(() => window.__v2.ready);
  const result = await page.evaluate(async () => ({
    pixel: await window.__v2.readClearPixel(),
    uncapturedErrors: [...window.__v2.uncapturedErrors],
    registryBytes: window.__v2.registry.totalBytes(),
  }));
  expect(result.uncapturedErrors).toEqual([]);
  expect(result.pixel).toHaveLength(4);
  for (const [actual, expected] of result.pixel.map((value, index) => [value, [1, 2, 1, 255][index]])) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
  }
  expect(result.registryBytes).toBe(256);
  await expect(page.locator('#errors')).toBeHidden();
});

