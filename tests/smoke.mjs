// Does the game boot, seed a colony and grow? usage: node tests/smoke.mjs [url] [screenshotPrefix]
import { openGame } from './browser.mjs';
const url = process.argv[2] ?? 'http://127.0.0.1:8319/index.html?dev';
const prefix = process.argv[3];
const { browser, page, ready } = await openGame(url);
if (!ready) {
  console.log('game never became ready; diagnostics:');
  console.log(await page.evaluate(() => document.body.innerText.slice(0, 3000)));
  await browser.close();
  process.exit(1);
}
console.log('surface', await page.evaluate(() => JSON.stringify({ ...__game.surface.stats, worldPerUv: __game.surface.worldPerUv, phase: __game.game.flow.phase, oats: __game.game.oats.list.length })));
const diagLines = (pattern) => page.evaluate((source) => window.__diag.report().split('\n').filter((line) => new RegExp(source).test(line)), pattern);
console.log((await diagLines('game|slime|surface|fatal|load|gold|flow')).join('\n'));
for (const seconds of [3, 10]) {
  await page.waitForTimeout(seconds === 3 ? 3000 : 7000);
  const state = await page.evaluate(() => {
    const g = window.__game;
    return { agents: g.model.countAgents(), steps: g.model.stepCount, phase: g.game.flow.phase, oats: g.game.oats.list.length };
  }).catch((error) => ({ error: String(error).slice(0, 300) }));
  console.log(`t=${seconds}s`, JSON.stringify(state));
  if (prefix) await page.screenshot({ path: `${prefix}_${seconds}s.png` });
}
await browser.close();
