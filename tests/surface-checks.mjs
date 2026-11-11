// Checks of how the slime handles the atlas, on the real mesh:
//   1. it crosses the cut: a colony seeded on one side shows up on the other;
//   2. nothing lives off the body: texels just beyond it hold far-side values (for
//      filtering), texels far from it hold nothing.
// usage: node tests/surface-checks.mjs [url]
import { openGame } from './browser.mjs';
const { browser, page, problems } = await openGame(process.argv[2] ?? 'http://127.0.0.1:8319/index.html?dev');
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failures++; };

const crossings = await page.evaluate(async () => {
  const g = window.__game, size = g.surface.fieldSize, seam = g.surface.textures.seam.image.data;
  // Body texels 6 texels inside a cut, spread along it.
  const candidates = [];
  for (let y = 8; y < size - 8; y += 3) for (let x = 8; x < size - 8; x += 3) {
    const i = (y * size + x) * 4;
    if (seam[i] === 0 && seam[i + 1] === 0) continue;
    const uv = { x: (x + 0.5) / size, y: (y + 0.5) / size };
    if (!g.surface.isOnBody(uv)) continue;
    const across = { x: seam[i] * uv.x - seam[i + 1] * uv.y + seam[i + 2], y: seam[i + 1] * uv.x + seam[i] * uv.y + seam[i + 3] };
    // `across` is this texel's image beyond the far edge; it must be off the body for the texel to be near the cut.
    if (g.surface.isOnBody(across)) continue;
    const off = (dx, dy) => !g.surface.isOnBody({ x: uv.x + dx / size, y: uv.y + dy / size });
    if (!(off(8, 0) || off(-8, 0) || off(0, 8) || off(0, -8)) || off(4, 0) || off(-4, 0) || off(0, 4) || off(0, -4)) continue;
    candidates.push({ uv, across });
  }
  const picks = [0.15, 0.5, 0.85].map((f) => candidates[Math.floor(f * (candidates.length - 1))]);
  const results = [];
  for (const pick of picks) {
    g.model.reset();
    g.model.setFood([{ uv: pick.uv, radiusWorld: 0.39 * g.ctx.slimeSize, power: 1.55 }]);
    g.model.seed(performance.now(), { uv: pick.uv, durationMs: 0 });
    g.growFast(900);
    const field = g.model.readThickness();
    // Mean thickness on body texels within 14 texels of the far-side image point.
    const cx = Math.round(pick.across.x * size), cy = Math.round(pick.across.y * size);
    let sum = 0, n = 0;
    for (let dy = -14; dy <= 14; dy++) for (let dx = -14; dx <= 14; dx++) {
      const uv = { x: (cx + dx + 0.5) / size, y: (cy + dy + 0.5) / size };
      if (!g.surface.isOnBody(uv)) continue;
      sum += field[((cy + dy) * size + cx + dx) * 4]; n++;
    }
    const here = await g.model.coverageNear([pick.uv]);
    results.push({ seededAt: [pick.uv.x.toFixed(3), pick.uv.y.toFixed(3)], farSideTexels: n, farSideMean: n ? sum / n : 0, nearPeak: here[0], agents: g.model.countAgents() });
  }
  return { candidates: candidates.length, results };
});
console.log(`cut: ${crossings.candidates} candidate texels`);
for (const r of crossings.results) {
  check('slime crosses the cut', r.farSideTexels > 20 && r.farSideMean > 0.01, JSON.stringify(r));
}

const padding = await page.evaluate(() => {
  const g = window.__game, size = g.surface.fieldSize, seam = g.surface.textures.seam.image.data;
  const field = g.model.readThickness();
  let offBodyFarLit = 0, offBodyFar = 0, padLit = 0;
  for (let i = 0; i < size * size; i++) {
    const uv = { x: ((i % size) + 0.5) / size, y: (Math.floor(i / size) + 0.5) / size };
    if (g.surface.isOnBody(uv)) continue;
    const hasMap = seam[i * 4] !== 0 || seam[i * 4 + 1] !== 0;
    if (hasMap) { if (field[i * 4] > 0.001) padLit++; continue; }
    offBodyFar++;
    if (field[i * 4] !== 0) offBodyFarLit++;
  }
  return { offBodyFar, offBodyFarLit, padLit };
});
check('no slime far off the body', padding.offBodyFarLit === 0, JSON.stringify(padding));
check('texels just off the body carry far-side slime', padding.padLit > 0, `${padding.padLit} padded texels lit`);
check('no page errors', problems.length === 0, problems.join(' | ') || 'none');
await browser.close();
process.exit(failures ? 1 : 0);
