// The ending: the camouflage sound plays, the scene fades to black, and the
// game returns to the start screen. Two things can set it off:
//
//   'time-limit'  (off by default) a fixed time after the Begin click. Armed
//                 as soon as the colony has grown in; counts down in the
//                 corners; the sound is placed so that it ENDS on the deadline.
//   'idle'        (on by default) nobody has touched anything for two
//                 minutes. The sound starts at once; any input calls it off.
//
// Phases: 'preparing' (waiting for the sound to be decoded) -> 'gameplay'
// (time-limit only: scheduled, still playing normally) -> 'camouflage' (sound
// running, black fade begins 7 s in) -> done. If the sound cannot play, phase
// 'fade' does a plain 3 s fade instead.

import { smoothUnit } from './easing.js';
import { createEndingOverlay } from './ending-overlay.js';

// `getBeginClickedAtMs()` -> when Begin took effect (0 if unknown).
// `onComplete(now)` -> the flow restarts the game.
export function createEnding(ctx, config, { getBeginClickedAtMs, onComplete }) {
  const audio = ctx.audio;
  const timing = config.ending;
  const clip = config.sounds.camouflage;
  const overlay = createEndingOverlay(ctx);
  const view = ctx.dom.app.ownerDocument.defaultView;

  const enabled = { 'time-limit': false, idle: true };
  const state = {
    active: false,
    phase: 'none',           // 'none' | 'preparing' | 'gameplay' | 'camouflage' | 'fade'
    trigger: 'none',         // 'none' | 'time-limit' | 'idle'
    armedAtMs: 0,
    camouflageStartAtMs: 0,
    fadeStartAtMs: 0,
    endAtMs: 0,              // when the game returns to the start screen; 0 = not known yet
    targetReturnAtMs: 0,
  };
  const idle = { tracking: false, lastActivityAtMs: 0 };
  let camouflageSound = null;   // one-shot handle
  let clipLoad = null;          // { settled } while waiting for the clip to decode
  let armFromNowRequested = false;

  const onActivity = () => noteActivity(view.performance.now());
  const listenerOptions = { capture: true, passive: true };
  for (const type of timing.activityEvents) view.addEventListener(type, onActivity, listenerOptions);

  const isEnabled = (trigger) => enabled[trigger] === true;

  function cancel() {
    state.active = false;
    state.phase = 'none';
    state.trigger = 'none';
    state.armedAtMs = 0;
    state.camouflageStartAtMs = 0;
    state.fadeStartAtMs = 0;
    state.endAtMs = 0;
    state.targetReturnAtMs = 0;
    clipLoad = null;
    overlay.setFadeOpacity(0);
    overlay.setCountdownVisible(false);
    camouflageSound?.stop({ fadeMs: timing.soundStopFadeMs });
    camouflageSound = null;
  }

  function arm(now, trigger, { fromNow = false } = {}) {
    if (!isEnabled(trigger)) return false;
    if (state.active && state.trigger === trigger) return true;
    if (state.active) cancel();
    state.active = true;
    state.phase = 'preparing';
    state.trigger = trigger;
    state.armedAtMs = now;
    if (trigger === 'time-limit') {
      // Measured from the Begin click, unless the limit was switched on
      // mid-game ("fromNow") or the click time is unknown.
      const clickedAtMs = getBeginClickedAtMs();
      const from = !fromNow && clickedAtMs > 0 ? clickedAtMs : now;
      state.targetReturnAtMs = from + timing.timeLimitMs;
    }
    state.endAtMs = state.targetReturnAtMs;
    overlay.setFadeOpacity(0);
    overlay.setCountdownVisible(trigger === 'time-limit');
    prepare(now);
    return true;
  }

  // Work out the schedule once the clip's length is known.
  function prepare(now) {
    if (!audio.isReady(clip)) {
      if (!clipLoad) {
        const load = { settled: false };
        clipLoad = load;
        const settle = () => { load.settled = true; };
        audio.preload([clip]).then(settle, settle);
      } else if (clipLoad.settled) {
        useFallbackFade(now); // loading finished and it still is not there
      }
      return;
    }
    const durationMs = audio.durationMs(clip);
    if (!(durationMs > 0)) {
      useFallbackFade(now);
      return;
    }
    const fadeDelayMs = Math.min(timing.camouflageFadeDelayMs, Math.max(0, durationMs - 1));
    if (state.trigger === 'idle') {
      state.camouflageStartAtMs = now;
      state.endAtMs = now + durationMs;
    } else {
      state.camouflageStartAtMs = state.targetReturnAtMs - durationMs;
      state.endAtMs = state.targetReturnAtMs;
    }
    state.fadeStartAtMs = state.camouflageStartAtMs + fadeDelayMs;
    state.targetReturnAtMs = state.endAtMs;
    if (now >= state.camouflageStartAtMs) startCamouflage(now);
    else state.phase = 'gameplay';
  }

  function startCamouflage(now) {
    camouflageSound?.stop({ fadeMs: timing.soundStopFadeMs });
    camouflageSound = audio.playOneShot(clip, { atMs: state.camouflageStartAtMs });
    if (camouflageSound) state.phase = 'camouflage';
    else useFallbackFade(now);
  }

  // No sound: fade over the last 3 s before the deadline, or over the next
  // 3 s if there is no usable deadline.
  function useFallbackFade(now) {
    const target = state.targetReturnAtMs > now ? state.targetReturnAtMs : now + timing.fallbackFadeMs;
    state.phase = 'fade';
    state.camouflageStartAtMs = now;
    state.fadeStartAtMs = Math.max(now, target - timing.fallbackFadeMs);
    state.endAtMs = target;
    state.targetReturnAtMs = target;
  }

  function complete(now) {
    cancel();
    onComplete(now);
  }

  // Any input: restart the idle clock, and call off an idle ending under way.
  function noteActivity(now) {
    idle.lastActivityAtMs = now;
    if (state.active && state.trigger === 'idle') cancel();
  }

  // The idle clock only runs during real play: not on the start screen, not
  // during the intro or while the colony grows in, and not alongside the
  // time limit.
  function updateIdle(now, gameplayReady) {
    if (!enabled.idle || enabled['time-limit'] || !gameplayReady) {
      idle.tracking = false;
      return;
    }
    if (!idle.tracking) {
      idle.tracking = true;
      idle.lastActivityAtMs = now;
      return;
    }
    if (state.active) return;
    if (now - idle.lastActivityAtMs >= timing.idleTimeoutMs) arm(now, 'idle');
  }

  // `gameplayReady`: the intro is over and the colony has finished growing in.
  function update(now, gameplayReady) {
    if (armFromNowRequested) {
      armFromNowRequested = false;
      if (gameplayReady) arm(now, 'time-limit', { fromNow: true });
    }
    updateIdle(now, gameplayReady);

    if (!state.active) return;
    if (!isEnabled(state.trigger)) {
      cancel();
      return;
    }
    if (state.phase === 'preparing') prepare(now);

    if (state.endAtMs > 0 && now >= state.endAtMs) {
      complete(now);
      return;
    }
    if (state.phase === 'gameplay' && now >= state.camouflageStartAtMs) startCamouflage(now);

    const closing = state.phase === 'camouflage' || state.phase === 'fade';
    if (closing) {
      const fadeMs = Math.max(1, state.endAtMs - state.fadeStartAtMs);
      overlay.setFadeOpacity(now >= state.fadeStartAtMs ? smoothUnit((now - state.fadeStartAtMs) / fadeMs) : 0);
    }

    const showCountdown = state.trigger === 'time-limit';
    overlay.setCountdownVisible(showCountdown);
    if (showCountdown) {
      // Counts down to the camouflage sound first, then to the end itself.
      const countdownTo = closing ? state.endAtMs : (state.camouflageStartAtMs || state.endAtMs);
      overlay.setCountdownMs(countdownTo - now);
    }
  }

  return {
    state,
    // True once the player can see/hear the game ending.
    get closing() { return state.active && (state.phase === 'camouflage' || state.phase === 'fade'); },
    update,
    cancel,
    noteActivity,

    // The colony has just finished growing in: play proper starts here.
    colonyGrown(now) {
      idle.tracking = false;
      arm(now, 'time-limit');
    },

    setTimeLimitEnabled(on) {
      enabled['time-limit'] = Boolean(on);
      armFromNowRequested = false;
      if (!on) {
        if (state.trigger === 'time-limit') cancel();
        idle.tracking = false;
        return;
      }
      if (state.trigger === 'idle') cancel();
      // Switched on mid-game: the two minutes run from the next frame.
      if (!state.active) armFromNowRequested = true;
    },

    setIdleEnabled(on) {
      enabled.idle = Boolean(on);
      idle.tracking = false;
      if (!on && state.trigger === 'idle') cancel();
    },

    dispose() {
      cancel();
      for (const type of timing.activityEvents) view.removeEventListener(type, onActivity, listenerOptions);
      overlay.dispose();
    },
  };
}
