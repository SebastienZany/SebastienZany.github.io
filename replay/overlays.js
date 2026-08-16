// DOM overlay compositor for offline replay rendering.
//
// The exported video is captured straight off the WebGL canvas, so everything
// that lives in the DOM — the story callouts (index.html:235 #annotationLayer),
// the ending fade (index.html:236 #endingFadeOverlay) and the ending countdown
// (index.html:237 #endingCountdownLayer) — is missing from the file. For
// "A Bestiary of Vanishings" the story text IS the work, so this module puts it
// back.
//
// STRATEGY: read layout from the live DOM, paint it ourselves with Canvas2D.
//
// main.js already updates the overlay DOM every tick — updateOatAnnotations()
// (main.js:7822) runs inside renderSceneOnce() (main.js:18794), and because
// replay/clock.js shims performance.now(), it does so against VIRTUAL time. So
// the browser is already doing the text wrapping, line boxes, font metrics and
// callout placement for us, at the right instant. We only take over *painting*:
// read each element's rect and computed style, then reproduce the backdrop blur,
// the tint, the crossed feather masks, the border, the tail, and the text with
// its reveal mask.
//
// Explicitly NOT html2canvas: it cannot do backdrop-filter or mask-composite
// (which is most of what this design is), and costs 50-200ms per frame on top of
// the ~130-160ms a sim tick already costs.
//
// The one thing that is NOT already correct in the DOM is the text animation.
// buildObservationTextAnimation (main.js:6812-6925) drives both the per-line
// reveal (a mask-position animation, main.js:6851) and the vertical scroll
// (roll.animate, main.js:6920) through the Web Animations API on
// document.timeline — i.e. WALL CLOCK, which offline has nothing to do with
// virtual time. So this module pauses those animations and recomputes their
// state arithmetically from virtualMs, using the same constants main.js uses.
//
// USAGE:
//
//   const overlays = await createOverlayCompositor({ api, width: W, height: H });
//   const enc = await createMp4Encoder({ canvas: overlays.canvas, fps, bpp });
//   ...
//   for (let t = 0; t < tpf; t++) step(dtMs);
//   overlays.composite(glCanvas, clock.virtualMs);   // SAME JS TASK as the draw
//   await enc.addFrame(i);
//
// The composite() call must happen in the same task as the tick that drew the
// frame, for exactly the reason encode.js documents: the WebGL drawing buffer is
// cleared once it is presented to the compositor, which cannot happen mid-task.
// composite() is deliberately synchronous so that constraint is easy to keep.
//
// KNOWN GAP: the start screen (#startScreen, z-index 10) and the intro copy are
// not composited. During a render they are `.is-complete` (visibility: hidden),
// so nothing is lost — but a capture that includes the intro would need them.

// ---------------------------------------------------------------------------
// Constants mirrored from main.js.
//
// Kept as literals rather than read from the DOM because they are timing values,
// not style values — they never appear in CSS. Line numbers are main.js at the
// commit this was written against; the values are also cross-checked against the
// live KeyframeEffect timings when those are available (see revealTiming()).
// ---------------------------------------------------------------------------

const OBS = {
  BOX_WIDTH_PX: 230,                 // main.js:5724 OBSERVATION_BOX_WIDTH_PX
  BOX_HEIGHT_PX: 126,                // main.js:5725 OBSERVATION_BOX_HEIGHT_PX
  VIEW_MARGIN_PX: 14,                // main.js:5723
  STROKE_WIDTH_PX: 1.5,              // main.js:5727 (matches styles.css:281)
  CHAR_STEP_MS: 190,                 // main.js:5734
  CHAR_FADE_MS: 1560,                // main.js:5735
  TEXT_REVEAL_MASK_SCALE: 2.6,       // main.js:5736
  TEXT_REVEAL_SOLID_STOP: 0.48,      // main.js:5737
  NEXT_LINE_START_FRACTION: 2 / 3,   // main.js:5749
  EXIT_LINE_COUNT: 5,                // main.js:5750
  BOX_FADE_IN_MS: 2600,              // main.js:5751
  BOX_FADE_OUT_MS: 2600,             // main.js:5753
};
// main.js:5752 — the text starts exactly when the glass has finished fading in.
OBS.TEXT_START_DELAY_MS = OBS.BOX_FADE_IN_MS;

// main.js:5740-5744. The mask image is 260% of the line box wide and slides from
// mask-position 100% to the first position at which the whole line sits under
// the opaque part of the gradient. Works out to 15.5%.
const TEXT_REVEAL_END_PERCENT =
  (((OBS.TEXT_REVEAL_MASK_SCALE * OBS.TEXT_REVEAL_SOLID_STOP) - 1) /
   (OBS.TEXT_REVEAL_MASK_SCALE - 1)) * 100;
const TEXT_REVEAL_ACTIVE_FRACTION = (100 - TEXT_REVEAL_END_PERCENT) / 100;
const TEXT_REVEAL_START_PERCENT = 100;

// main.js:5745 OBSERVATION_TEXT_REVEAL_MASK_IMAGE, decomposed into
// [position-along-the-mask-image, alpha]. The gradient is black at varying
// alpha throughout, so premultiplied interpolation — what both CSS gradients and
// Canvas2D gradients do — is exact.
const TEXT_REVEAL_MASK_STOPS = [
  [0.00, 1.00],
  [0.48, 1.00],
  [0.51, 0.72],
  [0.54, 0.28],
  [0.58, 0.00],
  [1.00, 0.00],
];

// styles.css:307 — backdrop-filter: blur(var(--observation-blur-radius)) saturate(1.12).
// Only the blur radius is a custom property; the saturation is baked into the
// stylesheet, so it is baked in here too (and re-read from the pseudo-element's
// computed style when the browser will give it to us).
const BACKDROP_SATURATE = 1.12;

// How far past the glass box the backdrop is sampled before blurring. CSS blurs
// the whole backdrop and then clips; sampling only the visible box would let the
// blur pull in transparent black at the edges and leave a dark rim.
const BLUR_SUPPORT_MULTIPLIER = 3;

// main.js:6841 is `line.textContent = lineText || '\u00a0'` — a NON-BREAKING
// space. An empty wrapped line is materialised as one, but its animation was
// sized from the original (empty) string, so the substitution must be undone
// when timings are re-derived from the DOM.
//
// Comparing against a plain space never matches, which would give a blank line
// 190ms + 1560ms of mask travel instead of 1560ms — an error that compounds
// through nextLineStartMs and desyncs every following line. main.js:6797 pushes
// a blank line between paragraphs, so any multi-paragraph story hits it.
const isBlankLine = (t) => !t || t.replace(/[\s\u00a0]/g, '') === '';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const num = (v, fallback = 0) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Read a numeric CSS custom property off a computed style. Custom properties
 *  inherit, so a callout sees both the :root defaults (styles.css:13-26) and its
 *  own inline per-callout overrides written by updateOatAnnotations. */
const cssVar = (style, name, fallback) => {
  const raw = style.getPropertyValue(name);
  if (raw == null || raw === '') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
};

const cssVarRaw = (style, name, fallback) => {
  const raw = style.getPropertyValue(name);
  return raw == null || raw.trim() === '' ? fallback : raw.trim();
};

