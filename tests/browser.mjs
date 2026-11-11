// Shared helper for the browser checks: opens the game in headless Chrome.
// Needs Playwright; point PLAYWRIGHT_PATH at its index.mjs if it is not installed here.
export async function openGame(url, { width = 1280, height = 800, quiet = false } = {}) {
  const { chromium } = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright');
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${String(error).slice(0, 500)}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text().slice(0, 500)}`);
  });
  page.on('response', (response) => { if (response.status() >= 400) problems.push(`http ${response.status()}: ${response.url()}`); });
  await page.goto(url, { waitUntil: 'load' });
  const ready = await page.waitForFunction(() => window.__game, null, { timeout: 60000 }).then(() => true).catch(() => false);
  if (!quiet) for (const problem of problems) console.log('  !', problem);
  return { browser, page, problems, ready };
}
