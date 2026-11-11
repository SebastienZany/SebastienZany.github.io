// Two story boxes that overlap on screen, and the camera orbiting until they
// swap depth order. Checks that the blur on each box changes gradually through
// the swap instead of jumping. usage: node tests/story-depth.mjs [screenshotPrefix] [url]
import { openGame } from './browser.mjs';
const prefix = process.argv[2];
const { browser, page, problems } = await openGame(process.argv[3] ?? 'http://127.0.0.1:8319/index.html?dev');
await page.waitForTimeout(4000);

// Two oats either side of the colony, close enough that their boxes overlap.
const placed = await page.evaluate(() => {
  const g = window.__game, origin = g.game.oats.initial, reach = 1.15 * g.ctx.slimeSize;
  const oats = [];
  for (const side of [-1, 1]) {
    const target = origin.point.clone().add(new g.THREE.Vector3(side * reach, 0, 0.3 * reach * side)).project(g.ctx.camera);
    const hit = g.surface.raycast(new g.THREE.Vector2(target.x, target.y), g.ctx.camera);
    const oat = hit && g.game.placeOat(hit, performance.now());
    if (oat) oats.push(oat.id);
  }
  g.growFast(2500);
  return oats;
});
console.log('oats placed:', placed.length);
await page.waitForTimeout(9000);   // marker fade, glass in, first lines

const read = () => page.evaluate(() => {
  const g = window.__game;
  return [...document.querySelectorAll('.story-box.is-visible')].map((box, i) => {
    const content = box.querySelector('.story-content');
    const blur = Number((content.style.filter.match(/blur\(([\d.]+)px\)/) ?? [0, 0])[1]);
    return { z: Number(box.style.zIndex), blur, left: parseFloat(box.style.left), top: parseFloat(box.style.top) };
  });
});
const orbit = (degrees) => page.evaluate((degrees) => {
  const g = window.__game, c = g.ctx.camera, target = g.cameraRig.controls.target;
  const offset = c.position.clone().sub(target).applyAxisAngle(new g.THREE.Vector3(0, 1, 0), degrees * Math.PI / 180);
  g.cameraRig.controls.enableDamping = false;
  g.cameraRig.setPose({ position: target.clone().add(offset), target: target.clone() });
}, degrees);

const samples = [];
const STEP = 2;
await orbit(-70);
for (let angle = -70; angle <= 70; angle += STEP) {
  await page.waitForTimeout(60);
  const boxes = await read();
  if (boxes.length >= 2) samples.push({ angle, front: boxes[0].z > boxes[1].z ? 0 : 1, blur: boxes.map((b) => b.blur) });
  if (prefix && [-70, 0, 70].includes(angle)) await page.screenshot({ path: `${prefix}_${angle}.png` });
  await orbit(STEP);
}
let flips = 0, biggestJump = 0, peakBlur = 0, blurAtFlip = null;
for (let i = 1; i < samples.length; i++) {
  if (samples[i].front !== samples[i - 1].front) {
    flips++;
    blurAtFlip = Math.max(...samples[i].blur, ...samples[i - 1].blur);
    if (prefix) console.log('flip between', samples[i - 1].angle, 'and', samples[i].angle);
  }
  for (const k of [0, 1]) {
    biggestJump = Math.max(biggestJump, Math.abs(samples[i].blur[k] - samples[i - 1].blur[k]));
    peakBlur = Math.max(peakBlur, samples[i].blur[k]);
  }
}
console.log(JSON.stringify({ samples: samples.length, flips, peakBlurPx: peakBlur, blurAtFlipPx: blurAtFlip, biggestJumpPxPerStep: +biggestJump.toFixed(2) }));
console.log('blur of each box across the sweep:', samples.filter((_, i) => i % 5 === 0).map((s) => `${s.angle}:${s.blur.map((b) => b.toFixed(1)).join('/')}`).join('  '));
const ok = samples.length > 20 && flips >= 1 && blurAtFlip < 0.6 && biggestJump < 1.5 && peakBlur > 2;
console.log(ok ? 'PASS  boxes hand over gradually' : 'FAIL');
console.log('problems:', problems.length ? problems : 'none');
await browser.close();
process.exit(ok ? 0 : 1);
