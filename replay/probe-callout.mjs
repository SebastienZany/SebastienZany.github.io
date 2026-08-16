#!/usr/bin/env node
// Does a Playwright screenshot actually capture the story callout?
//
// Both a live-mode capture and a mid-render capture came back without the
// callout while the DOM reported it visible at opacity 1 with a sane rect. That
// is either the screenshot missing a composited layer, or the element genuinely
// painting nothing. Distinguish them: shoot the page, shoot the element itself,
// and dump the styles that decide whether it paints.
import { writeFileSync } from 'node:fs';

const pwRoot = process.env.PLAYWRIGHT_PATH ?? 'playwright';
const { chromium } = await import(pwRoot);
const BASE = process.env.REPLAY_BASE ?? 'http://localhost:8140';

const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADED !== '1',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('  ! ', String(e).slice(0, 200)));

await page.goto(`${BASE}/?render&dev&auto=1&livecallout=1&grow=2600&seed=48879`, { waitUntil: 'commit' });

const t0 = Date.now();
for (;;) {
  if (Date.now() - t0 > 15 * 60 * 1000) throw new Error('timeout');
  const st = await page.evaluate(() => window.__replayStatus?.phase ?? 'loading').catch(() => 'loading');
  if (st === 'done' || st === 'error') break;
  await page.waitForTimeout(1000);
}

const info = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.observation-callout')]
    .find((n) => Number(getComputedStyle(n).opacity) > 0.3)
    ?? document.querySelector('.observation-callout');
  if (!el) return { found: false };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const before = getComputedStyle(el, '::before');
  const content = el.querySelector('.observation-content');
  const body = el.querySelector('.observation-text');
  return {
    found: true,
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    callout: {
      opacity: cs.opacity, visibility: cs.visibility, display: cs.display,
      transform: cs.transform, filter: cs.filter, zIndex: cs.zIndex,
      position: cs.position, clip: cs.clipPath, overflow: cs.overflow,
      willChange: cs.willChange, contentVisibility: cs.contentVisibility,
    },
    beforeLayer: { opacity: before.opacity, backdropFilter: before.backdropFilter || before.webkitBackdropFilter, mask: (before.maskImage || '').slice(0, 60) },
    contentOpacity: content ? getComputedStyle(content).opacity : null,
    textOpacity: body ? getComputedStyle(body).opacity : null,
    lines: [...(body?.querySelectorAll('.observation-line') ?? [])].slice(0, 3)
      .map((l) => ({ txt: l.textContent.slice(0, 24), op: getComputedStyle(l).opacity, mask: (getComputedStyle(l).maskImage || '').slice(0, 40) })),
    layerParent: (() => {
      const p = document.getElementById('annotationLayer');
      if (!p) return null;
      const pcs = getComputedStyle(p);
      return { opacity: pcs.opacity, display: pcs.display, visibility: pcs.visibility, transform: pcs.transform, zIndex: pcs.zIndex, position: pcs.position };
    })(),
  };
});
console.log(JSON.stringify(info, null, 2));

await page.screenshot({ path: 'replay/out/probe-page.png' });
const el = await page.$('.observation-callout');
if (el) {
  await el.screenshot({ path: 'replay/out/probe-element.png' }).catch((e) => console.log('element shot failed:', String(e).slice(0, 160)));
}
// Also ask the page itself to paint the layer, bypassing the screenshot path.
const hasText = await page.evaluate(() => {
  const el2 = document.querySelector('.observation-line');
  return el2 ? el2.getBoundingClientRect().width > 0 : null;
});
console.log('line has layout width:', hasText);

writeFileSync('replay/out/probe.json', JSON.stringify(info, null, 2));
await browser.close();