const IDENTITY_MATRIX = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function parseMatrix(value) {
  if (!value || value === 'none') return IDENTITY_MATRIX;
  let m = /^matrix\(([^)]+)\)$/.exec(value);
  if (m) {
    const v = m[1].split(',').map(Number);
    if (v.length === 6 && v.every(Number.isFinite)) {
      return { a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5] };
    }
    return IDENTITY_MATRIX;
  }
  m = /^matrix3d\(([^)]+)\)$/.exec(value);
  if (m) {
    const v = m[1].split(',').map(Number);
    if (v.length === 16 && v.every(Number.isFinite)) {
      return { a: v[0], b: v[1], c: v[4], d: v[5], e: v[12], f: v[13] };
    }
  }
  return IDENTITY_MATRIX;
}

/** Pull the Y translation out of a keyframe transform string. */
function parseTranslateY(value) {
  if (!value || value === 'none') return 0;
  let m = /translate3d\(\s*[^,]+,\s*(-?[\d.eE+-]+)px/.exec(value);
  if (m) return Number.parseFloat(m[1]);
  m = /translateY\(\s*(-?[\d.eE+-]+)px/.exec(value);
  if (m) return Number.parseFloat(m[1]);
  m = /translate\(\s*[^,]+,\s*(-?[\d.eE+-]+)px/.exec(value);
  if (m) return Number.parseFloat(m[1]);
  if (value.startsWith('matrix')) return parseMatrix(value).f;
  return null;
}

/** Grapheme count, matching splitObservationGraphemes (main.js:6732). */
const graphemeSegmenter =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function graphemeCount(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  if (graphemeSegmenter) {
    let n = 0;
    // eslint-disable-next-line no-unused-vars
    for (const _segment of graphemeSegmenter.segment(s)) n++;
    return n;
  }
  return Array.from(s).length;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) * 0.5));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function resetCtx(ctx) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.shadowColor = 'rgba(0, 0, 0, 0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

/** A reusable scratch canvas that only ever grows. */
function makeScratch(label) {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  canvas.dataset.replayScratch = label;
  const ctx = canvas.getContext('2d');
  return {
    canvas,
    ctx,
    /** Grow if needed, reset state, clear the w*h region we are about to use. */
    acquire(w, h) {
      const iw = Math.max(1, Math.ceil(w));
      const ih = Math.max(1, Math.ceil(h));
      if (canvas.width < iw || canvas.height < ih) {
        // Resizing a canvas clears it, which is fine — acquire() clears anyway.
        canvas.width = Math.max(canvas.width, iw);
        canvas.height = Math.max(canvas.height, ih);
      }
      resetCtx(ctx);
      ctx.clearRect(0, 0, iw, ih);
      return ctx;
    },
    shrink() {
      canvas.width = 1;
      canvas.height = 1;
    },
  };
}

/**
 * drawImage with edge clamping.
 *
 * The source rect routinely hangs off the edge of `src`: a callout clamped to
 * the 14px view margin (main.js:7868-7877) puts its 42px glass outset plus ~21px
 * of blur support well outside the frame. Sampling that region normally yields
 * transparent black, which the blur then smears inward as a dark rim. CSS has no
 * such rim — the backdrop is the whole painted page and Chrome edge-duplicates
 * at the backdrop root — so replicate the outermost row/column into the margins,
 * which is the same approximation.
 *
 * `sx`/`sy` must be integers for a 1:1 copy; callers align them.
 */
function drawClampedRegion(dstCtx, src, sx, sy, sw, sh) {
  const srcW = src.width;
  const srcH = src.height;
  const x0 = Math.max(0, Math.min(srcW, Math.round(sx)));
  const x1 = Math.max(0, Math.min(srcW, Math.round(sx + sw)));
  const y0 = Math.max(0, Math.min(srcH, Math.round(sy)));
  const y1 = Math.max(0, Math.min(srcH, Math.round(sy + sh)));

  if (x1 <= x0 || y1 <= y0) {
    // Entirely off-canvas. Black is the renderer's clear colour
    // (main.js:18797-18798), so it is the honest stand-in.
    dstCtx.fillStyle = '#000';
    dstCtx.fillRect(0, 0, sw, sh);
    return;
  }

  const dx = x0 - sx;
  const dy = y0 - sy;
  const cw = x1 - x0;
  const ch = y1 - y0;

  dstCtx.drawImage(src, x0, y0, cw, ch, dx, dy, cw, ch);

  const leftPad = dx;                    // > 0 when the region starts left of the canvas
  const topPad = dy;
  const rightPad = sw - (dx + cw);
  const bottomPad = sh - (dy + ch);

  if (leftPad > 0) dstCtx.drawImage(src, x0, y0, 1, ch, 0, dy, leftPad, ch);
  if (rightPad > 0) dstCtx.drawImage(src, x1 - 1, y0, 1, ch, dx + cw, dy, rightPad, ch);
  if (topPad > 0) dstCtx.drawImage(src, x0, y0, cw, 1, dx, 0, cw, topPad);
  if (bottomPad > 0) dstCtx.drawImage(src, x0, y1 - 1, cw, 1, dx, dy + ch, cw, bottomPad);
  if (leftPad > 0 && topPad > 0) dstCtx.drawImage(src, x0, y0, 1, 1, 0, 0, leftPad, topPad);
  if (rightPad > 0 && topPad > 0) {
    dstCtx.drawImage(src, x1 - 1, y0, 1, 1, dx + cw, 0, rightPad, topPad);
  }
  if (leftPad > 0 && bottomPad > 0) {
    dstCtx.drawImage(src, x0, y1 - 1, 1, 1, 0, dy + ch, leftPad, bottomPad);
  }
  if (rightPad > 0 && bottomPad > 0) {
    dstCtx.drawImage(src, x1 - 1, y1 - 1, 1, 1, dx + cw, dy + ch, rightPad, bottomPad);
  }
}

/** Piecewise-linear sample of [{o, y}] keyframe points at progress t. */
function sampleKeyframes(points, t) {
  if (!points.length) return 0;
  if (t <= points[0].o) return points[0].y;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (t <= b.o) {
      const span = b.o - a.o;
      if (span <= 1e-9) return b.y;
      return a.y + (b.y - a.y) * ((t - a.o) / span);
    }
  }
  return points[points.length - 1].y;
}

/** Parse a computed `text-shadow` (Chrome: "rgba(r, g, b, a) Xpx Ypx Bpx"). */
function parseTextShadow(value) {
  if (!value || value === 'none') return null;
  const trimmed = value.trim();
  const colorMatch = /^(rgba?\([^)]*\)|#[0-9a-f]{3,8})\s*/i.exec(trimmed);
  if (!colorMatch) return null;
  const lengths = trimmed.slice(colorMatch[0].length).match(/-?[\d.]+px/g);
  if (!lengths || lengths.length < 2) return null;
  return {
    color: colorMatch[1],
    offsetX: Number.parseFloat(lengths[0]),
    offsetY: Number.parseFloat(lengths[1]),
    blur: lengths.length > 2 ? Number.parseFloat(lengths[2]) : 0,
  };
}

/** Is a computed colour string fully transparent (or missing)? */
function isInvisibleColor(color) {
  if (!color) return true;
  if (color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return true;
  const m = /rgba\([^)]*?,\s*([\d.]+)\s*\)$/.exec(color);
  return m ? Number.parseFloat(m[1]) <= 0.004 : false;
}

// ---------------------------------------------------------------------------
// Compositor
// ---------------------------------------------------------------------------

