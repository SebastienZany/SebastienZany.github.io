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

test('real MESH1 material look renders its world-painted field without validation errors', async ({ page }, testInfo) => {
  await page.goto('/v2/look.html?mesh=1');
  await page.evaluate(() => window.__v2.ready);
  const result = await page.evaluate(async () => ({
    stats: await window.__v2.look.renderTestFrame(),
    nonFiniteCount: await window.__v2.look.scanForNonFinite(),
    uncapturedErrors: [...window.__v2.look.uncapturedErrors],
    meshMode: window.__v2.look.meshMode,
    meshStats: window.__v2.look.meshStats,
    fieldStats: window.__v2.look.fieldStats,
  }));

  expect(result.uncapturedErrors).toEqual([]);
  expect(result.nonFiniteCount).toBe(0);
  expect(result.meshMode).toBe('mesh1');
  expect(result.meshStats).toEqual({
    name: 'MESH1 cuttlefish',
    vertexCount: 281_981,
    triangleCount: 501_428,
    indexCount: 1_504_284,
    indexFormat: 'uint32',
  });
  expect(result.fieldStats.mode).toBe('world-surface');
  expect(result.fieldStats.paintedTexelCount).toBeGreaterThan(30_000);
  expect(result.stats.nonBackgroundFrac).toBeGreaterThan(0.05);
  expect(result.stats.nonBackgroundFrac).toBeLessThan(0.9);
  expect(result.stats.maxLum).toBeGreaterThan(0.05);
  expect(result.stats.maxLum).toBeLessThanOrEqual(1);
  await expect(page.locator('#errors')).toBeHidden();
  await expect(page.locator('#scopeBanner')).toBeVisible();
  await expect(page.locator('#scopeBanner')).toHaveText(
    'original UVs + synthetic field ⇒ seams will be visible and that is CORRECT here — F4 owns seam-correct display on the repacked atlas.',
  );

  const artifactPath = 'reference/f3-real-mesh.png';
  await page.screenshot({ path: artifactPath });
  await testInfo.attach('f3-real-mesh.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
