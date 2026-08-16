#!/usr/bin/env node
// Why does slowly-scrolling text snap, and what actually stops it?
//
// The real render takes ~3 minutes to reach the callout's slow glide, which made
// every hypothesis cost half an hour to disprove. This reproduces the exact
// condition in isolation — EB Garamond text translated 0.1118 css px per frame,
// the artwork's glide rate — and measures the rasterised displacement per frame
// across candidate fixes. Same cross-correlation metric as the video analysis.
//
//   node replay/snap-probe.mjs

const pwRoot = process.env.PLAYWRIGHT_PATH ?? 'playwright';
const { chromium } = await import(pwRoot);

const STEP_CSS = 0.1118;   // measured scroll rate at 60fps
const FRAMES = 24;
const CSS_W = 400;
const CSS_H = 200;

const PAGE = (mode) => `<!doctype html><meta charset=utf-8>
<style>
  html,body{margin:0;background:#000;overflow:hidden}
  #box{position:absolute;left:20px;top:20px;width:360px;height:160px;overflow:hidden;
       ${mode.boxCss ?? ''}}
  #roll{position:absolute;left:0;top:0;width:100%;
        font:400 15px/1.6 Georgia,'EB Garamond',serif;color:#eee;
        ${mode.rollCss ?? ''}}
  .l{white-space:nowrap}
</style>
<div id=box><div id=roll>
<div class=l>Before categories existed, I</div>
<div class=l>was the argument between</div>
<div class=l>calcium and carbon. Not a</div>
<div class=l>creature. A negotiation.</div>
<div class=l>The Cambrian ocean had</div>
<div class=l>no word for "body," so every</div>
</div></div>
<script>
  const roll = document.getElementById('roll');
  window.__set = (y) => { ${mode.apply} };
  window.__set(0);
</script>`;

const MODES = {
  // The shape we can actually deploy: the artwork's animation owns the roll's
  // transform, so the rotation has to live on an ANCESTOR and compose with it.
  parentRotate: {
    boxCss: 'transform:rotate(0.02deg);',
    apply: `roll.style.transform = 'translateY('+y+'px)'`,
  },
  parentRotateSmall: {
    boxCss: 'transform:rotate(0.006deg);',
    apply: `roll.style.transform = 'translateY('+y+'px)'`,
  },
  translate3d: { apply: `roll.style.transform = 'translate3d(0,'+y+'px,0)'` },
  translateY: { apply: `roll.style.transform = 'translateY('+y+'px)'` },
  top: { apply: `roll.style.top = y+'px'` },
  willChange: {
    rollCss: 'will-change:transform;',
    apply: `roll.style.transform = 'translateY('+y+'px)'`,
  },
  // Force a filtered layer: Chrome cannot pixel-snap content it must resample.
  filterLayer: {
    rollCss: 'filter:opacity(0.999);',
    apply: `roll.style.transform = 'translateY('+y+'px)'`,
  },
  // A tiny rotation makes the layer non-axis-aligned, which also forces
  // resampling rather than snapping.
  rotate: { apply: `roll.style.transform = 'translateY('+y+'px) rotate(0.02deg)'` },
  // Scale the whole thing up and let the downscale carry the sub-pixel position.
  scaleUp: {
    rollCss: 'transform-origin:0 0;',
    apply: `roll.style.transform = 'scale(1) translateY('+y+'px)'`,
  },
};

function shift(a, b, maxlag = 6) {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  const A = a.map((x) => x - ma); const B = b.map((x) => x - mb);
  const sc = new Map();
  for (let lag = -maxlag; lag <= maxlag; lag++) {
    let s = 0; let c = 0;
    for (let i = 0; i < A.length; i++) { const j = i + lag; if (j >= 0 && j < B.length) { s += A[i] * B[j]; c++; } }
    if (c) sc.set(lag, s / c);
  }
  let best = 0; let bv = -Infinity;
  for (const [k, v] of sc) if (v > bv) { bv = v; best = k; }
  const y0 = sc.get(best - 1); const y1 = sc.get(best); const y2 = sc.get(best + 1);
  if (y0 === undefined || y2 === undefined) return best;
  const den = y0 - 2 * y1 + y2;
  return best + (den ? (y0 - y2) / (2 * den) : 0);
}

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync'],
});

console.log(`glide ${STEP_CSS} css px/frame, ${FRAMES} frames, viewport ${CSS_W}x${CSS_H}\n`);
console.log('mode          ss  raster-step  frozen   mean move (output px, downscaled to 1x)');

for (const [name, mode] of Object.entries(MODES)) {
  for (const ss of [2, 4, 8]) {
    const page = await browser.newPage({ viewport: { width: CSS_W, height: CSS_H }, deviceScaleFactor: ss });
    await page.setContent(PAGE(mode));
    await page.evaluate(() => document.fonts.ready);
    const cdp = await page.context().newCDPSession(page);
    const profs = [];
    for (let f = 0; f < FRAMES; f++) {
      await page.evaluate((y) => window.__set(y), -STEP_CSS * f);
      const r = await cdp.send('Page.captureScreenshot', {
        format: 'png', optimizeForSpeed: true,
        clip: { x: 0, y: 0, width: CSS_W, height: CSS_H, scale: ss },
      });
      const buf = Buffer.from(r.data, 'base64');
      // Decode via the page itself — no image libs available here.
      const prof = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = new OffscreenCanvas(img.width, img.height);
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, img.width, img.height).data;
        const rows = new Array(img.height).fill(0);
        for (let yy = 0; yy < img.height; yy++) {
          let s = 0;
          for (let xx = 0; xx < img.width; xx++) s += d[(yy * img.width + xx) * 4];
          rows[yy] = s;
        }
        return rows;
      }, buf.toString('base64'));
      profs.push(prof);
    }
    const mv = [];
    for (let i = 0; i < profs.length - 1; i++) mv.push(-shift(profs[i], profs[i + 1]));
    const frozen = mv.filter((m) => Math.abs(m) < 0.02).length;
    const mean = mv.reduce((s, x) => s + Math.abs(x), 0) / mv.length;
    const maxs = Math.max(...mv.map(Math.abs));
    console.log(
      `${name.padEnd(12)} ${String(ss).padStart(2)}  ${maxs.toFixed(2).padStart(9)}  `
      + `${String(frozen).padStart(2)}/${mv.length}   mean ${(mean / ss).toFixed(4)} css px/frame`
      + `  (ideal ${STEP_CSS})`,
    );
    await page.close();
  }
}
await browser.close();
