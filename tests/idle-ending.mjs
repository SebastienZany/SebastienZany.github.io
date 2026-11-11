// Leaves the game alone and checks the idle ending: after two minutes without
// input the scene fades to black and the game returns to its start screen with
// a clean world. Takes about three minutes. usage: node tests/idle-ending.mjs [url]
import { openGame } from './browser.mjs';
const { browser, page, problems } = await openGame(process.argv[2] ?? 'http://127.0.0.1:8319/index.html?dev');
const state = () => page.evaluate(() => {
  const g = window.__game;
  return { phase: g.game.flow.phase, agents: g.model.countAgents(), oats: g.game.oats.list.length,
    startScreenShown: getComputedStyle(document.getElementById('startScreen')).display !== 'none'
      && document.getElementById('startScreen').getAttribute('aria-hidden') !== 'true',
    beginVisible: !document.getElementById('startButton').hidden };
});
const startedAt = Date.now();
let last = '';
let sawPlaying = false, sawEnding = false, finished = null;
while (Date.now() - startedAt < 200000) {
  const now = await state();
  if (now.phase !== last) {
    console.log(`${String(Math.round((Date.now() - startedAt) / 1000)).padStart(4)}s  ${JSON.stringify(now)}`);
    last = now.phase;
  }
  sawPlaying ||= now.phase === 'playing';
  sawEnding ||= now.phase === 'ending';
  if (sawPlaying && sawEnding && now.phase === 'ready') { finished = now; break; }
  await page.waitForTimeout(1000);
}
const ok = finished && finished.agents === 0 && finished.oats === 1 && finished.startScreenShown && finished.beginVisible;
console.log(ok ? 'PASS  idle ending returned to a clean start screen' : `FAIL  ${JSON.stringify({ sawPlaying, sawEnding, finished })}`);
console.log('problems:', problems.length ? problems : 'none');
await browser.close();
process.exit(ok ? 0 : 1);
