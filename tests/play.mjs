// Plays the opening like a visitor: waits for Begin, clicks it, watches the
// intro, then drops an oat next to the colony and waits for its story.
// usage: node tests/play.mjs [screenshotPrefix] [url]
import { openGame } from './browser.mjs';
const prefix = process.argv[2];
const { browser, page, problems } = await openGame(process.argv[3] ?? 'http://127.0.0.1:8319/index.html');
const shot = async (name) => { if (prefix) await page.screenshot({ path: `${prefix}_${name}.png` }); };
const phase = () => page.evaluate(() => window.__game.game.flow.phase);
const report = (pattern) => page.evaluate((source) => window.__diag.report().split('\n').filter((l) => new RegExp(source).test(l)).join('\n'), pattern);

await page.waitForSelector('#startButton:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(2500);            // status fades out, Begin fades in
console.log('before begin:', await phase());
await shot('1-start');
await page.click('#startButton');
for (const [name, waitMs] of [['2-intro-3s', 3000], ['3-intro-9s', 6000], ['4-oat-falling-14s', 5000], ['5-seeded-21s', 7000], ['6-grown-27s', 6000]]) {
  await page.waitForTimeout(waitMs);
  console.log(name, await phase(), JSON.stringify(await page.evaluate(() => ({ agents: window.__game.model.countAgents(), oats: window.__game.game.oats.list.length }))));
  await shot(name);
}

// Drop an oat a little way from the colony, by a real click on the canvas.
const target = await page.evaluate(() => {
  const g = window.__game;
  const origin = g.game.oats.initial;
  const point = origin.point.clone().add(new g.THREE.Vector3(0.95, 0, 0.45).multiplyScalar(g.ctx.slimeSize));
  const projected = point.project(g.ctx.camera);
  const rect = g.ctx.dom.canvas.getBoundingClientRect();
  return { x: rect.left + (projected.x * 0.5 + 0.5) * rect.width, y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height };
});
await page.mouse.click(target.x, target.y);
// A resting pointer pushes the slime away; take it off the body (in two moves:
// pointer tracking is rate-limited, so one instant hop can be skipped).
await page.waitForTimeout(120);
await page.mouse.move(20, 20);
await page.waitForTimeout(120);
await page.mouse.move(5, 5);
await page.waitForTimeout(300);
console.log('after click: oats =', await page.evaluate(() => window.__game.game.oats.list.length));
await page.evaluate(() => window.__game.growFast(2500));
for (const [name, waitMs] of [['7-oat-reached', 1500], ['8-story-6s', 5000], ['9-story-16s', 10000]]) {
  await page.waitForTimeout(waitMs);
  const coverage = await page.evaluate(() => window.__game.model.coverageNear(window.__game.game.oats.list.map((o) => o.uv)));
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.story-layer > *')].map((el) => (el.innerText || '').replace(/\s+/g, ' ').slice(0, 90)));
  console.log(name, 'coverage', coverage.map((v) => +v.toFixed(3)), 'story boxes', JSON.stringify(boxes));
  await shot(name);
}
console.log(await report('flow|audio|stories|game|slime|fatal|error'));
console.log('problems:', problems.length ? problems : 'none');
await browser.close();
