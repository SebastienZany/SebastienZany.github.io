#!/usr/bin/env node
// The honest text-motion metric.
//
// Every earlier "the text is fixed / still broken" claim failed the same way:
// it counted frozen frames without asking whether the text was SUPPOSED to move
// on those frames. A callout that is holding between scroll phases measures
// 100% frozen and that is correct behaviour. This report joins two sources:
//
//   INTENDED  — the page's own resolved state per frame, from the .trace.jsonl
//               that render-page.mjs writes: roll translateY (ty) plus the text
//               viewport's client rect (the box moves with the camera).
//   MEASURED  — pixel displacement in the ENCODED FILM: a fixed gray crop of
//               the viewport interior per segment, high-passed row profiles,
//               cross-correlated between consecutive frames with parabolic
//               sub-pixel interpolation (same estimator snap-probe.mjs proved).
//
// A frame is FROZEN only if intended motion ≥ MOVE_T device px and measured
// < HOLD_T. The verdict is the frozen share among should-move frames, plus the
// jump histogram (a staircase shows as ~1 px jumps between frozen runs even
// when the mean rate looks right).
//
//   node replay/text-motion-report.mjs replay/out/film.mp4 [ss] [fps]
//
// Requires film.trace.jsonl next to the mp4 (TRACE_FROM=0 TRACE_LEN=99999).

