// Stories: every oat but the first carries a story. When the slime reaches an
// oat, its glow fades out and a glass box rises above it and rolls the story
// through. This file ties the parts together:
//
//   story-library.js   the texts and the order they are handed out in
//   trigger-poller.js  "has the slime reached this oat yet?"
//   story-box.js       one box on screen (layout, reveal, placement)
//   params.js          the Story labels settings and their CSS variables
//
// One oat's story, in time (T = the moment its coverage crosses the threshold):
//   T          reveal sound; the oat's marker starts fading out
//   T + 1800   the next story is taken from the library and laid out;
//              onStoryTextStarted fires; the glass starts fading in
//   T + 4400   the first line starts to wipe in ... (see story-timeline.js)

import { STORY_TRIGGER, BOX_VISIBILITY, LINE_WIPE, TEXT_COLOR_DEFAULT } from './stories.config.js';
import { paramSchema, defaultParams, cssVarsFor } from './params.js';
import { createStoryLibrary } from './story-library.js';
import { createTriggerPoller } from './trigger-poller.js';
import { createStoryBox } from './story-box.js';
import { createSpotVisibility } from './spot-visibility.js';
import { createGraphemeSplitter } from './text-layout.js';

export { paramSchema, defaultParams };

// hooks: { markers, coverageNear(uvs), onStoryTextStarted(oat, now) } as in
// docs/CONTRACTS.md, plus two optional extras (see NOTES.md):
//   params          the live settings object; defaults are used if absent
//   getTextColor()  -> '#rrggbb', the story text colour (the slime's colour)
export function createStories(ctx, hooks) {
  const params = hooks.params ?? defaultParams();
  const log = (tag, detail) => ctx.diag?.log?.(tag, detail);

  const layer = document.createElement('div');
  layer.className = 'story-layer';
  layer.setAttribute('aria-hidden', 'true');
  // The wipe mask is the same for every line; story.css reads it from here.
  layer.style.setProperty('--story-line-mask', LINE_WIPE.maskImage);
  layer.style.setProperty('--story-line-mask-size', `${(LINE_WIPE.maskScale * 100).toFixed(0)}% 100%`);
  layer.style.setProperty('--story-line-mask-start', `${LINE_WIPE.startPositionPercent}% 0`);
  ctx.dom.overlay.append(layer);

  const measureContext = document.createElement('canvas').getContext('2d');
  const splitGraphemes = createGraphemeSplitter();
  const library = createStoryLibrary({ log });

  // Every oat on the body, in the order placed. `box` is null for the first
  // oat, which has no story. `waiting` = has a box that is not yet triggered.
  const entries = [];
  let storyOatCount = 0; // staggers the occlusion re-tests of successive oats
  let disposed = false;

  const poller = createTriggerPoller({
    entries,
    coverageNear: hooks.coverageNear,
    onCrossed: trigger,
    log,
  });

  function onOatPlaced(oat, now) {
    const entry = { oat, box: null, waiting: false, textStartAtMs: null, textStarted: false };
    if (!oat.initial) {
      storyOatCount += 1;
      const recheckPhaseMs =
        (storyOatCount * BOX_VISIBILITY.recheckPhaseStepMs) % BOX_VISIBILITY.occlusionRecheckMs;
      entry.box = createStoryBox({
        layer,
        oat,
        visibility: createSpotVisibility({ point: oat.point, normal: oat.normal, recheckPhaseMs, now }),
        measureContext,
        splitGraphemes,
      });
      entry.waiting = true;
      relayoutWhenFontsArrive(entry.box);
    }
    entries.push(entry);
    poller.invalidate();
  }

  function onOatRemoved(oat) {
    const index = entries.findIndex((entry) => entry.oat.id === oat.id);
    if (index < 0) return;
    entries[index].box?.dispose();
    entries.splice(index, 1);
    poller.invalidate();
  }

  // Lines are cut by measuring with the story font. If that font was still
  // loading when a box laid out its text, lay it out again once it is there.
  function relayoutWhenFontsArrive(box) {
    document.fonts?.ready?.then(() => {
      if (disposed || !box.isAttached()) return;
      const now = performance.now(); // a one-off event, not per-frame code
      if (box.isPerforming(now)) box.relayout(now);
    });
  }

  function trigger(entry, now) {
    entry.waiting = false;
    entry.textStartAtMs = now + STORY_TRIGGER.markerFadeOutMs;
    softly('reveal sound', () => ctx.audio.playOneShot(STORY_TRIGGER.soundName, { atMs: now }));
    softly('marker fade', () => hooks.markers.fadeOut(entry.oat, now, STORY_TRIGGER.markerFadeOutMs));
  }

  function startText(entry, now) {
    entry.textStarted = true;
    entry.box.startText(library.next(), now);
    softly('onStoryTextStarted', () => hooks.onStoryTextStarted(entry.oat, now));
  }

  function update(now) {
    syncCssVars();
    const enabled = params.storyBoxesEnabled !== false;
    poller.update(now, { enabled, threshold: Math.max(0, params.triggerThreshold ?? 0) });
    if (!enabled) {
      // Running stories keep their place in time while hidden, and stories
      // due to start wait until boxes are switched back on.
      for (const entry of entries) entry.box?.hide();
      return;
    }

    // Projection below needs the camera as it will be drawn this frame.
    ctx.camera.updateMatrixWorld(true);
    ctx.camera.matrixWorldInverse.copy(ctx.camera.matrixWorld).invert();
    const frame = {
      viewport: {
        widthPx: Math.max(1, ctx.dom.canvas.clientWidth),
        heightPx: Math.max(1, ctx.dom.canvas.clientHeight),
      },
      camera: ctx.camera,
      surface: ctx.surface,
      tailLengthVh: params.tailLengthVh,
    };
    for (const entry of entries) {
      if (!entry.box) continue;
      const due = entry.textStartAtMs !== null && !entry.textStarted && now >= entry.textStartAtMs;
      if (due) startText(entry, now);
      entry.box.update(now, frame);
    }
  }

  // Settings are read live: push them to CSS whenever one has changed.
  let writtenCssVars = {};
  function syncCssVars() {
    const vars = cssVarsFor(params, hooks.getTextColor?.() ?? TEXT_COLOR_DEFAULT);
    for (const name in vars) {
      if (writtenCssVars[name] === vars[name]) continue;
      layer.style.setProperty(name, vars[name]);
    }
    writtenCssVars = vars;
  }

  // A failing collaborator (a missing sound, a hook that throws) must not
  // take the frame loop down with it.
  function softly(what, action) {
    try {
      action();
    } catch (err) {
      log('stories', `${what} failed: ${err?.message ?? err}`);
    }
  }

  function setEnabled(on) {
    params.storyBoxesEnabled = !!on;
  }

  // A new game: no oats, and the stories start again from the first.
  function reset() {
    for (const entry of entries) entry.box?.dispose();
    entries.length = 0;
    storyOatCount = 0;
    poller.reset();
    library.rewind();
  }

  function dispose() {
    reset();
    disposed = true;
    layer.remove();
  }

  return {
    params,
    load: library.load,
    onOatPlaced,
    onOatRemoved,
    update,
    setEnabled,
    reset,
    dispose,
  };
}
