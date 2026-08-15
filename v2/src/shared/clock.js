/**
 * Creates the only clock interface consumed by game timelines and schedulers.
 * Changing timeScale preserves continuity, which lets tests accelerate a running flow.
 */
export function createClock({ read = defaultMonotonicNow, initialTimeScale = 1 } = {}) {
  let sourceAnchorMs = read();
  let timelineAnchorMs = sourceAnchorMs;
  let currentTimeScale = requirePositiveScale(initialTimeScale);

  return {
    now() {
      return timelineAnchorMs + (read() - sourceAnchorMs) * currentTimeScale;
    },

    get timeScale() {
      return currentTimeScale;
    },

    set timeScale(nextTimeScale) {
      const sourceNowMs = read();
      timelineAnchorMs += (sourceNowMs - sourceAnchorMs) * currentTimeScale;
      sourceAnchorMs = sourceNowMs;
      currentTimeScale = requirePositiveScale(nextTimeScale);
    },
  };
}

function defaultMonotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function requirePositiveScale(value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('timeScale must be a positive finite number');
  }
  return value;
}

export const gameClock = createClock();
