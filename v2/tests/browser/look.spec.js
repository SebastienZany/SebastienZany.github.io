import { expect, test } from './gpu-fixture.js';

test('fixture material look renders finite slime and gold without validation errors', async ({ page }, testInfo) => {
  await page.goto('/v2/look.html');
  await page.evaluate(() => window.__v2.ready);
  const result = await page.evaluate(async () => ({
    stats: await window.__v2.look.renderTestFrame(),
    nonFiniteCount: await window.__v2.look.scanForNonFinite(),
    uncapturedErrors: [...window.__v2.look.uncapturedErrors],
    registryBytes: window.__v2.look.registry.totalBytes(),
  }));

  expect(result.uncapturedErrors).toEqual([]);
  expect(result.nonFiniteCount).toBe(0);
  expect(result.stats.nonBackgroundFrac).toBeGreaterThan(0.05);
  expect(result.stats.nonBackgroundFrac).toBeLessThan(0.9);
  expect(result.stats.maxLum).toBeGreaterThan(0.05);
  expect(result.stats.maxLum).toBeLessThanOrEqual(1);
  expect(result.registryBytes).toBeGreaterThan(256 * 256 * 4);
  await expect(page.locator('#errors')).toBeHidden();
  await expect(page.locator('#controls input')).toHaveCount(19);

  const artifactPath = 'reference/f2-material-look.png';
  await page.screenshot({ path: artifactPath });
  await testInfo.attach('f2-material-look.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
