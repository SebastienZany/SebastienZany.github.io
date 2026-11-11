// Opens the settings panel and saves a screenshot. usage: node tests/panel-shot.mjs <file.png> [url]
import { openGame } from './browser.mjs';
const { browser, page, problems } = await openGame(process.argv[3] ?? 'http://127.0.0.1:8319/index.html?dev');
await page.waitForTimeout(4000);
await page.keyboard.press('p');
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelectorAll('.panel details').forEach((d, i) => { d.open = i < 2 || i === 4; }));
await page.screenshot({ path: process.argv[2] });
console.log('problems:', problems.length ? problems : 'none');
await browser.close();
