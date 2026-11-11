// Seeds a colony at the base of the head tentacles and photographs it, to see how
// slime behaves on parts of the body the atlas gives almost no texels.
// usage: node tests/limb-probe.mjs <file.png> [u] [v]
import { openGame } from './browser.mjs';
const { browser, page, problems } = await openGame('http://127.0.0.1:8319/index.html?dev');
const uv = { x: Number(process.argv[3] ?? 0.2894), y: Number(process.argv[4] ?? 0.6352) };
const info = await page.evaluate((uv) => {
  const g = window.__game, V = g.THREE.Vector3;
  const onBody = g.surface.isOnBody(uv);
  const point = g.surface.uvToWorld(uv);
  if (!point) return { onBody, point: null };
  g.model.reset(); g.bodyView.reset();
  g.model.setFood([{ uv, radiusWorld: 0.39, power: 1.55 }]);
  g.model.seed(performance.now(), { uv, durationMs: 0 });
  g.growFast(2500);
  const out = new V(0, point.y, point.z).normalize();
  g.cameraRig.controls.maxPolarAngle = Math.PI;
  g.cameraRig.setPose({ position: point.clone().addScaledVector(out, 2.5), target: point });
  return { onBody, point: point.toArray().map((v) => +v.toFixed(2)), agents: g.model.countAgents() };
}, uv);
console.log(JSON.stringify(info));
await page.waitForTimeout(1500);
await page.screenshot({ path: process.argv[2] });
console.log('problems:', problems.length ? problems : 'none');
await browser.close();
