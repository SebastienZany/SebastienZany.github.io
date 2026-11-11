// The audio engine. See docs/CONTRACTS.md ("Audio") for the interface and
// NOTES.md here for what was carried over from the old game.
//
//   one-shots ───────────────────────────────┐
//   env loop ────────────────────────────────┼─> master -> [compressor] -> speakers
//   tumble loop -> spatial chain (+ reverb) ─┘
//
// Nothing in here decides WHEN a sound plays; the game calls in. Every public
// method is safe to call at any time (before unlock, before a clip has loaded,
// in a browser without WebAudio): it does nothing, logs, and returns.

import { createBufferCache } from './buffers.js';
import { createEnvLoop } from './env-loop.js';
import { createOneShots } from './one-shots.js';
import { createOutputGraph } from './output-graph.js';
import { createTumbleLoop } from './tumble-loop.js';

export function createAudio(ctx) {
  const diag = ctx?.diag ?? { log() {} };

  // Where the listener and the tumble source are, as last told by update().
  // Until then: the scene's camera, a source at the body's centre.
  const view = {
    camera: ctx?.camera ?? null,
    source: { x: 0, y: 0, z: 0 },
    referenceDistance: null,
  };

  const output = createOutputGraph({ diag });
  const buffers = createBufferCache({ output, diag });
  const oneShots = createOneShots({ output, buffers, diag });
  const envLoop = createEnvLoop({ output, buffers, diag });
  const tumbleLoop = createTumbleLoop({
    output,
    buffers,
    diag,
    view,
    // How far the player can zoom out: the distance at which the tumble loop
    // is at its dullest and most reverberant.
    getOrbitMaxDistance: () => ctx?.cameraRig?.controls?.maxDistance,
  });

  // Audio must never take the game down with it.
  function safely(tag, fallback, action) {
    try {
      return action();
    } catch (err) {
      diag.log(`audio:${tag}-failed`, String(err?.message ?? err));
      return fallback;
    }
  }

  return {
    unlockFromGesture() {
      safely('unlock', undefined, () => output.unlock());
    },

    // Resolves when every named clip has loaded or failed. Never rejects.
    async preload(names) {
      const list = Array.isArray(names) ? names : [names];
      await Promise.all(list.map((name) => safely('preload', null, () => buffers.load(name))));
    },

    isReady(name) {
      return buffers.get(name) !== null;
    },

    durationMs(name) {
      const buffer = buffers.get(name);
      return buffer ? buffer.duration * 1000 : null;
    },

    playOneShot(name, options = {}) {
      return safely('one-shot', null, () => oneShots.play(name, options ?? {}));
    },

    startEnvLoop(options = {}) {
      safely('env-start', undefined, () => envLoop.start(options ?? {}));
    },
    stopEnvLoop(options = {}) {
      safely('env-stop', undefined, () => envLoop.stop(options ?? {}));
    },

    startTumbleLoop(options = {}) {
      safely('tumble-start', undefined, () => tumbleLoop.start(options ?? {}));
    },
    stopTumbleLoop(options = {}) {
      safely('tumble-stop', undefined, () => tumbleLoop.stop(options ?? {}));
    },

    // fadeMs omitted: every sound uses its own default stop fade.
    stopAll(options = {}) {
      safely('stop-all', undefined, () => oneShots.stopAll(options ?? {}));
      safely('env-stop', undefined, () => envLoop.stop(options ?? {}));
      safely('tumble-stop', undefined, () => tumbleLoop.stop(options ?? {}));
    },

    // Call every frame. sourcePosition may be null: the source then stays put.
    update(now, { camera, sourcePosition, referenceDistance } = {}) {
      if (camera) view.camera = camera;
      if (sourcePosition) {
        view.source.x = sourcePosition.x;
        view.source.y = sourcePosition.y;
        view.source.z = sourcePosition.z;
      }
      if (Number.isFinite(referenceDistance)) view.referenceDistance = referenceDistance;
      safely('update', undefined, () => tumbleLoop.update(now));
    },

    dispose() {
      safely('dispose', undefined, () => oneShots.stopAll({ fadeMs: 0 }));
      safely('dispose', undefined, () => envLoop.stop({ fadeMs: 0 }));
      safely('dispose', undefined, () => tumbleLoop.dispose());
      safely('dispose', undefined, () => output.dispose());
      buffers.clear();
    },
  };
}
