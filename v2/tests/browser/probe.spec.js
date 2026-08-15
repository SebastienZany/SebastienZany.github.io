import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect } from './gpu-fixture.js';

test('probe proves hardware GPU smoke checks and the five-second workload', async ({ page, browser, hardwareAdapter }) => {
  test.setTimeout(180_000); // M0's workload gate intentionally exceeds Playwright's 30 s default.
  await page.goto('/v2/probe.html');
  await page.evaluate(() => window.__probe.ready);

  await expect(page.locator('[data-check="device-acquisition"] strong')).toHaveText('PASS');
  await expect(page.locator('[data-check="compute-sum"] strong')).toHaveText('PASS');
  await expect(page.locator('[data-check="render-smoke"] strong')).toHaveText('PASS');

  const rehearsal = await page.evaluate(() => window.__probe.runWorkload({ size: 1536, durationMs: 5000 }));
  expect(rehearsal.status, rehearsal.message).toBe('PASS');
  expect(rehearsal.peakAllocation.status).toBe('PASS');
  expect(rehearsal.rows.some((row) => row.maximumLegalSettings && row.fillPath === rehearsal.actualFillPath)).toBe(true);
  if (rehearsal.actualFillPath === 'read_write') {
    expect(rehearsal.rows.some((row) => row.fillPath === 'staging-copy')).toBe(true);
  }

  await page.locator('#copy-json').click();
  await expect(page.locator('#copy-status')).toHaveText('Copied.');
  const copiedJson = await page.evaluate(() => navigator.clipboard.readText());
  const copiedReport = JSON.parse(copiedJson);
  expect(copiedReport.checks['compute-sum'].status).toBe('PASS');
  expect(copiedReport.workloadRehearsals.at(-1).status).toBe('PASS');
  await recordMacProbeResult(browser.version(), hardwareAdapter, copiedReport);
});

async function recordMacProbeResult(chromeVersion, hardwareAdapter, report) {
  const resultPath = fileURLToPath(new URL('../../reference/probe-results.md', import.meta.url));
  const existing = await readFile(resultPath, 'utf8');
  const start = '<!-- mac-chrome:start -->';
  const end = '<!-- mac-chrome:end -->';
  const entry = `${start}\n## Mac Chrome ${chromeVersion}\n\n`
    + `- Recorded: ${new Date().toISOString()}\n`
    + '- Harness: Playwright system Chrome channel, headless=true, no extra launch flags.\n'
    + '- GPU gate: `adapter.info.isFallbackAdapter === false`.\n'
    + `- Adapter identity: \`${JSON.stringify(hardwareAdapter)}\`\n\n`
    + '```json\n'
    + `${JSON.stringify(report, null, 2)}\n`
    + '```\n'
    + `${end}`;
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  const updated = pattern.test(existing) ? existing.replace(pattern, entry) : `${existing.trim()}\n\n${entry}\n`;
  await writeFile(resultPath, updated);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
