// Runs the old game and the new one side by side from a fresh colony and prints
// the same statistics for both over time: how many agents are alive, how much
// of the atlas carries slime, and how much slime there is in total.
// usage: node tests/compare-legacy.mjs [oldUrl] [newUrl] [seconds,comma,separated]
import { openGame } from './browser.mjs';
const oldUrl = process.argv[2] ?? 'http://127.0.0.1:8317/index.html?dev';
const newUrl = process.argv[3] ?? 'http://127.0.0.1:8319/index.html?dev';
const times = (process.argv[4] ?? '3,10,20,40').split(',').map(Number);

const { chromium } = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright');
async function openOld() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(oldUrl);
  await page.waitForFunction(() => window.__cuttle?.oats?.length, null, { timeout: 120000 });
  return { browser, page };
}
const statsOf = (thicknessStride) => `
  let lit = 0, sum = 0, peak = 0;
  for (let i = 0; i < field.length; i += ${thicknessStride}) { const v = field[i]; if (v > 0.05) lit++; sum += v; if (v > peak) peak = v; }
  return { agents, litTexels: lit, total: Math.round(sum), peak: +peak.toFixed(3) };`;
const readOld = new Function(`
  const c = window.__cuttle;
  const a = c.dumpAgents(); let agents = 0;
  for (let i = 3; i < a.length; i += 4) if (a[i] > 0) agents++;
  const field = c.dumpField(c.fieldRT.read);
  ${statsOf(4)}`);
const readNew = new Function(`
  const g = window.__game;
  const agents = g.model.countAgents();
  const field = g.model.readThickness();
  ${statsOf(4)}`);

const [older, newer] = await Promise.all([openOld(), openGame(newUrl)]);
let last = 0;
for (const t of times) {
  await Promise.all([older.page.waitForTimeout((t - last) * 1000), newer.page.waitForTimeout((t - last) * 1000)]);
  last = t;
  const [a, b] = await Promise.all([older.page.evaluate(readOld), newer.page.evaluate(readNew)]);
  console.log(`t=${String(t).padStart(3)}s  old ${JSON.stringify(a)}\n         new ${JSON.stringify(b)}`);
}
await Promise.all([older.browser.close(), newer.browser.close()]);
