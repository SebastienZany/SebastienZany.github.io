// The ambience bed that plays for the whole game once the intro is over.
//
//   copies (loop scheduler) -> env gain (clip volume) -> master
//
// It is not spatial: it is the room, not a thing in the room.

import { CLIPS, ENV_LOOP, ONE_SHOT, SILENT_GAIN } from './audio.config.js';
import { performanceMsToContextSec } from './clock.js';
import { createLoopScheduler } from './loop-scheduler.js';
import { fadeMsToSec } from './param-ramps.js';

export function createEnvLoop({ output, buffers, diag }) {
  const volume = CLIPS[ENV_LOOP.clip].gain ?? 1;
  let envGain = null;
  let scheduler = null;
  // Bumped by every start and stop, so a start that was waiting for the file
  // to decode can tell that it has been superseded.
  let requestId = 0;
  let wanted = false;

  function begin(buffer, atMs) {
    const { context, master } = output.ensure();
    const durationSec = buffer.duration;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      wanted = false;
      diag.log('audio:env-invalid', `duration ${durationSec}`);
      return;
    }
    if (!envGain) {
      envGain = context.createGain();
      envGain.connect(master);
    }
    if (!scheduler) {
      const crossfadeSec = Math.min(
        ENV_LOOP.crossfadeSec, ONE_SHOT.maxFadeSec, Math.max(0, durationSec - 0.001));
      scheduler = createLoopScheduler({
        context,
        destination: envGain,
        buffer,
        copyDurationSec: durationSec,
        crossfadeSec,
        // Each new copy enters at full level while the previous one fades out
        // beneath it; the file's own soft start does the fading in.
        fadeInCopies: false,
        lookaheadSec: ENV_LOOP.lookaheadSec,
        pumpMs: ENV_LOOP.pumpMs,
      });
    }

    const nowSec = context.currentTime;
    envGain.gain.cancelScheduledValues(nowSec);
    if (ENV_LOOP.fadeInSec > 0) {
      envGain.gain.setValueAtTime(SILENT_GAIN, nowSec);
      envGain.gain.linearRampToValueAtTime(volume, nowSec + ENV_LOOP.fadeInSec);
    } else {
      envGain.gain.setValueAtTime(volume, nowSec);
    }
    const startSec = Number.isFinite(atMs)
      ? performanceMsToContextSec(context, atMs)
      : nowSec + ENV_LOOP.startDelaySec;
    scheduler.start(startSec);
  }

  function start({ atMs } = {}) {
    if (wanted) return; // already running, or already on its way
    if (!output.ensure()) return;
    wanted = true;
    const myRequest = ++requestId;
    const ready = buffers.get(ENV_LOOP.clip);
    if (ready) {
      begin(ready, atMs);
      return;
    }
    // The file is large; if it is still decoding, start as soon as it lands.
    buffers.load(ENV_LOOP.clip).then((buffer) => {
      if (myRequest !== requestId) return;
      if (!buffer) {
        wanted = false;
        return;
      }
      begin(buffer, atMs);
    }).catch((err) => {
      wanted = false;
      diag.log('audio:env-start-failed', String(err?.message ?? err));
    });
  }

  function stop({ fadeMs } = {}) {
    wanted = false;
    requestId += 1;
    scheduler?.stop({
      fadeSec: fadeMsToSec(fadeMs, ENV_LOOP.stopFadeSec),
      tailSec: ONE_SHOT.stopTailSec,
      fadeCopies: true,
    });
  }

  return { start, stop, isRunning: () => Boolean(scheduler?.isRunning()) };
}
