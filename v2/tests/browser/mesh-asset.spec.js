import { expect, test } from '@playwright/test';

test('browser loader fetches the audited MESH1 asset', async ({ page }) => {
  await page.goto('/v2/index.html');
  const result = await page.evaluate(async () => {
    const [{ parseMeshAsset }, assetResponse, reportResponse] = await Promise.all([
      import('/v2/src/atlas/asset.js'),
      fetch('/v2/assets/mesh-1.bin'),
      fetch('/v2/assets/mesh-report.md'),
    ]);
    if (!assetResponse.ok || !reportResponse.ok) throw new Error('mesh asset fetch failed');
    const [assetBuffer, report] = await Promise.all([
      assetResponse.arrayBuffer(),
      reportResponse.text(),
    ]);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', assetBuffer));
    const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const reportHash = report.match(/\| mesh-1\.bin \| `([a-f0-9]{64})` \|/)?.[1];
    const asset = parseMeshAsset(assetBuffer);
    return {
      sha256,
      reportHash,
      vertexCount: asset.vertexCount,
      triangleCount: asset.triangleCount,
      chartCount: asset.chartCount,
      seamPairCount: asset.seamPairCount,
      directionalSideCount: asset.directionalSideCount,
      slitComponentCount: asset.slitComponentCount,
    };
  });

  expect(result).toEqual({
    sha256: 'dbf3f43570ffb3de9f71cbf3dd28d3f33a62768b431c3127db9cae1c90b8bde3',
    reportHash: 'dbf3f43570ffb3de9f71cbf3dd28d3f33a62768b431c3127db9cae1c90b8bde3',
    vertexCount: 281_981,
    triangleCount: 501_428,
    chartCount: 1_233,
    seamPairCount: 30_034,
    directionalSideCount: 60_068,
    slitComponentCount: 630,
  });
});
