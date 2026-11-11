// Frame times with several overlapping story boxes on screen while the camera
// orbits (so the boxes keep swapping depth). usage: node tests/story-perf.mjs [url] [boxes]
import { openGame } from './browser.mjs';
const url = process.argv[2] ?? 'http://127.0.0.1:8319/index.html?dev';
const wanted = Number(process.argv[3] ?? 5);
const { browser, page, problems } = await openGame(url, { deviceScaleFactor: 2, quiet: true });
await page.waitForTimeout(4000);

const measure = (frames, orbiting) => page.evaluate(([frames, orbiting]) => new Promise((resolve) => {
  const g = window.__game, c = g.ctx.camera, target = g.cameraRig.controls.target, axis = new g.THREE.Vector3(0, 1, 0);
  g.cameraRig.controls.enableDamping = false;
  const times = [];
  let last = null;
  const tick = (now) => {
    if (last !== null) times.push(now - last);
    last = now;
    if (orbiting) {
      const offset = c.position.clone().sub(target).applyAxisAngle(axis, Math.PI / 180);
      g.cameraRig.setPose({ position: target.clone().add(offset), target: target.clone() });
    }
    if (times.length < frames) requestAnimationFrame(tick);
    else {
      times.sort((a, b) => a - b);
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      resolve({ fps: +(1000 / mean).toFixed(1), meanMs: +mean.toFixed(2), p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(2), worstMs: +times[times.length - 1].toFixed(2), over20ms: times.filter((t) => t > 20).length });
    }
  };
  requestAnimationFrame(tick);
}), [frames, orbiting]);

console.log('no story boxes, orbiting :', JSON.stringify(await measure(360, true)));

const placed = await page.evaluate((wanted) => {
  const g = window.__game, origin = g.game.oats.initial, reach = 1.15 * g.ctx.slimeSize;
  let count = 0;
  for (let ring = 1; ring <= 2 && count < wanted; ring++) {
    for (let k = 0; k < 6 && count < wanted; k++) {
      const a = (k / 6) * 2 * Math.PI + ring;
      const target = origin.point.clone().add(new g.THREE.Vector3(Math.cos(a) * reach * ring, 0, Math.sin(a) * reach * ring)).project(g.ctx.camera);
      const hit = g.surface.raycast(new g.THREE.Vector2(target.x, target.y), g.ctx.camera);
      if (hit && g.game.placeOat(hit, performance.now())) count++;
    }
  }
  g.growFast(3500);
  return count;
}, wanted);
await page.waitForTimeout(10000);
const shown = await page.evaluate(() => ({
  boxes: document.querySelectorAll('.story-box.is-visible').length,
  blurred: [...document.querySelectorAll('.story-content')].filter((el) => /blur/.test(el.style.filter)).length,
}));
console.log(`oats placed ${placed}, story boxes on screen ${shown.boxes}, of which blurred now ${shown.blurred}`);
console.log(`${shown.boxes} story boxes, still      :`, JSON.stringify(await measure(360, false)));
console.log(`${shown.boxes} story boxes, orbiting   :`, JSON.stringify(await measure(720, true)));
if (problems.length) console.log('problems:', problems.slice(0, 4));
await browser.close();
