// Virtual clock for offline replay rendering.
//
// MUST be loaded (and installed) BEFORE main.js evaluates, because main.js
// captures timestamps at module scope (e.g. cameraKeyboardOrbitState.lastUpdateAt).
//
// The premise, established by auditing main.js: there is no Date.now(), no
// THREE.Clock, no getElapsedTime. The rAF timestamp and performance.now() are
// the ONLY sources of wall time. So shimming exactly those two converts the
// whole clock surface without editing main.js at all.
//
// Two modes:
//   'live'    — passthrough. Real rAF, real performance.now. Boot runs normally.
//   'offline' — rAF callbacks are captured instead of scheduled, and both the
//               rAF timestamp and performance.now() return the virtual clock.
//               The driver calls step() to advance exactly one tick.
//
// NOTE: main.js awaits `new Promise(r => requestAnimationFrame(r))` during
// shader prewarm, and runs a waitFrame() loop before `started`. Both need real
// frames, which is why boot happens in 'live' mode.

const realRaf = window.requestAnimationFrame.bind(window);
const realCaf = window.cancelAnimationFrame.bind(window);
const realNow = performance.now.bind(performance);

const state = {
  mode: 'live',
  virtualMs: 0,
  pending: null,      // the single rAF callback main.js has armed
  pendingId: 1,
  tickIndex: 0,
  installed: false,
  lastCb: null,
};

const frameHooks = [];

/** Run fn(timestamp) after every game frame, in live and offline mode alike. */
export function onFrame(fn) {
  frameHooks.push(fn);
  return () => {
    const i = frameHooks.indexOf(fn);
    if (i >= 0) frameHooks.splice(i, 1);
  };
}

export const clock = {
  get mode() { return state.mode; },
  get virtualMs() { return state.virtualMs; },
  get tickIndex() { return state.tickIndex; },
  get hasPending() { return state.pending !== null; },
  realNow,
};

// A hidden tab never fires rAF, so boot (which awaits real frames during shader
// prewarm) stalls forever offscreen. Drive those frames with a MessageChannel
// port instead — unlike setTimeout it is not clamped in background documents.
// This is the same hazard the render loop faces; solving it here solves both.
const mc = new MessageChannel();
const hiddenQueue = [];
mc.port1.onmessage = () => {
  const cb = hiddenQueue.shift();
  if (cb) cb(realNow());
};
const scheduleHidden = (cb) => {
  hiddenQueue.push(cb);
  mc.port2.postMessage(0);
  return ++state.pendingId;
};

// Route a live-mode callback the safe way: real rAF when visible, MessageChannel
// when hidden. Used by both the rAF shim and exitOffline(), because handing a
// callback to a real rAF in a hidden tab silently kills the frame loop.
const scheduleLive = (cb) =>
  (document.visibilityState === 'hidden' ? scheduleHidden(cb) : realRaf(cb));

export function installClock() {
  if (state.installed) return clock;
  state.installed = true;

  window.requestAnimationFrame = (cb) => {
    // Wrap at registration so frame hooks fire in BOTH modes: live callbacks go
    // through scheduleLive, offline ones are invoked by step(), and both end up
    // calling this same wrapper. Hooks run AFTER the game's frame so they observe
    // the state the frame produced — which is what the recorder needs to sample.
    const wrapped = (t) => {
      cb(t);
      for (const h of frameHooks) {
        try { h(t); } catch (err) { console.warn('[clock] frame hook failed', err); }
      }
    };
    state.lastCb = wrapped;
    if (state.mode === 'live') return scheduleLive(wrapped);
    state.pending = wrapped;
    return ++state.pendingId;
  };
  window.cancelAnimationFrame = (id) => {
    if (state.mode === 'live') return realCaf(id);
    state.pending = null;
  };
  performance.now = () => (state.mode === 'live' ? realNow() : state.virtualMs);

  return clock;
}

// Switch to manual stepping. `startMs` seeds the virtual clock; passing the
// current real time keeps already-captured module-scope timestamps meaningful,
// which matters because main.js stores absolute deadlines (oat decay, intro,
// ending) that were stamped during live boot.
export function enterOffline({ startMs = realNow() } = {}) {
  state.mode = 'offline';
  state.virtualMs = startMs;
  state.tickIndex = 0;

  // Hand off the in-flight callback. While live+hidden it is parked in
  // hiddenQueue, not in state.pending, so without this the first step() finds
  // nothing armed. Running it now re-arms through the offline path.
  while (hiddenQueue.length && !state.pending) {
    const cb = hiddenQueue.shift();
    cb(state.virtualMs);
  }
}

/** Switch to offline mode and resolve once a callback is armed. */
export async function armOffline(opts) {
  enterOffline(opts);
  for (let i = 0; i < 240 && !state.pending; i++) {
    // If the loop went idle (e.g. a previous exit handed the callback to a real
    // rAF in a hidden tab), restart it from the retained reference.
    if (i === 10 && !state.pending && state.lastCb) state.lastCb(state.virtualMs);
    await new Promise((r) => setTimeout(r, 16));
  }
  if (!state.pending) throw new Error('frame loop never re-armed after entering offline mode');
  return clock;
}

export function exitOffline() {
  state.mode = 'live';
  const cb = state.pending ?? state.lastCb;
  state.pending = null;
  if (cb) scheduleLive(cb);
}

// Advance exactly one tick. dtMs 1000/60 gives main.js rawDt === 1.0 exactly,
// because main.js computes rawDt = (now - last) / 16.6667.
export function step(dtMs = 1000 / 60) {
  if (state.mode !== 'offline') throw new Error('step() requires offline mode');
  const cb = state.pending;
  if (!cb) throw new Error('no rAF callback armed — did the frame loop stop?');
  state.pending = null;
  state.virtualMs += dtMs;
  state.tickIndex++;
  cb(state.virtualMs);
  return state.tickIndex;
}
