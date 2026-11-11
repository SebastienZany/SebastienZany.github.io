// Game flow: start screen -> intro -> play -> ending -> back to the start screen.
//
// This file only wires the parts together and owns the restart:
//   start-screen.js   the black title screen and its Begin button
//   intro.js          the timeline from the Begin click to the seeded colony
//   ending.js         the time-limit and idle endings
// See NOTES.md for what was carried over from the old game and how.

import { flowConfig } from './flow.config.js';
import { createStartScreen } from './start-screen.js';
import { createIntro } from './intro.js';
import { createEnding } from './ending.js';

export { flowConfig, paramSchema, defaultParams } from './flow.config.js';

// hooks = { getInitialOat() -> oat, seedColony(now, { durationMs }), resetWorld(now) }
export function createFlow(ctx, hooks) {
  const config = flowConfig;
  const view = ctx.dom.app.ownerDocument.defaultView;
  // When the colony seeded by the intro finishes growing in; 0 = not growing.
  let colonyGrownAtMs = 0;

  let intro = null;
  const startScreen = createStartScreen(ctx, config, {
    getIntro: () => intro.state,
    onBegin: (now) => intro.begin(now),
  });
  intro = createIntro(ctx, hooks, config, {
    startScreen,
    onColonySeeded: (now, grownAtMs) => {
      ending.cancel(); // a fresh colony never inherits an ending in progress
      colonyGrownAtMs = grownAtMs;
    },
  });
  const ending = createEnding(ctx, config, {
    getBeginClickedAtMs: () => startScreen.clickedAtMs,
    onComplete: restart,
  });

  // The ending has run its course: wipe the world, quiet the loops, and put
  // the start screen back with Begin ready to press. (The ending has already
  // cancelled itself and stopped its own sound.)
  function restart(now) {
    hooks.resetWorld(now);
    ctx.audio.stopEnvLoop({ fadeMs: config.ending.envLoopStopFadeMs });
    ctx.audio.stopTumbleLoop({ fadeMs: config.ending.tumbleLoopStopFadeMs });
    colonyGrownAtMs = 0;
    intro.reset();
    startScreen.returnToBegin(now);
    ctx.diag.log('flow', 'ending complete: back to start screen');
  }

  function update(now) {
    startScreen.update(now);
    intro.update(now);
    if (colonyGrownAtMs > 0 && now >= colonyGrownAtMs) {
      colonyGrownAtMs = 0;
      ending.colonyGrown(now);
    }
    ending.update(now, intro.state.completed && colonyGrownAtMs === 0);
  }

  function skipIntro(now) {
    if (!startScreen.ready || intro.state.completed) return false;
    // S on the start screen is the first gesture of the session: without
    // this the skipped-to game would stay silent.
    ctx.audio.unlockFromGesture();
    return intro.skip(now);
  }

  return {
    get phase() {
      if (!startScreen.ready) return 'loading'; // also the fatal-error state
      if (intro.state.completed) return ending.closing ? 'ending' : 'playing';
      return intro.state.requested ? 'intro' : 'ready';
    },

    setReady(now) {
      startScreen.setReady(now);
      ctx.diag.log('flow', 'start screen ready');
      if (ctx.flags.dev) {
        // ?dev: no start screen, no intro; straight to a seeded colony.
        // (No gesture has happened, so audio is not unlocked here.)
        startScreen.hide();
        intro.skip(now);
      }
    },

    fail(message) {
      ctx.diag.log('flow', `fatal: ${message}`);
      startScreen.fail(message, view.performance.now());
    },

    update,
    skipIntro,
    introSpritePosition: () => intro.oatPosition(),

    // The contract's switch is the time-limit ending (off by default).
    setEndingEnabled(on) { ending.setTimeLimitEnabled(on); },

    // --- beyond the contract (see NOTES.md) ---
    setIdleEndingEnabled(on) { ending.setIdleEnabled(on); },
    // Count something as player activity that is not a pointer/wheel/key event.
    noteActivity(now) { ending.noteActivity(now); },
    // The game re-seeded the colony itself (dev panel "Reset").
    colonyReseeded(now, grownAtMs) {
      ending.cancel();
      colonyGrownAtMs = Math.max(grownAtMs, now);
    },
    // Read-only snapshot for dev hooks and tests.
    debugState: () => ({
      intro: { ...intro.state },
      ending: { ...ending.state },
      beginClickedAtMs: startScreen.clickedAtMs,
      colonyGrownAtMs,
    }),

    dispose() {
      ending.dispose();
      intro.dispose();
      startScreen.dispose();
    },
  };
}