import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const mp4 = process.argv[2] ?? 'replay/out/page-render.mp4';
const SS = Number(process.argv[3] ?? 2);
const FPS = Number(process.argv[4] ?? 60);
const tracePath = mp4.replace(/\.mp4$/, '.trace.jsonl');
if (!existsSync(tracePath)) {
  console.error(`no trace at ${tracePath} — render with TRACE_FROM=0 TRACE_LEN=99999`);
  process.exit(2);
}
const rows = readFileSync(tracePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// Thresholds in DEVICE pixels. The artwork glides at ~0.11 css px/frame, i.e.
// ~0.22 device px at ss=2; the estimator resolves ~0.03 px on high-passed text.
const MOVE_T = 0.12;   // intended motion at/above this must be visible
const HOLD_T = 0.055;  // measured below this counts as "did not move"

// ---- segments: contiguous frames with a fully-revealed callout ----
const segs = [];
let cur = null;
for (const r of rows) {
  const okRow = r.rect && r.op != null && r.op >= 0.98 && Number.isFinite(r.ty);
  if (okRow) {
    if (!cur) cur = { rows: [] };
    cur.rows.push(r);
  } else if (cur) { segs.push(cur); cur = null; }
}
if (cur) segs.push(cur);
const usable = segs.filter((s) => s.rows.length >= 30);
if (!usable.length) {
  console.error('no usable callout segments (need ≥30 consecutive fully-visible frames)');
  process.exit(2);
}

// Per segment: intersection of all interiors, in device px. Horizontal inset
// dodges the box stroke; the vertical inset is much deeper — the text viewport
// carries static feather masks top and bottom, and glyphs sliding UNDER a
// stationary mask edge read as "frozen" to a row-profile even while they move
// (verified by eye on the f2139-2157 run: single entry line under the mask,
// ty gliding 0.112px/frame). Only the center band measures glyph motion.
for (const s of usable) {
  const INSET_X = 8 * SS;
  let x0 = -Infinity; let y0 = -Infinity; let x1 = Infinity; let y1 = Infinity;
  for (const r of s.rows) {
    const maskY = r.rect[3] * 0.22 * SS;   // feather zone, each end
    x0 = Math.max(x0, (r.rect[0]) * SS + INSET_X);
    y0 = Math.max(y0, (r.rect[1]) * SS + maskY);
    x1 = Math.min(x1, (r.rect[0] + r.rect[2]) * SS - INSET_X);
    y1 = Math.min(y1, (r.rect[1] + r.rect[3]) * SS - maskY);
  }
  s.crop = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
  s.f0 = s.rows[0].f;
  s.f1 = s.rows.at(-1).f;
}
const good = usable.filter((s) => s.crop.w > 40 && s.crop.h > 40);
console.log(`${good.length} segment(s):`, good.map((s) => `f${s.f0}-${s.f1} (${(s.f0 / FPS).toFixed(1)}-${(s.f1 / FPS).toFixed(1)}s) crop ${s.crop.w}x${s.crop.h}`).join('  '));

// ---- one decode pass: full gray frames streamed out of ffmpeg ----
const probeText = await new Promise((res, rej) => {
  const p = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', mp4]);
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  p.on('close', (c) => (c === 0 ? res(out) : rej(new Error('ffprobe failed'))));
});
const vs = JSON.parse(probeText).streams.find((s) => s.codec_type === 'video');
const W = vs.width; const H = vs.height;

const ff = spawn('ffmpeg', ['-v', 'quiet', '-i', mp4, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
const frameBytes = W * H;
let pending = Buffer.alloc(0);
let frameIdx = 0;

// profiles[segIndex] = Map(frame -> Float64Array rows)
const profiles = good.map(() => new Map());

function highpass(a, r = 8) {
  const out = new Float64Array(a.length);
  let acc = 0;
  const win = 2 * r + 1;
  for (let i = 0; i < a.length; i++) {
    acc += a[i];
    if (i >= win) acc -= a[i - win];
    const c = i - r;
    if (c >= 0) out[c] = a[c] - acc / Math.min(win, i + 1);
  }
  return out;
}

function rowProfile(buf, crop) {
  const rowsOut = new Float64Array(crop.h);
  for (let j = 0; j < crop.h; j++) {
    let sum = 0;
    const base = (crop.y + j) * W + crop.x;
    for (let i = 0; i < crop.w; i++) sum += buf[base + i];
    rowsOut[j] = sum;
  }
  return highpass(rowsOut);
}

await new Promise((res, rej) => {
  ff.stdout.on('data', (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes);
      for (let gi = 0; gi < good.length; gi++) {
        const s = good[gi];
        if (frameIdx >= s.f0 && frameIdx <= s.f1) profiles[gi].set(frameIdx, rowProfile(frame, s.crop));
      }
      pending = pending.subarray(frameBytes);
      frameIdx++;
    }
  });
  ff.on('close', (c) => (c === 0 || frameIdx > 0 ? res() : rej(new Error(`ffmpeg exited ${c}`))));
});
console.log(`decoded ${frameIdx} frames of ${W}x${H}`);

function shift(a, b, maxlag = 10) {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  const A = Array.from(a, (x) => x - ma); const B = Array.from(b, (x) => x - mb);
  const sc = new Map();
  for (let lag = -maxlag; lag <= maxlag; lag++) {
    let s = 0; let n = 0;
    for (let i = 0; i < A.length; i++) { const j = i + lag; if (j >= 0 && j < B.length) { s += A[i] * B[j]; n++; } }
    if (n) sc.set(lag, s / n);
  }
  let best = 0; let bv = -Infinity;
  for (const [k, v] of sc) if (v > bv) { bv = v; best = k; }
  const y0 = sc.get(best - 1); const y1 = sc.get(best); const y2 = sc.get(best + 1);
  if (y0 === undefined || y2 === undefined) return best;
  const den = y0 - 2 * y1 + y2;
  return best + (den ? (y0 - y2) / (2 * den) : 0);
}

// ---- join intended vs measured ----
const all = { shouldMove: 0, frozen: 0, held: 0, phantom: 0, jumps: 0, pairs: 0, unmeasurable: 0, frozenRuns: [] };
const rms = (p) => Math.sqrt(p.reduce((s2, x) => s2 + x * x, 0) / p.length);
for (let gi = 0; gi < good.length; gi++) {
  const s = good[gi];
  const st = { shouldMove: 0, frozen: 0, held: 0, phantom: 0, jumps: 0, pairs: 0, unmeasurable: 0 };
  const byF = new Map(s.rows.map((r) => [r.f, r]));
  // Glyph rows ripple the high-passed profile hard; empty backdrop barely
  // does. Calibrate "there is text to measure" per segment: an eighth of the
  // segment's own median energy.
  const energies = [];
  for (let f = s.f0; f <= s.f1; f++) { const p = profiles[gi].get(f); if (p) energies.push(rms(p)); }
  energies.sort((a2, b2) => a2 - b2);
  const minEnergy = (energies[Math.floor(energies.length / 2)] ?? 0) / 8;
  let frozenRun = 0;
  for (let f = s.f0; f < s.f1; f++) {
    const a = profiles[gi].get(f); const b = profiles[gi].get(f + 1);
    const ra = byF.get(f); const rb = byF.get(f + 1);
    if (!a || !b || !ra || !rb) continue;
    if (rms(a) < minEnergy || rms(b) < minEnergy) { st.unmeasurable++; continue; }
    // Screen-space intended motion: box motion + scroll. Down is +y for rect,
    // ty is a translateY, both in css px.
    const intended = ((rb.rect[1] + rb.ty) - (ra.rect[1] + ra.ty)) * SS;
    const measured = shift(a, b);   // +ve = content moved down
    st.pairs++;
    const im = Math.abs(intended); const mm = Math.abs(measured);
    if (im >= MOVE_T) {
      st.shouldMove++;
      if (mm < HOLD_T) {
        st.frozen++; frozenRun++;
        if (process.env.DETAIL) console.log(`  frozen f=${f} (${(f / FPS).toFixed(2)}s) intended=${intended.toFixed(3)} measured=${measured.toFixed(3)}`);
      } else {
        if (frozenRun >= 2) all.frozenRuns.push(frozenRun);
        frozenRun = 0;
      }
      if (mm > 2.5 * im + 0.3) st.jumps++;   // staircase discharge
    } else if (im < 0.05) {
      st.held++;
      if (mm > 0.2) st.phantom++;
    }
  }
  if (frozenRun >= 2) all.frozenRuns.push(frozenRun);
  // The hold-frames are the segment's own CONTROL: when neither the box nor
  // the scroll moved, a clean crop must measure ~nothing. A high phantom rate
  // means the crop overlays something else that moves (the creature bleeding
  // through the translucent box), so its motion numbers describe the bleed,
  // not the text — in either direction. Such a segment cannot testify.
  const controlOk = st.held === 0 || st.phantom / st.held < 0.2;
  console.log(`segment f${s.f0}-${s.f1}: pairs=${st.pairs} shouldMove=${st.shouldMove} `
    + `FROZEN=${st.frozen} (${st.shouldMove ? (100 * st.frozen / st.shouldMove).toFixed(1) : '—'}%) `
    + `jumps=${st.jumps} held=${st.held} phantom=${st.phantom} unmeasurable=${st.unmeasurable}`
    + (controlOk ? '' : '   [CONTROL FAILED — crop contaminated, excluded from verdict]'));
  if (controlOk) {
    for (const k of ['shouldMove', 'frozen', 'held', 'phantom', 'jumps', 'pairs', 'unmeasurable']) all[k] += st[k];
  }
}

if (!all.shouldMove) {
  console.log('\n==== VERDICT ====\nno control-clean segments with intended motion — nothing to judge');
  process.exit(2);
}
const pct = (100 * all.frozen) / all.shouldMove;
const jumpPct = (100 * all.jumps) / all.shouldMove;
console.log('\n==== VERDICT (control-clean segments only) ====');
console.log(`should-move pairs: ${all.shouldMove}   frozen: ${all.frozen} (${pct.toFixed(1)}%)   `
  + `staircase jumps: ${all.jumps} (${jumpPct.toFixed(1)}%)   phantom moves while holding: ${all.phantom}/${all.held}   `
  + `unmeasurable (no glyphs in band): ${all.unmeasurable}`);
console.log(`frozen runs ≥2: ${all.frozenRuns.length}${all.frozenRuns.length ? ` (longest ${Math.max(...all.frozenRuns)})` : ''}`);
const pass = pct <= 5 && jumpPct <= 3;
console.log(pass
  ? 'PASS — the text moves when it is supposed to.'
  : 'FAIL — the film freezes text that the page moved.');
process.exit(pass ? 0 : 1);
