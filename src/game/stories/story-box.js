// One story box: the frosted glass panel that appears above an oat and rolls
// its story through, line by line. Created (empty and invisible) when the oat
// is placed; startText() begins its one and only performance.
//
// Nothing here runs on its own clock. update(now) sets every moving part
// from the timeline, so a box looks the same for the same `now`.

import { STORY_BOX, LINE_WIPE_END_PERCENT } from './stories.config.js';
import { placeBox, tailFor } from './box-placement.js';
import { wrapText } from './text-layout.js';
import {
  buildStoryTimeline,
  envelopeAt,
  scrollOffsetAt,
  lineProgressAt,
  wipePositionPercent,
} from './story-timeline.js';

// A box is two elements at the same place: the glass (in glassLayer, beneath
// every box's text) and the text. Keeping all glass under all text means a
// nearer box's glass frosts the scene but never another box's words; how much
// a box behind another is blurred is set separately, by setObscured().
//
// layer: the element the text parts are added to. glassLayer: for the glass.
// oat: its `point` is where the box points at.
// visibility: a createSpotVisibility instance for the oat.
// measureContext: a Canvas2D context used to measure text widths.
// splitGraphemes: from createGraphemeSplitter().
export function createStoryBox({ layer, glassLayer, oat, visibility, measureContext, splitGraphemes }) {
  const glass = document.createElement('div');
  glass.className = 'story-glass';
  glassLayer.append(glass);
  const box = document.createElement('article');
  box.className = 'story-box';
  const tail = document.createElement('div');
  tail.className = 'story-tail';
  tail.setAttribute('aria-hidden', 'true');
  const content = document.createElement('div');
  content.className = 'story-content';
  const textEl = document.createElement('p');
  textEl.className = 'story-text';
  content.append(textEl);
  box.append(tail, content);
  layer.append(box);

  const boxStyle = createStyleWriter(box);
  const glassStyle = createStyleWriter(glass);
  const contentStyle = createStyleWriter(content);
  const tailStyle = createStyleWriter(tail);
  const projected = oat.point.clone(); // scratch for projecting to the screen

  let text = '';
  let timeline = null;
  let startedAtMs = 0;
  let roll = null; // the element that moves up, holding the lines
  let rollStyle = null;
  let lineStyles = [];
  let firstUnfinishedLine = 0; // lines before this are fully revealed
  let shown = false;
  // Where the box is this frame, for depth softening; null while hidden.
  let placement = null;

  function startText(storyText, now) {
    text = String(storyText ?? '');
    layOut(now);
  }

  // Wrap the text for the box as it measures right now and restart the
  // performance from the top. Also used when the story font arrives late,
  // because the lines were then cut for the wrong letter widths.
  function layOut(now) {
    const style = getComputedStyle(textEl);
    const paddingX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    measureContext.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const lines = wrapText(text, {
      measureWidth: (candidate) => measureContext.measureText(candidate).width,
      availableWidthPx: Math.max(STORY_BOX.minTextWidthPx, textEl.clientWidth - paddingX),
      splitGraphemes,
    });

    textEl.textContent = '';
    textEl.setAttribute('aria-label', text);
    roll = document.createElement('span');
    roll.className = 'story-roll';
    roll.setAttribute('aria-hidden', 'true');
    lineStyles = lines.map((lineText) => {
      const line = document.createElement('span');
      line.className = 'story-line';
      line.textContent = lineText || ' '; // keep an empty line one line tall
      roll.append(line);
      return createStyleWriter(line);
    });
    textEl.append(roll);
    rollStyle = createStyleWriter(roll);

    timeline = buildStoryTimeline({
      lineGraphemeCounts: lines.map((lineText) => splitGraphemes(lineText).length),
      lineHeightPx: Number.parseFloat(style.lineHeight) || STORY_BOX.fallbackLineHeightPx,
      viewportHeightPx: Math.max(1, textEl.clientHeight),
      textFadePx: Math.max(0, Number.parseFloat(style.getPropertyValue('--story-text-fade')) || 0),
    });
    startedAtMs = now;
    firstUnfinishedLine = 0;
    moveText(0);
  }

  function isPerforming(now) {
    return timeline !== null && now - startedAtMs < timeline.totalMs;
  }

  // viewport: { widthPx, heightPx } of the canvas. camera, surface: from ctx.
  function update(now, { viewport, camera, surface, tailLengthVh }) {
    const elapsedMs = now - startedAtMs;
    const envelope = timeline ? envelopeAt(timeline, elapsedMs) : null;
    if (!envelope || envelope.glass <= STORY_BOX.hiddenBelowGlassOpacity) {
      hide();
      return;
    }
    moveText(elapsedMs);

    const spatialOpacity = visibility.update(now, camera, surface);
    projected.copy(oat.point).project(camera);
    if (projected.z < -1 || projected.z > 1) {
      hide(); // behind the camera or beyond the far plane
      return;
    }
    const anchorPx = {
      x: (projected.x * 0.5 + 0.5) * viewport.widthPx,
      y: (-projected.y * 0.5 + 0.5) * viewport.heightPx,
    };
    const rect = placeBox(anchorPx, viewport, tailLengthVh);

    boxStyle.set('left', `${rect.left.toFixed(1)}px`);
    boxStyle.set('top', `${rect.top.toFixed(1)}px`);
    boxStyle.set('opacity', '1');
    boxStyle.set('--story-glass-opacity', envelope.glass.toFixed(3));
    boxStyle.set('--story-text-opacity', envelope.text.toFixed(3));
    boxStyle.set('--story-spatial-opacity', spatialOpacity.toFixed(3));
    glassStyle.set('left', `${rect.left.toFixed(1)}px`);
    glassStyle.set('top', `${rect.top.toFixed(1)}px`);
    glassStyle.set('--story-glass-opacity', envelope.glass.toFixed(3));
    glassStyle.set('--story-spatial-opacity', spatialOpacity.toFixed(3));
    // Boxes of nearer oats are drawn over boxes of farther ones.
    const depth01 = Math.max(0, Math.min(1, (projected.z + 1) / 2));
    const zIndex = String(Math.round((1 - depth01) * STORY_BOX.zIndexRange));
    boxStyle.set('zIndex', zIndex);
    glassStyle.set('zIndex', zIndex);
    if (!shown) box.classList.add('is-visible');
    shown = true;
    placement = {
      rect,
      distanceWorld: camera.position.distanceTo(oat.point),
      presence: envelope.glass * spatialOpacity,
    };

    placeTail(tailFor(rect, anchorPx));
  }

  function moveText(elapsedMs) {
    rollStyle.set('transform', `translate3d(0, ${scrollOffsetAt(timeline, elapsedMs).toFixed(2)}px, 0)`);
    // Only a couple of lines are mid-wipe at any time: skip the finished ones
    // and stop at the first that has not begun.
    for (let i = firstUnfinishedLine; i < lineStyles.length; i++) {
      const progress = lineProgressAt(timeline, i, elapsedMs);
      const x = progress >= 1 ? LINE_WIPE_END_PERCENT : wipePositionPercent(progress);
      const position = `${x.toFixed(3)}% 0`;
      lineStyles[i].set('maskPosition', position);
      lineStyles[i].set('webkitMaskPosition', position);
      if (progress >= 1 && i === firstUnfinishedLine) firstUnfinishedLine += 1;
      if (progress <= 0) break;
    }
  }

  function placeTail(line) {
    if (!line) {
      tailStyle.set('opacity', '0');
      return;
    }
    tailStyle.set('left', `${line.leftPx.toFixed(1)}px`);
    tailStyle.set('top', `${line.topPx.toFixed(1)}px`);
    tailStyle.set('width', `${line.lengthPx.toFixed(1)}px`);
    tailStyle.set('opacity', '1');
    tailStyle.set('transform', `rotate(${line.angleRad.toFixed(4)}rad)`);
  }

  function hide() {
    if (shown) box.classList.remove('is-visible');
    shown = false;
    placement = null;
    boxStyle.set('opacity', '0');
    boxStyle.set('--story-spatial-opacity', '0');
    glassStyle.set('--story-spatial-opacity', '0');
    tailStyle.set('opacity', '0');
  }

  // amount: 0 = clear, 1 = fully behind another box's glass (see
  // depth-softening.js). The words are blurred and dimmed as that glass would.
  function setObscured(amount, { blurRadiusPx, tintOpacity }) {
    const blurPx = amount * blurRadiusPx;
    contentStyle.set('filter', blurPx < 0.05 ? 'none' : `blur(${blurPx.toFixed(2)}px)`);
    contentStyle.set('--story-obscured-opacity', (1 - amount * tintOpacity).toFixed(3));
  }

  function dispose() {
    box.remove();
    glass.remove();
  }

  return {
    startText,
    relayout: layOut,
    isPerforming,
    isAttached: () => box.isConnected,
    update,
    getPlacement: () => placement,
    setObscured,
    hide,
    dispose,
  };
}

// Writes a style property only when its value changed: most values hold
// still from one frame to the next, and style writes are not free.
function createStyleWriter(element) {
  const written = new Map();
  return {
    set(property, value) {
      if (written.get(property) === value) return;
      written.set(property, value);
      if (property.startsWith('--')) element.style.setProperty(property, value);
      else element.style[property] = value;
    },
  };
}
