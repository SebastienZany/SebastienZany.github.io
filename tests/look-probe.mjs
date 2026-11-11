// Screenshots of the same moment with look settings varied, to see which layer causes what.
// usage: node tests/look-probe.mjs <prefix> [url]
import { openGame } from './browser.mjs';
const prefix = process.argv[2];
const { browser, page } = await openGame(process.argv[3] ?? 'http://127.0.0.1:8319/index.html?dev');
await page.waitForTimeout(6000);
const variants = {
  normal: {},
  nogold: { showGold: false },
  nodetail: { sculptDetail: 0 },
  nobump: { surfaceBump: 0 },
  thickness: { view: 'thickness' },
  goldonly: { showSlime: false },
};
for (const [name, changes] of Object.entries(variants)) {
  await page.evaluate((changes) => {
    const g = window.__game;
    g.model.params.simulationSteps = 0;
    g.saved ??= { ...g.bodyView.look };
    Object.assign(g.bodyView.look, g.saved, changes);
  }, changes);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${prefix}_${name}.png`, clip: { x: 340, y: 200, width: 600, height: 400 } });
}
await browser.close();
