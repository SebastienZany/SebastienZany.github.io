// The slime's continuous "tumble" texture. It fades in while the colony is
// being seeded and then plays until the game ends, placed in space at the
// position the game supplies (see spatial-chain.js).
//
// The file opens with a one-off attack, so only what follows `cropStartSec`
// is looped.

import { CLIPS, ONE_SHOT, SILENT_GAIN, TUMBLE_LOOP } from './audio.config.js';
import { performanceMsToContextSec } from './clock.js';
import { createLoopScheduler } from './loop-scheduler.js';
import { fadeMsToSec, fadeToSilence } from './param-ramps.js';
import { createSpatialChain } from './spatial-chain.js';

export function createTumbleLoop({ output, buffers, diag, view, getOrbitMaxDistance }) {
  let chain = null;
  let scheduler = null;
  let requestId = 0;   // see env-loop.js: lets a stop cancel a start that is still loading
  let wanted = false;

  function begin(buffer, atMs, fadeInMs) {
    const { context, master } = output.ensure();
    const durationSec = buffer.duration;
    if (!Number.isFinite(durationSec) || durationSec <= TUMBLE_LOOP.cropStartSec + 0.001) {
      wanted = false;
      diag.log('audio:tumble-invalid', `duration ${durationSec} is shorter than the crop`);
      return;
    }
    if (!chain) {
      chain = createSpatialChain({
        context,
        master,
        volume: CLIPS[TUMBLE_LOOP.clip].gain ?? 1,
        getOrbitMaxDistance,
      });
    }
    if (!scheduler) {
      const loopDurationSec = durationSec - TUMBLE_LOOP.cropStartSec;
      scheduler = createLoopScheduler({
        context,
        destination: chain.input,
        buffer,
        offsetSec: TUMBLE_LOOP.cropStartSec,
        copyDurationSec: loopDurationSec,
        // Never more than half the loop, or a copy's fade-in and fade-out would overlap.
        crossfadeSec: Math.min(TUMBLE_LOOP.crossfadeSec, ONE_SHOT.maxFadeSec, loopDurationSec * 0.5),
        fadeInCopies: true,
        lookaheadSec: TUMBLE_LOOP.lookaheadSec,
        pumpMs: TUMBLE_LOOP.pumpMs,
        stopTailSec: TUMBLE_LOOP.sourceStopTailSec,
      });
    }
    // Snap (no glide) to where the camera and source are right now, so the
    // first second does not sweep in from the previous game's position.
    chain.syncNow(view, { smooth: false });

    const nowSec = context.currentTime;
    const startSec = Number.isFinite(atMs)
      ? performanceMsToContextSec(context, atMs)
      : nowSec + TUMBLE_LOOP.startDelaySec;
    const fadeInSec = fadeMsToSec(fadeInMs, TUMBLE_LOOP.defaultFadeInMs / 1000);
    const fade = chain.fadeGain.gain;
    fade.cancelScheduledValues(nowSec);
    fade.setValueAtTime(SILENT_GAIN, startSec);
    if (fadeInSec > 0) fade.linearRampToValueAtTime(1, startSec + fadeInSec);
    else fade.setValueAtTime(1, startSec);

    scheduler.start(startSec);
  }

  function start({ atMs, fadeInMs } = {}) {
    if (wanted) {
      // Already playing (or loading): just make sure it is where it should be.
      if (scheduler?.isRunning()) chain.syncNow(view, { smooth: true });
      return;
    }
    if (!output.ensure()) return;
    wanted = true;
    const myRequest = ++requestId;
    const ready = buffers.get(TUMBLE_LOOP.clip);
    if (ready) {
      begin(ready, atMs, fadeInMs);
      return;
    }
    buffers.load(TUMBLE_LOOP.clip).then((buffer) => {
      if (myRequest !== requestId) return;
      if (!buffer) {
        wanted = false;
        return;
      }
      begin(buffer, atMs, fadeInMs);
    }).catch((err) => {
      wanted = false;
      diag.log('audio:tumble-start-failed', String(err?.message ?? err));
    });
  }

  function stop({ fadeMs } = {}) {
    wanted = false;
    requestId += 1;
    if (!chain || !scheduler) return;
    const graph = output.ensure();
    if (!graph) return;
    const fadeSec = fadeMsToSec(fadeMs, TUMBLE_LOOP.stopFadeSec);
    // All copies share the chain's fade gain, so one fade silences them all.
    fadeToSilence(graph.context, chain.fadeGain.gain, fadeSec);
    scheduler.stop({ fadeSec, tailSec: ONE_SHOT.stopTailSec, fadeCopies: false });
  }

  // Per-frame: keep the listener on the camera and the source on its anchor.
  // Nothing to do until the loop has been started once.
  function update(now) {
    chain?.update(now, view);
  }

  function dispose() {
    stop({ fadeMs: 0 });
    chain?.dispose();
    chain = null;
    scheduler = null;
  }

  return { start, stop, update, dispose, isRunning: () => Boolean(scheduler?.isRunning()) };
}
