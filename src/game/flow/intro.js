// The intro timeline, from the Begin click to the colony being seeded.
//
// With C = the moment the intro sound starts ("content start"):
//
//   click        slime-fuse plays inside the gesture (this also unlocks audio)
//   commit       = click, or later if intro.wav was not decoded yet
//   commit+826   Begin and title start fading out (the click sound's peak)
//   C = +2826    intro.wav; the intro line fades in      (1 s fade + 1 s silence)
//   C+4500       the black screen starts to clear; input reaches the canvas
//   C+5500       screen clear; ambience loop starts; the oat's lower edge
//                crosses the top of the screen
//   S = C+5500 - lead   the oat sprite starts falling (lead is back-solved so
//                the crossing above lands on C+5500)
//   S+6800       oat lands and starts to brighten
//   S+9000       slime-appear-stretch; oat starts to fade
//   S+10000      oat gone; colony seeded (grows in over 3460 ms)

import { introOatStart, introOatTarget, introOatTopEdgeLeadMs } from './intro-oat-path.js';
import { createIntroOatSprites } from './intro-oat-sprite.js';

// `startScreen` is the createStartScreen instance. `onColonySeeded(now, grownAtMs)`
// tells the flow when the colony will have finished growing in.
export function createIntro(ctx, hooks, config, { startScreen, onColonySeeded }) {
  const audio = ctx.audio;
  const timing = config.intro;
  const sounds = config.sounds;
  const oatSprites = createIntroOatSprites(ctx, config.introOat);

  const state = {
    requested: false,      // Begin was pressed (or the intro skipped)
    active: false,         // the oat is falling
    completed: false,      // the colony has been seeded
    requestedAtMs: 0,      // when the start screen begins to let go; 0 = not committed
    fallStartedAtMs: 0,
    topEdgeLeadMs: 0,
    seedSoundPlayed: false,
    envLoopStarted: false,
  };
  let fallingOat = null;        // the sprite handle while state.active
  let introSound = null;        // one-shot handle, so a skip can cut it
  let introSoundOwed = false;   // intro.wav could not start at commit; start it when decoded
  let decodeWait = null;        // { deadlineMs, settled } while holding for intro.wav

  // When intro.wav starts and the intro line appears.
  function contentStartAtMs() {
    return state.requestedAtMs > 0
      ? state.requestedAtMs + config.startScreen.uiFadeMs + timing.silentBeatMs
      : 0;
  }

  // The Begin click. Must run synchronously inside the click handler.
  function begin(now) {
    if (state.requested || state.completed) return;
    // Claim the intro at once so a second click cannot re-enter while we wait.
    state.requested = true;
    state.seedSoundPlayed = false;
    state.envLoopStarted = false;
    startScreen.disableButton();

    audio.unlockFromGesture();
    audio.playOneShot(sounds.click);

    if (audio.isReady(sounds.intro)) {
      commit(now);
      return;
    }
    // Hold the whole timeline until the music is decoded: started late, it
    // would trail the visuals for the entire intro. The start screen simply
    // stays put a beat longer. Bounded, so a stalled download cannot hang it.
    const wait = { deadlineMs: now + timing.introSoundWaitMaxMs, settled: false };
    decodeWait = wait;
    const settle = () => { wait.settled = true; };
    audio.preload([sounds.intro]).then(settle, settle);
  }

  // Fix the timeline's zero. Everything after this is scheduled from `now`.
  function commit(now) {
    const fadeOutAtMs = now + timing.clickSoundPeakMs;
    state.requestedAtMs = fadeOutAtMs;
    startScreen.markBeginPressed(now, fadeOutAtMs);
    introSound = audio.playOneShot(sounds.intro, { atMs: contentStartAtMs() });
    introSoundOwed = !introSound;
    audio.preload(sounds.preloadAfterBegin).catch(() => {});
  }

  function update(now) {
    if (decodeWait) {
      const done = audio.isReady(sounds.intro) || decodeWait.settled || now >= decodeWait.deadlineMs;
      if (!done) return;
      decodeWait = null;
      commit(now);
    }
    if (!state.requested || state.completed || state.requestedAtMs <= 0) return;

    if (introSoundOwed && audio.isReady(sounds.intro)) {
      // Late after all (the wait timed out): better late than silent.
      introSound = audio.playOneShot(sounds.intro, { atMs: contentStartAtMs() });
      introSoundOwed = false;
    }

    const contentStart = contentStartAtMs();
    const topEdgeAtMs = contentStart + timing.oatTopEdgeDelayMs;
    if (now >= topEdgeAtMs - config.startScreen.uiFadeMs) startScreen.setRunning();
    if (!state.envLoopStarted && now >= topEdgeAtMs) {
      state.envLoopStarted = true;
      audio.startEnvLoop();
    }

    if (!state.active) startFallIfDue(now);
    if (!state.active) return;

    const fallMs = config.introOat.fallMs;
    const elapsedMs = now - state.fallStartedAtMs;
    const progress = Math.max(0, Math.min(1, elapsedMs / fallMs));
    fallingOat.setProgress(progress);
    if (!state.seedSoundPlayed && elapsedMs >= fallMs - config.seed.soundLeadMs) {
      audio.playOneShot(sounds.seed);
      state.seedSoundPlayed = true;
    }
    if (progress >= 1) finish(now);
  }

  // The fall's start depends on the camera (how far the oat has to travel
  // before it is on screen), so it is re-solved each frame until it is due.
  function startFallIfDue(now) {
    if (!startScreen.ready) return;
    const target = introOatTarget(hooks.getInitialOat(), config.introOat);
    if (!target) return;
    const start = introOatStart(target, ctx.camera, config.introOat);
    const leadMs = introOatTopEdgeLeadMs(start, target, ctx.camera, config.introOat);
    const fallStartAtMs = contentStartAtMs() + Math.max(0, timing.oatTopEdgeDelayMs - leadMs);
    if (now < fallStartAtMs) return;

    startScreen.setRunning();
    state.active = true;
    state.fallStartedAtMs = fallStartAtMs;
    state.topEdgeLeadMs = leadMs;
    state.seedSoundPlayed = false;
    fallingOat = oatSprites.spawn(start, target);
  }

  function removeOat() {
    fallingOat?.remove();
    fallingOat = null;
  }

  function finish(now) {
    removeOat();
    state.active = false;
    state.completed = true;
    startScreen.setComplete();
    if (!state.seedSoundPlayed) audio.playOneShot(sounds.seed);
    const durationMs = config.seed.durationMs;
    hooks.seedColony(now, { durationMs });
    onColonySeeded(now, now + durationMs);
  }

  // Jump straight to the seeded colony, from the start screen or mid-intro.
  function skip(now) {
    if (!startScreen.ready || state.completed) return false;
    startScreen.markSkipped(now);
    const committed = state.requested && state.requestedAtMs > 0 && state.requestedAtMs <= now;
    if (!committed) {
      state.requested = true;
      state.requestedAtMs = now;
      state.seedSoundPlayed = false;
    }
    decodeWait = null;
    introSoundOwed = false;
    startScreen.update(now);

    introSound?.stop({ fadeMs: timing.introSoundSkipFadeMs });
    introSound = null;
    if (!state.envLoopStarted) audio.startEnvLoop();
    state.envLoopStarted = true;
    finish(now);
    return true;
  }

  // Back to "Begin not yet pressed" (after an ending).
  function reset() {
    removeOat();
    state.requested = false;
    state.active = false;
    state.completed = false;
    state.requestedAtMs = 0;
    state.fallStartedAtMs = 0;
    state.topEdgeLeadMs = 0;
    state.seedSoundPlayed = false;
    state.envLoopStarted = false;
    decodeWait = null;
    introSound = null;
    introSoundOwed = false;
  }

  return {
    state,
    begin,
    skip,
    reset,
    update,
    oatPosition: () => fallingOat?.position ?? null,
    dispose() {
      removeOat();
      oatSprites.dispose();
    },
  };
}