/**
 * @param {object}    opts
 * @param {Function}  opts.api          () => window.__cuttle
 * @param {number}    opts.width        output pixel width
 * @param {number}    opts.height       output pixel height
 * @param {number}   [opts.scale]       override for outputHeight / canvas.clientHeight
 * @param {number}   [opts.textBaselineNudgePx=0] CSS-px baseline correction for the
 *                     story text, if canvas font metrics land a hair off the DOM's
 * @param {boolean}  [opts.pinEndingLayers=true] pin the ending layers to the canvas box
 * @param {boolean}  [opts.pinCalloutWidth=true] force the 230px callout width
 * @param {boolean}  [opts.enabled=true] false -> pass the GL frame through untouched
 *
 * NOTE this factory is async, purely so it can await document.fonts.ready before
 * the first paint. `await` it.
 */
export async function createOverlayCompositor({
  api,
  width,
  height,
  scale: scaleOverride = null,
  textBaselineNudgePx = 0,
  pinEndingLayers = true,
  pinCalloutWidth = true,
  enabled = true,
} = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`createOverlayCompositor: bad output size ${width}x${height}`);
  }

  const doc = document;
  const layer = doc.getElementById('annotationLayer');
  const fadeOverlay = doc.getElementById('endingFadeOverlay');
  const countdownLayer = doc.getElementById('endingCountdownLayer');

  // --- output surface -------------------------------------------------------
  // A plain HTMLCanvasElement, not an OffscreenCanvas: this is what gets handed
  // to Mediabunny's CanvasSource, and `new VideoFrame(canvas)` is happiest with
  // an element. alpha:false because the frame is opaque and the encoder wants
  // opaque anyway.
  const out = doc.createElement('canvas');
  out.width = width;
  out.height = height;
  const outCtx = out.getContext('2d', { alpha: false });
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = 'high';

  // --- scratch surfaces -----------------------------------------------------
  const backdropScratch = makeScratch('backdrop'); // raw copy of what is behind a callout
  const glassScratch = makeScratch('glass');       // blurred + tinted + masked glass layer
  const textBoxScratch = makeScratch('textbox');   // the .observation-callout p box
  const lineScratch = makeScratch('line');         // one .observation-line
  const scratches = [backdropScratch, glassScratch, textBoxScratch, lineScratch];
  const measureCtx = doc.createElement('canvas').getContext('2d');
  const metricsCache = new Map();

  function glCanvasEl() {
    let el = null;
    try { el = api?.()?.renderer?.domElement ?? null; } catch { el = null; }
    return el ?? doc.getElementById('sim');
  }
  function canvasCssSize() {
    const rect = glCanvasEl()?.getBoundingClientRect();
    return { w: Math.max(1, rect?.width || width), h: Math.max(1, rect?.height || height) };
  }

  // --- DOM pinning ----------------------------------------------------------
  // replay/offline.js setRenderSize() pins #sim and #annotationLayer to the
  // output size, but NOT the ending layers. They are `position:absolute; inset:0`
  // inside #app, which is `position:fixed; inset:0` — i.e. the *browser window*.
  // Unpinned, the countdown would sit 10px from the bottom of the window rather
  // than 10px from the bottom of the frame. Pin them to the same box the canvas
  // uses so everything shares one coordinate system.
  //
  // Re-applied whenever the canvas box changes, so it does not matter whether
  // the compositor is created before or after offline.js's setRenderSize().
  const pinnedStyles = [];
  let lastPinnedW = -1;
  let lastPinnedH = -1;
  function registerPin(el) {
    if (!el) return;
    pinnedStyles.push({ el, width: el.style.width, height: el.style.height });
  }
  function applyPins() {
    if (!pinEndingLayers || !pinnedStyles.length) return;
    const { w, h } = canvasCssSize();
    if (w === lastPinnedW && h === lastPinnedH) return;
    lastPinnedW = w;
    lastPinnedH = h;
    for (const { el } of pinnedStyles) {
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
  }

  // `.observation-callout` is `width: min(230px, calc(100vw - 28px))`
  // (styles.css:278), but updateOatAnnotations places it using
  // OBSERVATION_BOX_WIDTH_PX clamped against canvas.clientWidth (main.js:7862).
  // Offline the canvas box is the *output* size while 100vw is still the real
  // window, so in a narrow window the painted box would be narrower than the box
  // main.js positioned — and the text would wrap differently too, because
  // wrapObservationText measures against body.clientWidth (main.js:6791).
  let injectedStyle = null;
  function maybePinCalloutWidth() {
    if (!pinCalloutWidth || injectedStyle) return;
    if (window.innerWidth - 28 >= OBS.BOX_WIDTH_PX) return; // CSS already yields 230px
    injectedStyle = doc.createElement('style');
    injectedStyle.dataset.replayOverlays = 'callout-width';
    injectedStyle.textContent =
      `.observation-callout { width: ${OBS.BOX_WIDTH_PX}px !important; }`;
    doc.head.append(injectedStyle);
  }

  maybePinCalloutWidth();
  if (pinEndingLayers) {
    registerPin(fadeOverlay);
    registerPin(countdownLayer);
    applyPins();
  }

  // --- fonts ----------------------------------------------------------------
  // Wait before the first paint, otherwise the opening frames are painted with
  // the fallback face while the DOM has already re-laid out with EB Garamond.
  //
  // CAVEAT: document.fonts.ready resolves when font loading *settles*, which
  // includes settling as a failure. index.html:10 pulls EB Garamond + Inter from
  // Google Fonts, so an offline or network-blocked render resolves here and then
  // paints with the Garamond/Times fallback — silently. The DOM and this canvas
  // agree either way (both resolve the same font stack), so the video is
  // self-consistent, just not what the piece looks like online. Check
  // `document.fonts.check('16px "EB Garamond"')` before a render if that matters.
  try {
    await doc.fonts?.ready;
  } catch {
    /* not fatal — worst case the first frames use the fallback face */
  }

  // --- layout frame ---------------------------------------------------------
  // Everything the DOM reports is CSS px in viewport coordinates. The output is
  // device px with its origin at the canvas's top-left. `scale` is
  // outputHeight / canvas.clientHeight, so a 4K render off a 1280-wide layout
  // re-renders the text at 3x instead of upscaling a 1280px raster.
  const frame = { originX: 0, originY: 0, scale: 1 };
  function refreshFrame() {
    // Style writes first, then every read for the frame, so the forced reflow
    // happens once (and only on the frame where the canvas box actually changed).
    applyPins();
    const rect = glCanvasEl()?.getBoundingClientRect();
    frame.originX = rect?.left ?? 0;
    frame.originY = rect?.top ?? 0;
    const cssHeight = Math.max(1, rect?.height || height);
    const s = scaleOverride ?? (height / cssHeight);
    frame.scale = Number.isFinite(s) && s > 0 ? s : 1;
  }
  const toX = (v) => (v - frame.originX) * frame.scale;
  const toY = (v) => (v - frame.originY) * frame.scale;
  const toS = (v) => v * frame.scale;

  // --- WAAPI ----------------------------------------------------------------
  // Every text animation runs on document.timeline, which offline advances with
  // wall time and is unrelated to virtual time. Pause them all; their state is
  // recomputed below. Nothing in main.js reads back from these animation objects
  // (the only other references are the cancel() calls at main.js:6804-6806), so
  // pausing cannot perturb the simulation.
  const pausedAnimations = new Set();
  function pauseAnimation(anim) {
    if (!anim || pausedAnimations.has(anim)) return;
    try {
      if (anim.playState !== 'paused') anim.pause();
      pausedAnimations.add(anim);
    } catch {
      /* an animation can be cancelled between collection and pause */
    }
  }
  function pauseOverlayAnimations(observations) {
    for (const observation of observations) {
      if (!observation) continue;
      pauseAnimation(observation.textScrollAnimation);
      for (const anim of observation.textRevealAnimations ?? []) pauseAnimation(anim);
    }
    // Safety net for animations not reachable through __cuttle.oats (e.g. a
    // callout whose oat was already removed). Scoped to the annotation layer so
    // the start-screen and UI animations are never touched.
    if (!layer || typeof doc.getAnimations !== 'function') return;
    for (const anim of doc.getAnimations()) {
      const target = anim.effect?.target;
      if (target && layer.contains(target)) pauseAnimation(anim);
    }
  }

  // --- font metrics ---------------------------------------------------------
  function fontMetrics(font) {
    let m = metricsCache.get(font);
    if (m) return m;
    measureCtx.font = font;
    const probe = measureCtx.measureText('Hxg');
    m = {
      ascent: probe.fontBoundingBoxAscent ?? probe.actualBoundingBoxAscent ?? 0,
      descent: probe.fontBoundingBoxDescent ?? probe.actualBoundingBoxDescent ?? 0,
    };
    metricsCache.set(font, m);
    return m;
  }

  /** Build a Canvas2D font shorthand from a computed style, at output scale. */
  function scaledFont(style) {
    const size = num(style.fontSize, 16) * frame.scale;
    const weight = style.fontWeight || '400';
    const italic = style.fontStyle && style.fontStyle !== 'normal' ? `${style.fontStyle} ` : '';
    return `${italic}${weight} ${size}px ${style.fontFamily}`;
  }

  /**
   * Baseline offset inside a line box, from the CSS strut: half-leading is
   * (lineBoxHeight - (ascent + descent)) / 2, and the baseline sits one ascent
   * below that.
   *
   * UNCERTAIN: Chrome's layout ascent/descent come from the font's OS/2 or hhea
   * metrics and Canvas2D's fontBoundingBox* are meant to be the same numbers,
   * but that is not guaranteed for every face. `textBaselineNudgePx` exists to
   * correct it by eye if a side-by-side capture shows a shift.
   */
  function baselineIn(lineBoxHeightPx, font) {
    const { ascent, descent } = fontMetrics(font);
    return (lineBoxHeightPx - (ascent + descent)) / 2 + ascent + toS(textBaselineNudgePx);
  }

  // --- callout collection ---------------------------------------------------
  /**
   * Pair each live .observation-callout element with its observation record, so
   * `textTimeline` and the animation objects are reachable. `__cuttle.oats`
   * (main.js:15642) is the way in; a callout not found there is still painted,
   * just with DOM-derived fallback timing.
   */
  function collectCallouts() {
    const byElement = new Map();
    let oats = null;
    try { oats = api?.()?.oats; } catch { oats = null; }
    if (Array.isArray(oats)) {
      for (const oat of oats) {
        const observation = oat?.observation;
        if (observation?.callout?.isConnected) byElement.set(observation.callout, observation);
      }
    }

    const entries = [];
    if (!layer) return entries;
    const els = layer.querySelectorAll('.observation-callout');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const style = getComputedStyle(el);
      entries.push({
        el,
        style,
        observation: byElement.get(el) ?? null,
        domIndex: i,
        z: num(style.zIndex, 0),
      });
    }
    // main.js:7886 writes a depth-derived z-index. Honour it: a nearer callout
    // must paint later, both so it lands on top and so its backdrop sample sees
    // the callouts behind it, exactly as the CSS backdrop root does.
    entries.sort((a, b) => (a.z === b.z ? a.domIndex - b.domIndex : a.z - b.z));
    return entries;
  }

  // --- text timing ----------------------------------------------------------
  /**
   * Per-line reveal timing as { delays[], durations[] } in ms from the moment
   * buildObservationTextAnimation ran (== observation.textTimeline.startTime,
   * main.js:6912).
   *
   * The preferred source is each animation's own KeyframeEffect timing, because
   * those ARE the numbers main.js computed (main.js:6860-6865) — no chance of
   * drifting from them. The fallback recomputes the same values from the DOM
   * text with main.js's constants (main.js:6836-6838, 6862, 6868).
   */
  function revealTiming(observation, lines) {
    const anims = observation?.textRevealAnimations;
    if (Array.isArray(anims) && anims.length === lines.length && anims.length > 0) {
      const delays = [];
      const durations = [];
      let ok = true;
      for (const anim of anims) {
        let timing = null;
        try { timing = anim?.effect?.getTiming?.(); } catch { timing = null; }
        const duration = Number(timing?.duration);
        if (!timing || !Number.isFinite(duration) || duration <= 0) { ok = false; break; }
        durations.push(duration);
        delays.push(Number(timing.delay) || 0);
      }
      if (ok) return { delays, durations };
    }

    const delays = [];
    const durations = [];
    let nextLineStartMs = 0;
    for (const line of lines) {
      const raw = isBlankLine(line.textContent) ? '' : (line.textContent ?? '');
      const maskTravelDurationMs = graphemeCount(raw) * OBS.CHAR_STEP_MS + OBS.CHAR_FADE_MS;
      const lineDurationMs = Math.max(240, maskTravelDurationMs * TEXT_REVEAL_ACTIVE_FRACTION);
      delays.push(OBS.TEXT_START_DELAY_MS + nextLineStartMs);
      durations.push(lineDurationMs);
      nextLineStartMs += lineDurationMs * OBS.NEXT_LINE_START_FRACTION;
    }
    return { delays, durations };
  }

  /**
   * The vertical scroll offset of .observation-text-roll at `elapsedMs`.
   *
   * The preferred source is the animation's own keyframes: they carry the exact
   * translate3d values main.js computed (main.js:6884-6909) together with their
   * computedOffsets, and the easing is 'linear' at both the effect and the
   * keyframe level (main.js:6922), so a plain piecewise lerp is exact. The
   * fallback rebuilds the same keyframe list from the live DOM.
   */
  function scrollTranslateY(observation, timing, elapsedMs, body, bodyStyle) {
    const fromTimeline = Number(observation?.textTimeline?.totalDurationMs);
    let total = Number.isFinite(fromTimeline) && fromTimeline > 0 ? fromTimeline : 0;
    let points = null;

    try {
      const anim = observation?.textScrollAnimation;
      const keyframes = anim?.effect?.getKeyframes?.();
      if (!total) {
        const t = anim?.effect?.getTiming?.();
        const d = Number(t?.duration);
        if (Number.isFinite(d) && d > 0) total = d;
      }
      if (Array.isArray(keyframes) && keyframes.length >= 2) {
        const parsed = keyframes
          .map((k) => ({
            o: clamp01(Number(k.computedOffset ?? k.offset ?? 0)),
            y: parseTranslateY(k.transform),
          }))
          .filter((p) => Number.isFinite(p.o) && p.y != null && Number.isFinite(p.y));
        if (parsed.length >= 2) points = parsed;
      }
    } catch {
      points = null;
    }

    if (!points) {
      // Fallback: rebuild main.js:6871-6910 from the live DOM.
      const lineHeight = num(bodyStyle.lineHeight, 16) || 16;
      const viewportHeight = Math.max(1, body.clientHeight);
      const textFadePx = Math.max(0, cssVar(bodyStyle, '--observation-text-fade', 0));
      const lineStarts = timing.delays.map((d) => d - OBS.TEXT_START_DELAY_MS);
      const lineDurations = timing.durations;

      let revealEndMs = 0;
      for (let i = 0; i < lineDurations.length; i++) {
        revealEndMs = Math.max(revealEndMs, lineStarts[i] + lineDurations[i]);
      }
      const revealDurationMs = Math.max(1, revealEndMs);
      const averageLineDurationMs =
        lineDurations.reduce((sum, d) => sum + d, 0) / Math.max(1, lineDurations.length);
      const exitDurationMs = Math.max(2400, averageLineDurationMs * OBS.EXIT_LINE_COUNT);
      const textEndMs = OBS.TEXT_START_DELAY_MS + revealDurationMs + exitDurationMs;
      const totalDurationMs = textEndMs + OBS.BOX_FADE_OUT_MS;
      const initialOffset = Math.max(0, viewportHeight - textFadePx);
      const finalOffset = -((lineDurations.length + 1) * lineHeight);

      points = [{ o: 0, y: initialOffset }];
      if (OBS.TEXT_START_DELAY_MS > 0) {
        points.push({ o: Math.min(1, OBS.TEXT_START_DELAY_MS / totalDurationMs), y: initialOffset });
      }
      lineStarts.forEach((lineStartMs, index) => {
        if (index === 0) return;
        points.push({
          o: Math.min(1, (OBS.TEXT_START_DELAY_MS + lineStartMs) / totalDurationMs),
          y: initialOffset - lineHeight * index,
        });
      });
      points.push({
        o: Math.min(1, (OBS.TEXT_START_DELAY_MS + revealDurationMs) / totalDurationMs),
        y: initialOffset - lineHeight * lineDurations.length,
      });
      points.push({ o: Math.min(1, textEndMs / totalDurationMs), y: finalOffset });
      points.push({ o: 1, y: finalOffset });
      if (!total) total = totalDurationMs;
    }

    if (!total) return null;
    return sampleKeyframes(points, clamp01(elapsedMs / total));
  }

  // --- painting: glass ------------------------------------------------------
  /**
   * styles.css:299-319, .observation-callout::before
   *
   *   inset: calc(-1 * outset)         relative to the callout's PADDING box,
   *                                    because that is the containing block of an
   *                                    absolutely positioned pseudo-element
   *   border-radius: corner + outset
   *   background: rgba(tintRgb, tintOpacity)
   *   backdrop-filter: blur(r) saturate(1.12)
   *   mask: two crossed linear-gradients, composited `intersect`
   *   opacity: featherOpacity * glassOpacity * spatialOpacity
   *
   * Reproduced as: sample the already-composited frame behind the box (with edge
   * clamping), blur + saturate it, paint the tint over it inside the rounded
   * rect, clip to that rounded rect, multiply by each feather gradient in turn
   * (two `destination-in` passes multiply alphas, which is what `intersect`
   * means), then blit at the layer opacity.
   */
  function paintGlass(el, style, calloutAlpha) {
    const featherOpacity = cssVar(style, '--observation-edge-feather-opacity', 1);
    const glassOpacity = cssVar(style, '--observation-glass-opacity', 0);
    const spatialOpacity = cssVar(style, '--observation-spatial-opacity', 0);
    const layerAlpha = featherOpacity * glassOpacity * spatialOpacity * calloutAlpha;
    if (layerAlpha <= 0.004) return;

    const rect = el.getBoundingClientRect();
    const borderLeft = num(style.borderLeftWidth, 0);
    const borderRight = num(style.borderRightWidth, 0);
    const borderTop = num(style.borderTopWidth, 0);
    const borderBottom = num(style.borderBottomWidth, 0);
    const outset = cssVar(style, '--observation-edge-feather-outset', 42);
    const corner = cssVar(style, '--observation-corner-radius', 24);
    const featherMask = cssVar(style, '--observation-edge-feather-mask', 62);
    const blurRadius = cssVar(style, '--observation-blur-radius', 7);
    const tintRgb = cssVarRaw(style, '--observation-tint-rgb', '0, 0, 0');
    const tintAlpha = cssVar(style, '--observation-tint-opacity', 0.33);

    // padding box (the pseudo's containing block) inflated by the outset
    const boxLeft = rect.left + borderLeft - outset;
    const boxTop = rect.top + borderTop - outset;
    const boxWidth = rect.width - borderLeft - borderRight + outset * 2;
    const boxHeight = rect.height - borderTop - borderBottom + outset * 2;
    if (boxWidth <= 0 || boxHeight <= 0) return;

    const dx = toX(boxLeft);
    const dy = toY(boxTop);
    const dw = toS(boxWidth);
    const dh = toS(boxHeight);
    const radius = toS(corner + outset);
    const blurPx = toS(blurRadius);
    const pad = Math.ceil(Math.max(1, blurPx * BLUR_SUPPORT_MULTIPLIER));

    // Align the scratch to whole output pixels so the backdrop makes exactly one
    // 1:1 copy out and one 1:1 copy back. The box's sub-pixel position is kept by
    // drawing the rounded rect at a fractional offset INSIDE the scratch.
    const originX = Math.floor(dx) - pad;
    const originY = Math.floor(dy) - pad;
    const boxX = dx - originX;   // in [pad, pad + 1)
    const boxY = dy - originY;
    const sw = Math.ceil(boxX + dw) + pad + 1;
    const sh = Math.ceil(boxY + dh) + pad + 1;

    // 1. the backdrop, edge-clamped
    const bdCtx = backdropScratch.acquire(sw, sh);
    drawClampedRegion(bdCtx, out, originX, originY, sw, sh);

    // 2. blur + saturate. Filter order matches the CSS declaration order.
    const gctx = glassScratch.acquire(sw, sh);
    let filter = `blur(${blurPx}px) saturate(${BACKDROP_SATURATE})`;
    try {
      // If the browser hands us the pseudo-element's resolved backdrop-filter,
      // a stylesheet edit to the saturation is picked up for free. The blur
      // length still has to be rescaled by hand, so it is always rebuilt.
      const pseudo = getComputedStyle(el, '::before');
      const declared = pseudo?.backdropFilter || pseudo?.webkitBackdropFilter;
      const sat = declared && /saturate\(\s*([\d.]+)\s*\)/.exec(declared);
      if (sat) filter = `blur(${blurPx}px) saturate(${Number.parseFloat(sat[1])})`;
    } catch {
      /* pseudo-element computed styles are best-effort */
    }
    gctx.filter = filter;
    gctx.drawImage(backdropScratch.canvas, 0, 0, sw, sh, 0, 0, sw, sh);
    gctx.filter = 'none';

    // 3. the tint, clipped to the rounded rect by using it as the fill region
    if (tintAlpha > 0.001) {
      gctx.fillStyle = `rgba(${tintRgb}, ${tintAlpha})`;
      roundRectPath(gctx, boxX, boxY, dw, dh, radius);
      gctx.fill();
    }

    // 4. clip the blurred backdrop to the same rounded rect. `destination-in`
    //    applies to the whole surface, so everything outside the path is erased.
    gctx.globalCompositeOperation = 'destination-in';
    gctx.fillStyle = '#fff';
    roundRectPath(gctx, boxX, boxY, dw, dh, radius);
    gctx.fill();

    // 5. the two crossed feather gradients (styles.css:309-316). Each
    //    destination-in multiplies destination alpha by source alpha, so two
    //    passes == mask-composite: intersect. Filling only the box also enforces
    //    mask-clip: border-box, since anything outside the fill is erased.
    const fm = Math.min(toS(featherMask), Math.min(dw, dh) * 0.5);
    const gradX = gctx.createLinearGradient(boxX, 0, boxX + dw, 0);
    gradX.addColorStop(0, 'rgba(0, 0, 0, 0)');
    gradX.addColorStop(clamp01(fm / dw), 'rgba(0, 0, 0, 1)');
    gradX.addColorStop(clamp01(1 - fm / dw), 'rgba(0, 0, 0, 1)');
    gradX.addColorStop(1, 'rgba(0, 0, 0, 0)');
    gctx.fillStyle = gradX;
    gctx.fillRect(boxX, boxY, dw, dh);

    const gradY = gctx.createLinearGradient(0, boxY, 0, boxY + dh);
    gradY.addColorStop(0, 'rgba(0, 0, 0, 0)');
    gradY.addColorStop(clamp01(fm / dh), 'rgba(0, 0, 0, 1)');
    gradY.addColorStop(clamp01(1 - fm / dh), 'rgba(0, 0, 0, 1)');
    gradY.addColorStop(1, 'rgba(0, 0, 0, 0)');
    gctx.fillStyle = gradY;
    gctx.fillRect(boxX, boxY, dw, dh);

    // 6. blit at the layer opacity, 1:1 onto the aligned origin
    resetCtx(outCtx);
    outCtx.globalAlpha = clamp01(layerAlpha);
    outCtx.drawImage(glassScratch.canvas, 0, 0, sw, sh, originX, originY, sw, sh);
    resetCtx(outCtx);
  }

  // --- painting: border -----------------------------------------------------
  /**
   * styles.css:281 — 1.5px solid rgba(255, 255, 255, stroke*glass*spatial) with
   * radius --observation-corner-radius. The computed borderTopColor already has
   * the calc() resolved, so just read it. --observation-stroke-opacity defaults
   * to 0 (styles.css:13), so this is usually a no-op; the dev panel can turn it
   * on (main.js:567).
   */
  function paintBorder(el, style, calloutAlpha) {
    const cssWidth = num(style.borderTopWidth, 0);
    if (cssWidth <= 0) return;
    const color = style.borderTopColor;
    if (isInvisibleColor(color)) return;

    const rect = el.getBoundingClientRect();
    const lineWidth = toS(cssWidth);
    const corner = cssVar(style, '--observation-corner-radius', 24);
    // CSS paints the border inside the border box, so the stroke centreline sits
    // half a border-width in.
    const x = toX(rect.left) + lineWidth / 2;
    const y = toY(rect.top) + lineWidth / 2;
    const w = toS(rect.width) - lineWidth;
    const h = toS(rect.height) - lineWidth;
    if (w <= 0 || h <= 0) return;

    resetCtx(outCtx);
    outCtx.globalAlpha = clamp01(calloutAlpha);
    outCtx.lineWidth = lineWidth;
    outCtx.strokeStyle = color;
    roundRectPath(outCtx, x, y, w, h, Math.max(0, toS(corner) - lineWidth / 2));
    outCtx.stroke();
    resetCtx(outCtx);
  }

  // --- painting: tail -------------------------------------------------------
  /**
   * styles.css:321-330 plus updateObservationTail (main.js:7274-7299): a 1.5px
   * bar positioned at left/top inside the callout, `width` px long, rotated
   * about its own transform-origin of `0 50%`.
   *
   * Note main.js computes `left`/`top` relative to the callout's BORDER box
   * (main.js:7294-7295) while CSS resolves them against its padding box, so the
   * rendered tail sits one border-width (1.5px) off from the maths in main.js.
   * What is reproduced here is what the browser actually renders.
   */
  function paintTail(el, calloutStyle, calloutAlpha) {
    const tail = el.querySelector('.observation-tail');
    if (!tail) return;
    const style = getComputedStyle(tail);
    const alpha = num(style.opacity, 0) * calloutAlpha;
    if (alpha <= 0.004) return;

    const w = num(style.width, 0);
    const h = num(style.height, OBS.STROKE_WIDTH_PX);
    if (w <= 0.5 || h <= 0) return;
    const color = style.backgroundColor;
    if (isInvisibleColor(color)) return;

    // getBoundingClientRect() would give the ROTATED bounding box, so take the
    // untransformed origin from the parent rect plus the offsets, and apply the
    // rotation matrix here instead.
    const parentRect = el.getBoundingClientRect();
    const left = num(style.left, 0) + num(calloutStyle.borderLeftWidth, 0);
    const top = num(style.top, 0) + num(calloutStyle.borderTopWidth, 0);
    const m = parseMatrix(style.transform); // rotate() -> matrix(cos, sin, -sin, cos, 0, 0)

    const originX = toX(parentRect.left + left);
    const originY = toY(parentRect.top + top + h / 2);

    resetCtx(outCtx);
    outCtx.globalAlpha = clamp01(alpha);
    outCtx.translate(originX, originY);
    outCtx.transform(m.a, m.b, m.c, m.d, toS(m.e), toS(m.f));
    outCtx.fillStyle = color;
    outCtx.fillRect(0, -toS(h) / 2, toS(w), toS(h));
    resetCtx(outCtx);
  }

  // --- painting: text -------------------------------------------------------
  /**
   * The story text:
   *   .observation-content > p.observation-text-viewport
   *     > span.observation-text-roll > span.observation-line*
   *
   * Layout comes from the DOM. The only things recomputed are the animation
   * states: the roll's translateY from the scroll keyframes at virtual elapsed
   * time, and each line's mask-position from that line's delay/duration.
   *
   * The roll's DOM transform is frozen at whatever wall-clock instant the
   * animation was paused, so line rects are read as-is and then shifted by
   * (ourY - frozenY). That keeps sub-pixel layout precision, which reading
   * offsetTop (an integer) would throw away.
   */
  function paintText(el, observation, virtualMs, calloutAlpha) {
    const content = el.querySelector('.observation-content');
    const body = el.querySelector('.observation-text-viewport') ?? content?.querySelector('p');
    const roll = body?.querySelector('.observation-text-roll');
    if (!content || !body || !roll) return;

    // styles.css:337 — opacity: calc(text-opacity * spatial-opacity)
    const contentAlpha = num(getComputedStyle(content).opacity, 1) * calloutAlpha;
    if (contentAlpha <= 0.004) return;

    const lines = roll.querySelectorAll('.observation-line');
    if (!lines.length) return;

    const bodyStyle = getComputedStyle(body);
    const bodyRect = body.getBoundingClientRect();
    if (bodyRect.width <= 0 || bodyRect.height <= 0) return;

    const timing = revealTiming(observation, lines);

    // Elapsed virtual time since buildObservationTextAnimation ran. The
    // animations are created in the same frame that stamps
    // textTimeline.startTime (main.js:6851 vs main.js:6912), and offline
    // performance.now() is frozen within a tick, so the two share an origin
    // exactly.
    const startTime = Number(observation?.textTimeline?.startTime);
    const elapsedMs = Number.isFinite(startTime) ? virtualMs - startTime : null;

    let shiftY = 0;
    let ourYDbg = null;
    let domYDbg = null;
    if (elapsedMs != null) {
      const ourY = scrollTranslateY(observation, timing, elapsedMs, body, bodyStyle);
      domYDbg = parseMatrix(getComputedStyle(roll).transform).f;
      ourYDbg = ourY;
      if (ourY != null) shiftY = ourY - domYDbg;
    }
    // Motion trace: the reveal and the scroll are both recomputed from virtual
    // time every frame, so if either is uneven the series shows it directly.
    // Sampling one callout keeps this cheap enough to leave on.
    if (trace && trace.length < TRACE_MAX) {
      trace.push({
        // Key by callout. Without this the trace interleaves every visible box
        // and a switch between two of them reads as a timeline reset.
        id: observation?.stableId ?? observation?.id ?? oatIndexOf(observation),
        f: paintedFrames,
        vms: Math.round(virtualMs),
        el: elapsedMs == null ? null : Math.round(elapsedMs),
        ourY: ourYDbg == null ? null : +ourYDbg.toFixed(2),
        domY: domYDbg == null ? null : +domYDbg.toFixed(2),
        shiftY: +shiftY.toFixed(2),
      });
    }

    // Align the text box to whole output pixels: every copy from here on is 1:1,
    // and the sub-pixel position is carried by fillText itself. Without this the
    // text would be resampled twice and 4K output would look soft.
    const boxOriginX = Math.floor(toX(bodyRect.left));
    const boxOriginY = Math.floor(toY(bodyRect.top));
    const boxOffsetX = toX(bodyRect.left) - boxOriginX; // in [0, 1)
    const boxOffsetY = toY(bodyRect.top) - boxOriginY;
    const boxWidth = Math.ceil(boxOffsetX + toS(bodyRect.width)) + 1;
    const boxHeight = Math.ceil(boxOffsetY + toS(bodyRect.height)) + 1;

    const boxCtx = textBoxScratch.acquire(boxWidth, boxHeight);
    const font = scaledFont(bodyStyle);
    const color = bodyStyle.color;
    const letterSpacing = num(bodyStyle.letterSpacing, 0);
    let painted = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const text = line.textContent ?? '';
      const rect = line.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const lineTop = rect.top + shiftY;
      // Cheap cull: the p is overflow:hidden (styles.css:346), so a line fully
      // outside its box contributes nothing.
      if (lineTop + rect.height < bodyRect.top - 1 || lineTop > bodyRect.bottom + 1) continue;
      if (isBlankLine(text)) continue;

      // Per-line reveal progress. WAAPI `fill: 'forwards'` with a positive delay
      // does NOT back-fill, so before the delay the property falls back to the
      // inline base value (main.js:6848), which equals the first keyframe —
      // progress 0. Easing is 'linear' (main.js:6863), so this is a plain ratio.
      const delay = timing.delays[i] ?? OBS.TEXT_START_DELAY_MS;
      const duration = Math.max(1, timing.durations[i] ?? 240);
      const progress = elapsedMs == null ? 1 : clamp01((elapsedMs - delay) / duration);
      if (progress <= 0) continue; // the mask hides the whole line

      const lineW = toS(rect.width);
      const lineH = toS(rect.height);
      // Same integer-alignment trick, relative to the text box scratch.
      const destX = toX(rect.left) - boxOriginX;
      const destY = toY(lineTop) - boxOriginY;
      const lineOriginX = Math.floor(destX);
      const lineOriginY = Math.floor(destY);
      const offsetX = destX - lineOriginX;
      const offsetY = destY - lineOriginY;
      const scratchW = Math.ceil(offsetX + lineW) + 1;
      const scratchH = Math.ceil(offsetY + lineH) + 1;

      const lctx = lineScratch.acquire(scratchW, scratchH);
      lctx.font = font;
      if ('letterSpacing' in lctx && letterSpacing) {
        lctx.letterSpacing = `${toS(letterSpacing)}px`;
      }
      lctx.textBaseline = 'alphabetic';
      lctx.fillStyle = color;
      // .observation-line is overflow:hidden / white-space:nowrap (styles.css:
      // 374-380), so clip to its own box — a long word can overflow it.
      lctx.save();
      lctx.beginPath();
      lctx.rect(offsetX, offsetY, lineW, lineH);
      lctx.clip();
      lctx.fillText(text, offsetX, offsetY + baselineIn(lineH, font));
      lctx.restore();

      // The reveal mask: a 260%-wide gradient (main.js:5745-5746) whose
      // mask-position slides from 100% to TEXT_REVEAL_END_PERCENT. A CSS
      // position percentage p aligns the p-point of the image with the p-point
      // of the positioning area, i.e. offset = p * (boxWidth - maskWidth). The
      // positioning area is the line's border box (mask-origin defaults to
      // border-box and the line has neither border nor padding).
      const positionPercent =
        TEXT_REVEAL_START_PERCENT +
        (TEXT_REVEAL_END_PERCENT - TEXT_REVEAL_START_PERCENT) * progress;
      const maskWidth = OBS.TEXT_REVEAL_MASK_SCALE * lineW;
      const maskX = offsetX + (positionPercent / 100) * (lineW - maskWidth);
      const grad = lctx.createLinearGradient(maskX, 0, maskX + maskWidth, 0);
      for (const [stop, alpha] of TEXT_REVEAL_MASK_STOPS) {
        grad.addColorStop(stop, `rgba(0, 0, 0, ${alpha})`);
      }
      lctx.globalCompositeOperation = 'destination-in';
      lctx.fillStyle = grad;
      lctx.fillRect(offsetX, offsetY, lineW, lineH);
      lctx.globalCompositeOperation = 'source-over';

      boxCtx.drawImage(
        lineScratch.canvas,
        0, 0, scratchW, scratchH,
        lineOriginX, lineOriginY, scratchW, scratchH,
      );
      painted++;
    }

    if (!painted) return;

    // styles.css:352-365 — the vertical text fade on the p, over its border box
    // (mask-origin defaults to border-box; the p has no border, so that is also
    // its padding box, which is what overflow:hidden clips to).
    const fade = toS(Math.max(0, cssVar(bodyStyle, '--observation-text-fade', 28)));
    const maskH = toS(bodyRect.height);
    if (maskH > 0) {
      const f = fade > 0 ? clamp01(fade / maskH) : 0;
      const grad = boxCtx.createLinearGradient(0, boxOffsetY, 0, boxOffsetY + maskH);
      grad.addColorStop(0, fade > 0 ? 'rgba(0, 0, 0, 0)' : 'rgba(0, 0, 0, 1)');
      grad.addColorStop(Math.min(f, 0.5), 'rgba(0, 0, 0, 1)');
      grad.addColorStop(Math.max(1 - f, 0.5), 'rgba(0, 0, 0, 1)');
      grad.addColorStop(1, fade > 0 ? 'rgba(0, 0, 0, 0)' : 'rgba(0, 0, 0, 1)');
      boxCtx.globalCompositeOperation = 'destination-in';
      boxCtx.fillStyle = grad;
      // Filling only the p's box also reproduces its overflow clip.
      boxCtx.fillRect(boxOffsetX, boxOffsetY, toS(bodyRect.width), maskH);
      boxCtx.globalCompositeOperation = 'source-over';
    }

    resetCtx(outCtx);
    outCtx.globalAlpha = clamp01(contentAlpha);
    outCtx.drawImage(
      textBoxScratch.canvas,
      0, 0, boxWidth, boxHeight,
      boxOriginX, boxOriginY, boxWidth, boxHeight,
    );
    resetCtx(outCtx);
  }

  // --- painting: one callout ------------------------------------------------
  function paintCallout(entry, virtualMs) {
    const { el, style } = entry;
    if (style.display === 'none' || style.visibility === 'hidden') return;

    // hideOatObservation (main.js:7301-7314) writes opacity 0 and
    // --observation-spatial-opacity 0; updateOatAnnotations writes 1 and the
    // computed facing/occlusion visibility (main.js:7881-7884). Either at 0
    // means there is nothing to paint.
    const calloutAlpha = num(style.opacity, 1);
    // Alpha trace: one row per callout per frame, BEFORE any gate, so a
    // one-frame dropout shows exactly which input dropped (the flicker of
    // 2026-08-16 measured as single-frame frost losses; without this the
    // compositor's inputs were invisible after the fact).
    if (trace && trace.length < TRACE_MAX) {
      trace.push({
        id: entry.observation?.stableId ?? entry.observation?.id ?? null,
        f: paintedFrames,
        k: 'alpha',
        op: +calloutAlpha.toFixed(3),
        spatial: +cssVar(style, '--observation-spatial-opacity', 0).toFixed(3),
        glass: +cssVar(style, '--observation-glass-opacity', 0).toFixed(3),
        feather: +cssVar(style, '--observation-edge-feather-opacity', 1).toFixed(3),
      });
    }
    if (calloutAlpha <= 0.004) return;
    if (cssVar(style, '--observation-spatial-opacity', 0) <= 0.004) return;

    // NOTE: .observation-callout has `isolation: isolate` (styles.css:286), so
    // strictly its own opacity applies to the composited group rather than to
    // each layer separately. Painting the layers one at a time at that alpha
    // differs only where they overlap, and main.js only ever writes 0 or 1 here
    // (main.js:7307, 7881) — the actual fades are carried by the three custom
    // properties, which ARE applied per-layer exactly as the CSS does.
    paintGlass(el, style, calloutAlpha);
    paintTail(el, style, calloutAlpha);
    paintBorder(el, style, calloutAlpha);
    paintText(el, entry.observation, virtualMs, calloutAlpha);
  }

  // --- painting: ending fade + countdown ------------------------------------
  /** index.html:236 / styles.css:94-101 — a full-bleed black plane, z-index 8,
   *  driven by setEndingFadeOpacity (main.js:5926-5930). */
  function paintEndingFade() {
    if (!fadeOverlay) return;
    const style = getComputedStyle(fadeOverlay);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    const alpha = num(style.opacity, 0);
    if (alpha <= 0.002) return;

    resetCtx(outCtx);
    outCtx.globalAlpha = clamp01(alpha);
    // It is `inset: 0` over the whole app, so cover the whole frame rather than
    // trusting its rect (which is the window's unless pinEndingLayers pinned it).
    outCtx.fillStyle = isInvisibleColor(style.backgroundColor) ? '#000' : style.backgroundColor;
    outCtx.fillRect(0, 0, width, height);
    resetCtx(outCtx);
  }

  /**
   * index.html:237-240 / styles.css:103-130 — two corner timecodes, z-index 9,
   * so they sit ABOVE the ending fade. Text is written by syncEndingCountdownText
   * (main.js:5946-5951); layer visibility by setEndingCountdownVisible
   * (main.js:5932-5937).
   *
   * CAVEAT: `font-variant-numeric: tabular-nums` (styles.css:117) has no
   * Canvas2D equivalent, so digits use the face's default (proportional) figures
   * here. At 0.48rem in a corner at 24% opacity this is invisible in practice,
   * but it does mean the two timecodes can be a fraction of a pixel wider or
   * narrower than the DOM's.
   */
  function paintCountdown() {
    if (!countdownLayer) return;
    const layerStyle = getComputedStyle(countdownLayer);
    if (layerStyle.display === 'none' || layerStyle.visibility === 'hidden') return;
    const layerAlpha = num(layerStyle.opacity, 0);
    if (layerAlpha <= 0.004) return;

    for (const el of countdownLayer.querySelectorAll('.ending-countdown')) {
      const text = el.textContent ?? '';
      if (!text) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const alpha = layerAlpha * num(style.opacity, 1);
      if (alpha <= 0.004 || isInvisibleColor(style.color)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const font = scaledFont(style);
      resetCtx(outCtx);
      outCtx.globalAlpha = clamp01(alpha);
      outCtx.font = font;
      outCtx.textBaseline = 'alphabetic';
      outCtx.fillStyle = style.color;
      const spacing = num(style.letterSpacing, 0);
      if ('letterSpacing' in outCtx && spacing) outCtx.letterSpacing = `${toS(spacing)}px`;
      const shadow = parseTextShadow(style.textShadow);
      if (shadow) {
        outCtx.shadowColor = shadow.color;
        outCtx.shadowBlur = toS(shadow.blur);
        outCtx.shadowOffsetX = toS(shadow.offsetX);
        outCtx.shadowOffsetY = toS(shadow.offsetY);
      }
      // Both are absolutely positioned and shrink-wrap, so the rect IS the text
      // box; line-height is 1 (styles.css:120) so the strut maths still applies.
      outCtx.fillText(text, toX(rect.left), toY(rect.top) + baselineIn(toS(rect.height), font));
      resetCtx(outCtx);
    }
  }

  // --- frame ----------------------------------------------------------------
  //
  // Failures MUST be countable, not just warned once. These renders run
  // headless and report only through status.json; a single bad
  // getComputedStyle on frame 0 would otherwise yield a full-length,
  // apparently-successful MP4 with no story text and no signal anywhere.
  let warned = false;
  let failures = 0;
  let lastError = null;
  let paintedFrames = 0;
  const TRACE_MAX = 20000;
  let trace = [];
  /** Identify which oat a callout belongs to, for the motion trace. */
  function oatIndexOf(observation) {
    const oats = api()?.oats ?? [];
    for (let i = 0; i < oats.length; i++) if (oats[i]?.observation === observation) return i;
    return -1;
  }

  function noteFailure(err) {
    failures++;
    lastError = String((err && err.stack) || err);
    if (warned) return;
    warned = true;
    console.warn('[replay/overlays] overlay pass failed; frames show the GL canvas only', err);
  }

  function paintOverlays(virtualMs) {
    refreshFrame();
    const callouts = collectCallouts();
    pauseOverlayAnimations(callouts.map((entry) => entry.observation));
    for (const entry of callouts) paintCallout(entry, virtualMs);
    // #annotationLayer is z-index 2 (styles.css:272); the per-callout z-indices
    // are inside that stacking context, so both ending layers (8 and 9) sit
    // above every callout regardless of how large those get.
    paintEndingFade();
    paintCountdown();
  }

  return {
    /** The canvas to hand to createMp4Encoder / VideoFrame. */
    canvas: out,
    ctx: outCtx,
    get scale() { return frame.scale; },

    /** Health of the overlay pass, for status.json. */
    stats() {
      return { paintedFrames, failures, lastError, enabled, trace };
    },

    /**
     * Draw one output frame: the GL canvas, then the overlays as of `virtualMs`.
     * MUST be called in the same JS task as the tick that drew `glCanvas`.
     * Returns the canvas to encode.
     */
    composite(glCanvas, virtualMs) {
      resetCtx(outCtx);
      if (glCanvas) outCtx.drawImage(glCanvas, 0, 0, width, height);
      if (!enabled) return out;
      try {
        paintOverlays(Number(virtualMs) || 0);
        paintedFrames++;
      } catch (err) {
        noteFailure(err);
        // Repaint the clean GL frame: a throw partway through paintCallout can
        // otherwise leave a blurred slab with no text on it, on every frame.
        resetCtx(outCtx);
        if (glCanvas) outCtx.drawImage(glCanvas, 0, 0, width, height);
      }
      return out;
    },

    /** Turn the overlay pass on and off mid-render, for A/B captures. */
    setEnabled(next) { enabled = !!next; },

    dispose() {
      for (const anim of pausedAnimations) {
        try { anim.play(); } catch { /* cancelled meanwhile */ }
      }
      pausedAnimations.clear();
      for (const { el, width: w, height: h } of pinnedStyles) {
        el.style.width = w;
        el.style.height = h;
      }
      pinnedStyles.length = 0;
      injectedStyle?.remove();
      injectedStyle = null;
      metricsCache.clear();
      for (const scratch of scratches) scratch.shrink();
    },
  };
}

export default createOverlayCompositor;

