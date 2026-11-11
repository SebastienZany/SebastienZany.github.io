// Smoke test for the flow: drives createFlow with a fake clock, fake DOM and
// recording stubs for ctx/hooks, and checks WHEN things happen.
//
//   node src/game/flow/smoke-test.mjs
//
// 'three' is swapped for smoke-three-stub.mjs (see there for the fake camera).

import assert from 'node:assert/strict';
import { register } from 'node:module';

const stubUrl = new URL('./smoke-three-stub.mjs', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(specifier, context, next) {
     if (specifier === 'three') return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
     return next(specifier, context);
   }`,
));
const { Vector3 } = await import('three');
const { createFlow, flowConfig } = await import('./index.js');
const { formatCountdown } = await import('./ending-overlay.js');

// ---- fakes ---------------------------------------------------------------

function fakeElement(id = '') {
  const classes = new Set();
  const listeners = new Map();
  return {
    id, style: {}, hidden: false, disabled: false, textContent: '', className: '',
    attributes: {}, children: [], removed: false,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    fire(type, event = {}) { listeners.get(type)?.(event); },
    append(...children) { this.children.push(...children); },
    remove() { this.removed = true; },
    matches: () => false,
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    }),
  };
}

function makeWorld({ dev = false, introReady = true, camouflageMs = 20000 } = {}) {
  const clock = { now: 0 };
  const log = []; // { at, what, ...detail } in call order
  const record = (what, detail = {}) => log.push({ at: clock.now, what, ...detail });

  const parts = {
    '#startScreen': fakeElement('startScreen'),
    '#startScreenTitle': fakeElement('title'),
    '#startScreenIntroLine': fakeElement('introLine'),
    '#startScreenStatus': fakeElement('status'),
    '#startButton': fakeElement('button'),
  };
  parts['#startButton'].hidden = true; // as in index.html
  const dots = [fakeElement(), fakeElement(), fakeElement()];
  const root = parts['#startScreen'];
  root.querySelector = (selector) => parts[selector];
  root.querySelectorAll = () => dots;

  const windowListeners = new Map();
  const view = {
    performance: { now: () => clock.now },
    addEventListener: (type, handler) => windowListeners.set(type, handler),
    removeEventListener: (type) => windowListeners.delete(type),
  };
  const app = fakeElement('app');
  app.querySelector = (selector) => parts[selector];
  app.ownerDocument = { defaultView: view, createElement: () => fakeElement() };

  const ready = new Set(['slime-fuse', 'slime-appear-stretch', 'cuttlefish-camouflage']);
  if (introReady) ready.add('intro');
  const pendingLoads = []; // { names, resolve }
  const audio = {
    ready,
    pendingLoads,
    unlockFromGesture: () => record('unlock'),
    preload(names) {
      record('preload', { names: [...names] });
      return new Promise((resolve) => pendingLoads.push({ names, resolve }));
    },
    isReady: (name) => ready.has(name),
    durationMs: (name) => (name === 'cuttlefish-camouflage' ? camouflageMs : 1000),
    playOneShot(name, { atMs } = {}) {
      if (!ready.has(name)) return null;
      record('play', { name, atMs });
      return { stop: ({ fadeMs } = {}) => record('stop', { name, fadeMs }) };
    },
    startEnvLoop: () => record('startEnvLoop'),
    stopEnvLoop: ({ fadeMs } = {}) => record('stopEnvLoop', { fadeMs }),
    startTumbleLoop: () => record('startTumbleLoop'),
    stopTumbleLoop: ({ fadeMs } = {}) => record('stopTumbleLoop', { fadeMs }),
  };

  const scene = { children: [], add(o) { this.children.push(o); }, remove(o) { this.children = this.children.filter((c) => c !== o); } };
  const ctx = {
    diag: { log() {} },
    flags: { dev },
    dom: { app },
    scene,
    camera: { matrixWorld: {}, updateMatrixWorld() {}, updateProjectionMatrix() {} },
    audio,
  };
  const initialOat = { point: new Vector3(0, 2, 0), normal: new Vector3(0, 1, 0) };
  const hooks = {
    getInitialOat: () => initialOat,
    seedColony: (now, { durationMs }) => record('seedColony', { now, durationMs }),
    resetWorld: (now) => record('resetWorld', { now }),
  };
  const flow = createFlow(ctx, hooks);

  // Run frames up to and including `untilMs`. Each frame also lets promise
  // callbacks run, as the browser would between frames.
  async function runTo(untilMs, stepMs = 1) {
    while (clock.now < untilMs) {
      clock.now = Math.min(untilMs, clock.now + stepMs);
      await Promise.resolve();
      flow.update(clock.now);
    }
  }
  const first = (what, match = () => true) => log.find((entry) => entry.what === what && match(entry));
  const count = (what, match = () => true) => log.filter((entry) => entry.what === what && match(entry)).length;
  const clickBegin = () => parts['#startButton'].fire('click');
  const input = (type = 'pointermove') => windowListeners.get(type)();

  return { clock, log, flow, parts, dots, app, scene, audio, initialOat, runTo, first, count, clickBegin, input, windowListeners };
}

const near = (actual, expected, toleranceMs, label) =>
  assert.ok(Math.abs(actual - expected) <= toleranceMs, `${label}: expected ~${expected}, got ${actual}`);

const T = flowConfig;
const PEAK = T.intro.clickSoundPeakMs;                              // 826.23
const TO_CONTENT = PEAK + T.startScreen.uiFadeMs + T.intro.silentBeatMs; // 2826.23
const TOP_EDGE = T.intro.oatTopEdgeDelayMs;                         // 5500

// ---- 1. loading -> ready -> Begin -> full intro ------------------------------

{
  const w = makeWorld();
  const { flow, parts } = w;
  const button = parts['#startButton'];
  const status = parts['#startScreenStatus'];
  assert.equal(flow.phase, 'loading');

  await w.runTo(100);
  flow.setReady(100);
  assert.equal(flow.phase, 'ready');
  await w.runTo(600);
  assert.equal(status.hidden, false);
  assert.equal(status.style.opacity, '0.500', 'status half faded 500 ms after ready');
  assert.equal(button.hidden, true);
  await w.runTo(1100 + 200);
  assert.equal(status.hidden, true);
  assert.equal(button.hidden, false);
  assert.equal(button.style.pointerEvents, 'none', 'Begin not clickable while nearly invisible');
  await w.runTo(2100);
  assert.equal(button.style.opacity, '1.000');
  assert.equal(button.style.pointerEvents, 'auto');
  assert.equal(parts['#startScreenIntroLine'].style.opacity, '0.000');

  await w.runTo(5000);
  w.clickBegin();
  const CLICK = 5000;
  const C = CLICK + TO_CONTENT;
  assert.equal(flow.phase, 'intro');
  assert.deepEqual(w.log.slice(0, 3).map((e) => [e.what, e.name ?? null, e.at]), [
    ['unlock', null, CLICK], ['play', 'slime-fuse', CLICK], ['play', 'intro', CLICK],
  ], 'unlock + click sound + intro scheduling all happen inside the click');
  near(w.first('play', (e) => e.name === 'intro').atMs, C, 0.001, 'intro.wav start time');
  assert.deepEqual(w.first('preload').names, T.sounds.preloadAfterBegin);
  assert.equal(parts['#startScreen'].classList.contains('is-armed'), true);
  w.clickBegin(); // a second click does nothing
  assert.equal(w.count('play', (e) => e.name === 'slime-fuse'), 1);

  // Begin holds until the click sound's peak, then fades with the title.
  await w.runTo(CLICK + 800);
  assert.equal(button.style.opacity, '1.000');
  assert.equal(parts['#startScreenTitle'].style.opacity, '1.000');
  await w.runTo(CLICK + PEAK + 500);
  near(Number(parts['#startScreenTitle'].style.opacity), 0.5, 0.01, 'title half faded');
  near(Number(button.style.opacity), 0.5, 0.01, 'Begin half faded');
  await w.runTo(C + 500);
  near(Number(parts['#startScreenIntroLine'].style.opacity), 0.5, 0.01, 'intro line half in');
  // Dots arrive at C + 875, 1750, 2625.
  await w.runTo(C + 875 + 500);
  near(Number(w.dots[0].style.opacity), 0.5, 0.01, 'first dot');
  assert.equal(w.dots[1].style.opacity, '0.000');
  await w.runTo(C + 2625 + 500);
  near(Number(w.dots[2].style.opacity), 0.5, 0.01, 'third dot');
  // Intro line out from C+3500; whole screen out from C+4500 to C+5500.
  await w.runTo(C + 4000);
  near(Number(parts['#startScreenIntroLine'].style.opacity), 0.5, 0.01, 'intro line half out');
  assert.equal(parts['#startScreen'].style.opacity, '1.000');
  await w.runTo(C + 5000);
  near(Number(parts['#startScreen'].style.opacity), 0.5, 0.01, 'screen half clear');

  // The oat: its lower edge is on the top screen edge (NDC 1 = world y 10 in
  // the fake camera) at C+5500, which is also when the ambience starts.
  await w.runTo(C + TOP_EDGE);
  const position = flow.introSpritePosition();
  assert.ok(position, 'the oat is falling by C+5500');
  const sprite = w.scene.children[0];
  near(position.y - sprite.scale.y / 2, 10, 0.02, 'oat lower edge at the top of the screen');
  near(w.first('startEnvLoop').at, C + TOP_EDGE, 1, 'ambience start');
  assert.equal(parts['#startScreen'].classList.contains('is-running'), true);

  const intro = flow.debugState().intro;
  const S = intro.fallStartedAtMs;
  near(S, C + TOP_EDGE - intro.topEdgeLeadMs, 0.001, 'fall start');
  assert.ok(intro.topEdgeLeadMs > 1000 && intro.topEdgeLeadMs < 6800, `lead ${intro.topEdgeLeadMs}`);

  const fallMs = T.introOat.fallMs;
  const landMs = fallMs * T.introOat.landAtProgress; // 6800
  await w.runTo(S + landMs - 300);
  assert.ok(flow.introSpritePosition().y > 2.14 + 0.01, 'still falling just before landing');
  await w.runTo(S + landMs + 1);
  near(flow.introSpritePosition().y, 2.14, 1e-6, 'landed 0.14 above the initial oat');
  near(sprite.material.opacity, 1, 0.001, 'not yet brighter at landing');
  await w.runTo(S + fallMs - 1000);
  near(sprite.material.opacity, 1.72, 0.01, 'brightest just before the fade');
  near(sprite.scale.x, 0.96 * (1.12 - 0.16 + 0.38), 0.005, 'largest just before the fade');
  await w.runTo(S + fallMs - 990);
  near(w.first('play', (e) => e.name === 'slime-appear-stretch').at, S + fallMs - 1000, 1, 'seed sound');
  assert.equal(w.count('seedColony'), 0);

  await w.runTo(S + fallMs + 5);
  const seed = w.first('seedColony');
  near(seed.at, S + fallMs, 1, 'seedColony time');
  assert.equal(seed.durationMs, 3460);
  assert.equal(w.count('play', (e) => e.name === 'slime-appear-stretch'), 1);
  assert.equal(flow.introSpritePosition(), null);
  assert.equal(w.scene.children.length, 0);
  assert.equal(sprite.material.disposed, true);
  assert.equal(flow.phase, 'playing');
  assert.equal(parts['#startScreen'].classList.contains('is-complete'), true);
  // Order of the whole thing.
  const order = w.log.filter((e) => e.what !== 'preload').map((e) => e.name ?? e.what);
  assert.deepEqual(order, ['unlock', 'slime-fuse', 'intro', 'startEnvLoop', 'slime-appear-stretch', 'seedColony']);

  // ---- idle ending, following on from that game ----
  const grownAt = seed.at + 3460;
  await w.runTo(grownAt + 60000, 20);
  w.input('pointermove');                     // activity restarts the two minutes
  const lastInput = w.clock.now;
  await w.runTo(lastInput + 119900, 20);
  assert.equal(w.count('play', (e) => e.name === 'cuttlefish-camouflage'), 0);
  assert.equal(flow.phase, 'playing');
  await w.runTo(lastInput + 120020, 20);
  const camouflage = w.first('play', (e) => e.name === 'cuttlefish-camouflage');
  near(camouflage.at, lastInput + 120000, 20, 'idle ending start');
  assert.equal(camouflage.atMs, camouflage.at, 'idle: the sound starts now');
  assert.equal(flow.phase, 'ending');
  const fade = w.app.children[0];
  assert.equal(fade.className, 'ending-fade');
  await w.runTo(camouflage.at + 7000, 20);
  assert.equal(fade.style.opacity, '0.000', 'no black until 7 s into the sound');
  await w.runTo(camouflage.at + 13500, 20);   // halfway through the 13 s fade
  near(Number(fade.style.opacity), 0.5, 0.01, 'fade halfway');
  assert.equal(w.app.children[1].style.opacity, '0', 'no countdown for the idle ending');

  // Moving the mouse calls it off.
  w.input('pointermove');
  assert.equal(fade.style.opacity, '0.000');
  assert.equal(w.log.at(-1).what, 'stop');
  assert.equal(w.log.at(-1).name, 'cuttlefish-camouflage');
  assert.equal(flow.phase, 'playing');
  assert.equal(w.count('resetWorld'), 0);

  // Left alone again, it runs to the end and restarts.
  const calledOffAt = w.clock.now;
  await w.runTo(calledOffAt + 120000 + 20000 + 40, 20);
  const tail = w.log.slice(-4).map((e) => [e.what, e.name ?? e.fadeMs ?? null]);
  assert.deepEqual(tail, [
    ['stop', 'cuttlefish-camouflage'], ['resetWorld', null], ['stopEnvLoop', 2500], ['stopTumbleLoop', 1200],
  ], 'restart order');
  near(w.first('resetWorld').at, calledOffAt + 140000, 40, 'restart time');
  assert.equal(flow.phase, 'ready');
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.style.opacity, '1.000', 'Begin is fully shown at once after a restart');
  assert.equal(button.style.pointerEvents, 'auto');
  assert.equal(parts['#startScreen'].style.opacity, '1.000');
  assert.equal(parts['#startScreen'].classList.contains('is-complete'), false);
  assert.equal(fade.style.opacity, '0.000');

  // The start screen never times out, and Begin works again.
  await w.runTo(w.clock.now + 300000, 100);
  assert.equal(w.count('resetWorld'), 1);
  w.clickBegin();
  assert.equal(flow.phase, 'intro');
  assert.equal(w.count('play', (e) => e.name === 'intro'), 2);
  flow.dispose();
  assert.equal(w.windowListeners.size, 0);
  assert.equal(fade.removed, true);
}

// ---- 2. intro.wav not decoded at the click ---------------------------------

{
  // Decoded 1500 ms after the click: the timeline starts then.
  const w = makeWorld({ introReady: false });
  w.flow.setReady(0);
  await w.runTo(3000);
  w.clickBegin();
  assert.equal(w.first('play').name, 'slime-fuse');
  assert.equal(w.first('preload').names[0], 'intro');
  assert.equal(w.parts['#startButton'].disabled, true);
  await w.runTo(4500);
  assert.equal(w.flow.debugState().intro.requestedAtMs, 0, 'timeline held');
  assert.equal(w.parts['#startScreenTitle'].style.opacity, '1.000');
  w.audio.ready.add('intro');
  await w.runTo(4501);
  const introPlay = w.first('play', (e) => e.name === 'intro');
  assert.equal(introPlay.at, 4501);
  near(introPlay.atMs, 4501 + TO_CONTENT, 0.001, 'intro.wav scheduled from the late commit');
  assert.equal(w.flow.debugState().beginClickedAtMs, 4501);
}
{
  // Never decoded: give up waiting after 4000 ms and run silent.
  const w = makeWorld({ introReady: false });
  w.flow.setReady(0);
  await w.runTo(3000);
  w.clickBegin();
  await w.runTo(6999);
  assert.equal(w.flow.debugState().intro.requestedAtMs, 0);
  await w.runTo(7000);
  near(w.flow.debugState().intro.requestedAtMs, 7000 + PEAK, 0.001, 'committed at the deadline');
  assert.equal(w.count('play', (e) => e.name === 'intro'), 0);
  // Decoded later after all: it starts late rather than never.
  w.audio.ready.add('intro');
  await w.runTo(7500);
  assert.equal(w.count('play', (e) => e.name === 'intro'), 1);
}

// ---- 3. skipping ------------------------------------------------------------

{
  // Mid-intro: cut the music, start the ambience, seed now.
  const w = makeWorld();
  assert.equal(w.flow.skipIntro(0), false, 'cannot skip while loading');
  w.flow.setReady(0);
  await w.runTo(3000);
  w.clickBegin();
  await w.runTo(6000);
  assert.equal(w.flow.skipIntro(6000), true);
  const after = w.log.filter((e) => e.at === 6000).map((e) => e.name ?? e.what);
  assert.deepEqual(after, ['unlock', 'intro', 'startEnvLoop', 'slime-appear-stretch', 'seedColony']);
  assert.equal(w.first('stop').name, 'intro');
  assert.equal(w.flow.phase, 'playing');
  assert.equal(w.parts['#startScreen'].classList.contains('is-complete'), true);
  assert.equal(w.flow.skipIntro(6001), false, 'nothing left to skip');
  await w.runTo(30000, 10);
  assert.equal(w.count('seedColony'), 1);
  assert.equal(w.count('startEnvLoop'), 1);
}
{
  // From the start screen, before Begin.
  const w = makeWorld();
  w.flow.setReady(0);
  await w.runTo(500);
  assert.equal(w.flow.skipIntro(500), true);
  assert.deepEqual(w.log.map((e) => e.name ?? e.what), ['unlock', 'startEnvLoop', 'slime-appear-stretch', 'seedColony']);
  assert.equal(w.flow.phase, 'playing');
}
{
  // ?dev: setReady goes straight to a seeded colony.
  const w = makeWorld({ dev: true });
  w.flow.setReady(250);
  assert.equal(w.flow.phase, 'playing');
  assert.equal(w.parts['#startScreen'].style.display, 'none');
  assert.equal(w.first('seedColony').now, 250);
  assert.equal(w.first('seedColony').durationMs, 3460);
  assert.equal(w.count('unlock'), 0);
}

// ---- 4. time-limit ending -----------------------------------------------------

{
  const w = makeWorld({ camouflageMs: 20000 });
  w.flow.setEndingEnabled(true);
  w.flow.setReady(0);
  await w.runTo(3000);
  w.clickBegin();
  const CLICK = 3000;
  await w.runTo(CLICK + 1);
  assert.equal(w.flow.skipIntro(w.clock.now), true); // the skip moves the "click" time
  const zero = w.clock.now;
  const layer = w.app.children[1];
  await w.runTo(zero + 3400);
  assert.equal(w.flow.debugState().ending.active, false, 'not armed until the colony has grown in');
  await w.runTo(zero + 3461);
  const ending = w.flow.debugState().ending;
  assert.equal(ending.trigger, 'time-limit');
  assert.equal(ending.phase, 'gameplay');
  assert.equal(ending.endAtMs, zero + 120000);
  assert.equal(ending.camouflageStartAtMs, zero + 100000);
  assert.equal(layer.style.opacity, '1');
  assert.equal(layer.children[0].textContent, formatCountdown(zero + 100000 - w.clock.now));
  assert.equal(formatCountdown(83450), '01:23.5');
  assert.equal(formatCountdown(-5), '00:00.0');

  // Input does not call off a time-limit ending, and the idle ending stays out of it.
  await w.runTo(zero + 99990, 10);
  w.input('keydown');
  assert.equal(w.flow.phase, 'playing');
  await w.runTo(zero + 100010, 10);
  const camouflage = w.first('play', (e) => e.name === 'cuttlefish-camouflage');
  assert.equal(camouflage.atMs, zero + 100000, 'sound placed to end on the deadline');
  assert.equal(w.flow.phase, 'ending');
  w.input('keydown');
  assert.equal(w.flow.phase, 'ending');
  assert.equal(layer.children[1].textContent, formatCountdown(zero + 120000 - w.clock.now));
  await w.runTo(zero + 120000, 10);
  near(w.first('resetWorld').at, zero + 120000, 10, 'time-limit restart');
  assert.equal(w.flow.phase, 'ready');
  assert.equal(layer.style.opacity, '0');
  assert.equal(w.count('play', (e) => e.name === 'cuttlefish-camouflage'), 1);
}
{
  // Camouflage sound missing: plain 3 s fade into the deadline.
  const w = makeWorld();
  w.audio.ready.delete('cuttlefish-camouflage');
  w.flow.setEndingEnabled(true);
  w.flow.setReady(0);
  await w.runTo(1000, 10);
  w.flow.skipIntro(1000); // the time limit runs from here
  await w.runTo(5000, 10);
  assert.equal(w.flow.debugState().ending.phase, 'preparing');
  w.audio.pendingLoads.forEach((load) => load.resolve()); // loading ends, clip still absent
  await w.runTo(5020, 10);
  const ending = w.flow.debugState().ending;
  assert.equal(ending.phase, 'fade');
  assert.equal(ending.fadeStartAtMs, 118000);
  assert.equal(ending.endAtMs, 121000);
  await w.runTo(119500, 10);
  near(Number(w.app.children[0].style.opacity), 0.5, 0.01, 'fallback fade halfway');
  await w.runTo(121000, 10);
  assert.equal(w.count('resetWorld'), 1);
}

console.log('flow smoke test: all checks passed');
