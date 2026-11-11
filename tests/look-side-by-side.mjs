// Screenshots of the old and new game at the same moment after seeding, with all layers and with the gold layer alone.
// usage: node tests/look-side-by-side.mjs <prefix> [seconds]
import { openGame } from './browser.mjs';
const prefix = process.argv[2];
const seconds = Number(process.argv[3] ?? 20);
const clip = { x: 340, y: 150, width: 600, height: 450 };
const [older, newer] = await Promise.all([
  openGame('http://127.0.0.1:8317/index.html?dev', { quiet: true }),
  openGame('http://127.0.0.1:8319/index.html?dev', { quiet: true }),
]);
await Promise.all([older.page.waitForTimeout(seconds * 1000), newer.page.waitForTimeout(seconds * 1000)]);
for (const [name, game] of [['old', older], ['new', newer]]) {
  await game.page.screenshot({ path: `${prefix}_${name}_all.png`, clip });
  await game.page.keyboard.press('1');
  await game.page.waitForTimeout(500);
  await game.page.screenshot({ path: `${prefix}_${name}_gold.png`, clip });
}
await Promise.all([older.browser.close(), newer.browser.close()]);
