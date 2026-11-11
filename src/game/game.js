// The game: what happens each frame, and how the parts talk to each other.
//
//   the player clicks the body  -> an oat is placed (oats.js) and marked
//   the slime finds an oat      -> its story is told (stories/)
//   the flow (flow/)            -> start screen, intro, ending, restart
//
// The organism itself is a SlimeModel (src/slime/model.js); this file only
// feeds it food and disturbances, steps it, and asks how much slime is near
// each oat.

import * as THREE from 'three';
import { createOats } from './oats.js';
import { createPointerInput } from './input.js';
import { createFlow } from './flow/index.js';
import { createStories } from './stories/index.js';
import { createOatMarkers } from '../render/oat-markers.js';

const VIEW_CENTRE = new THREE.Vector2(0, 0);
// A frame that took longer than this many sixtieths of a second is treated as this long.
const MAX_FRAME_DT = 2.2;
const FIRST_SOUNDS = ['slime-fuse', 'intro'];
const FIRST_SOUNDS_WAIT_MS = 4000;
const LATER_SOUNDS = ['env-under-25mb', 'cuttlefish-reveal'];

export function createGame(ctx, { model, bodyView }) {
  const { surface, camera, cameraRig, audio, diag } = ctx;
  const oats = createOats({ surface, sizeScale: ctx.slimeSize });
  const markers = createOatMarkers(ctx);
  const stories = createStories(ctx, {
    markers,
    coverageNear: (uvs) => model.coverageNear(uvs),
    onStoryTextStarted: (oat, now) => oats.startDecay(oat, now),
    getTextColor: () => bodyView.look.slimeBaseColor,
  });
  const flow = createFlow(ctx, { getInitialOat: () => oats.initial, seedColony, resetWorld });
  const pointer = createPointerInput(
    { canvas: ctx.dom.canvas, camera, surface, sizeScale: ctx.slimeSize },
    { onDisturb: (disturbance) => model.setDisturbance(disturbance), onClick: placeOat },
  );
  const referenceDistance = cameraRig.initialPose.position.distanceTo(cameraRig.initialPose.target);
  let lastFrameMs = null;
  let slimeTouched = true;

  // The first oat sits where the opening view looks at the body; the colony grows from it.
  function placeInitialOat(now) {
    const hit = surface.raycast(VIEW_CENTRE, camera);
    if (!hit) {
      diag.log('game', 'the centre of the view misses the body; no initial oat');
      return;
    }
    const placed = oats.place(hit, now, { initial: true });
    if (placed.rejected) {
      diag.log('game', `initial oat rejected: ${placed.rejected}`);
      return;
    }
    // It is surrounded by slime from the first moment, so its food starts fading at once.
    oats.startDecay(placed.oat, now);
    stories.onOatPlaced(placed.oat, now);
  }

  function placeOat(hit, now) {
    const placed = oats.place(hit, now);
    if (placed.rejected === 'too-close') markers.fizzle(hit.point, hit.normal, now);
    if (placed.rejected) return null;
    if (placed.evicted) {
      markers.remove(placed.evicted);
      stories.onOatRemoved(placed.evicted);
    }
    markers.add(placed.oat, now);
    stories.onOatPlaced(placed.oat, now);
    return placed.oat;
  }

  function seedColony(now, { durationMs }) {
    const origin = oats.initial;
    if (!origin) return;
    model.seed(now, { uv: origin.uv, durationMs });
    audio.startTumbleLoop({ atMs: now, fadeInMs: durationMs });
    slimeTouched = true;
  }

  function resetWorld(now) {
    model.reset();
    bodyView.reset();
    stories.reset();
    markers.reset();
    oats.clear();
    placeInitialOat(now);
    slimeTouched = true;
  }

  // Where the slime's sound comes from: the falling intro oat while it falls,
  // otherwise the middle of the oats, weighted by how much food each still has.
  const soundAt = new THREE.Vector3();
  function soundSource() {
    const falling = flow.introSpritePosition();
    if (falling) return falling;
    let weight = 0;
    soundAt.set(0, 0, 0);
    for (const oat of oats.list) {
      const w = oat.power * oat.decay;
      soundAt.addScaledVector(oat.point, w);
      weight += w;
    }
    return weight > 0 ? soundAt.multiplyScalar(1 / weight) : cameraRig.controls.target;
  }

  const isTyping = (event) => /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName ?? '') || event.target?.isContentEditable;
  function onKeyDown(event) {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || isTyping(event)) return;
    const key = event.key.toLowerCase();
    if (key === 's') flow.skipIntro(performance.now());
    else if (key === 'm') stories.setEnabled(!stories.params.storyBoxesEnabled);
    else if (key === 'p') ctx.dom.app.dataset.panelVisible = ctx.dom.app.dataset.panelVisible === 'true' ? 'false' : 'true';
    else if (key === '1') bodyView.look.showSlime = !bodyView.look.showSlime;
    else if (key === '2') bodyView.look.showGold = !bodyView.look.showGold;
  }
  window.addEventListener('keydown', onKeyDown);

  return {
    oats,
    markers,
    stories,
    flow,
    placeOat,

    /** Assets are in and the first frame can be drawn. */
    async start() {
      placeInitialOat(performance.now());
      stories.load();
      // The Begin click plays a sound inside the click itself, which only works
      // if it is already decoded. Wait for it (briefly), then fetch the rest in
      // the background.
      await Promise.race([
        audio.preload(FIRST_SOUNDS),
        new Promise((resolve) => setTimeout(resolve, FIRST_SOUNDS_WAIT_MS)),
      ]);
      flow.setReady(performance.now());
      audio.preload(LATER_SOUNDS);
    },
    fail(message) { flow.fail(message); },

    /** One frame of game time. Rendering the scene is the caller's job. */
    update(now) {
      const dt = lastFrameMs === null ? 1 : Math.min((now - lastFrameMs) / 16.6667, MAX_FRAME_DT);
      lastFrameMs = now;

      flow.update(now);
      cameraRig.update(now);
      if (oats.update(now)) model.setFood(oats.asFood());

      model.step(now, dt);
      if (model.params.simulationSteps > 0) slimeTouched = true;
      bodyView.update(model, camera, slimeTouched);
      slimeTouched = false;

      markers.setVisible(bodyView.look.showOats);
      markers.update(now);
      stories.update(now);
      audio.update(now, { camera, sourcePosition: soundSource(), referenceDistance });
    },

    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      pointer.dispose();
      flow.dispose();
      stories.dispose();
      markers.dispose();
    },
  };
}
