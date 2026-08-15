import { CLIP_DEFAULTS, ENV_LOOP, TUMBLE_LOOP } from './clips.js';

const MINIMUM_SEGMENT_SECONDS = 0.001;

/**
 * Plans ambience copies through the current lookahead horizon.
 * The caller owns nextStartSeconds; returning it makes every pump deterministic and stateless.
 * Parity contract: main.js:8945-8971,9266-9321.
 */
export function planEnvSchedule(clock, clipDuration, params = {}) {
  const durationSeconds = requireDuration(clipDuration, 'ambience');
  const nowSeconds = readClockSeconds(clock);
  const crossfadeSeconds = clamp(
    params.crossfadeSeconds ?? ENV_LOOP.crossfadeSeconds,
    0,
    Math.min(CLIP_DEFAULTS.maximumFadeSeconds, durationSeconds - MINIMUM_SEGMENT_SECONDS),
  );
  const intervalSeconds = Math.max(MINIMUM_SEGMENT_SECONDS, durationSeconds - crossfadeSeconds);
  const horizonSeconds = params.untilSeconds ?? nowSeconds + (params.lookaheadSeconds ?? ENV_LOOP.lookaheadSeconds);
  let nextStartSeconds = params.nextStartSeconds ?? nowSeconds + (params.startDelaySeconds ?? ENV_LOOP.startDelaySeconds);
  const sources = [];

  while (nextStartSeconds <= horizonSeconds) {
    const stopSeconds = nextStartSeconds + durationSeconds;
    const fadeStartSeconds = nextStartSeconds + intervalSeconds;
    sources.push({
      startSeconds: nextStartSeconds,
      offsetSeconds: 0,
      playDurationSeconds: durationSeconds,
      stopSeconds,
      nodeStopSeconds: stopSeconds + ENV_LOOP.sourceStopTailSeconds,
      gainAutomation: crossfadeSeconds > 0
        ? [
          { type: 'set', timeSeconds: nextStartSeconds, value: 1 },
          { type: 'set', timeSeconds: fadeStartSeconds, value: 1 },
          { type: 'linear', timeSeconds: stopSeconds, value: 0.0001 },
        ]
        : [{ type: 'set', timeSeconds: nextStartSeconds, value: 1 }],
    });
    nextStartSeconds += intervalSeconds;
  }

  return { nowSeconds, horizonSeconds, intervalSeconds, crossfadeSeconds, nextStartSeconds, sources };
}

/**
 * Plans cropped tumble copies through the current lookahead horizon.
 * Every copy plays the post-crop tail and overlaps its neighbors symmetrically.
 * Parity contract: main.js:9037-9170.
 */
export function planTumbleSchedule(clock, clipDuration, params = {}) {
  const durationSeconds = requireDuration(clipDuration, 'slime tumble');
  const requestedCropStartSeconds = Number(params.cropStartSeconds ?? TUMBLE_LOOP.cropStartSeconds);
  if (!Number.isFinite(requestedCropStartSeconds) || durationSeconds <= requestedCropStartSeconds + MINIMUM_SEGMENT_SECONDS) {
    throw new RangeError('slime tumble clip must contain audio after its crop');
  }
  const cropStartSeconds = clamp(
    requestedCropStartSeconds,
    0,
    Math.max(0, durationSeconds - MINIMUM_SEGMENT_SECONDS),
  );
  const loopDurationSeconds = durationSeconds - cropStartSeconds;
  if (loopDurationSeconds < MINIMUM_SEGMENT_SECONDS) {
    throw new RangeError('slime tumble clip must contain audio after its crop');
  }

  const nowSeconds = readClockSeconds(clock);
  const crossfadeSeconds = clamp(
    params.crossfadeSeconds ?? TUMBLE_LOOP.crossfadeSeconds,
    0,
    Math.min(CLIP_DEFAULTS.maximumFadeSeconds, loopDurationSeconds * 0.5),
  );
  const intervalSeconds = Math.max(MINIMUM_SEGMENT_SECONDS, loopDurationSeconds - crossfadeSeconds);
  const horizonSeconds = params.untilSeconds ?? nowSeconds + (params.lookaheadSeconds ?? TUMBLE_LOOP.lookaheadSeconds);
  let nextStartSeconds = params.nextStartSeconds ?? nowSeconds + (params.startDelaySeconds ?? TUMBLE_LOOP.startDelaySeconds);
  const sources = [];

  while (nextStartSeconds <= horizonSeconds) {
    const stopSeconds = nextStartSeconds + loopDurationSeconds;
    sources.push({
      startSeconds: nextStartSeconds,
      offsetSeconds: cropStartSeconds,
      playDurationSeconds: loopDurationSeconds,
      stopSeconds,
      nodeStopSeconds: stopSeconds + TUMBLE_LOOP.sourceStopTailSeconds,
      gainAutomation: crossfadeSeconds > 0
        ? [
          { type: 'set', timeSeconds: nextStartSeconds, value: 0.0001 },
          { type: 'linear', timeSeconds: nextStartSeconds + crossfadeSeconds, value: 1 },
          { type: 'set', timeSeconds: stopSeconds - crossfadeSeconds, value: 1 },
          { type: 'linear', timeSeconds: stopSeconds, value: 0.0001 },
        ]
        : [{ type: 'set', timeSeconds: nextStartSeconds, value: 1 }],
    });
    nextStartSeconds += intervalSeconds;
  }

  return {
    nowSeconds,
    horizonSeconds,
    cropStartSeconds,
    loopDurationSeconds,
    intervalSeconds,
    crossfadeSeconds,
    nextStartSeconds,
    sources,
  };
}

function readClockSeconds(clock) {
  if (typeof clock?.now !== 'function') throw new TypeError('scheduler clock must expose now()');
  const nowMilliseconds = Number(clock.now());
  if (!Number.isFinite(nowMilliseconds)) throw new RangeError('scheduler clock returned a non-finite time');
  return nowMilliseconds / 1000;
}

function requireDuration(value, label) {
  const durationSeconds = Number(value);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError(`${label} clip duration must be positive and finite`);
  }
  return durationSeconds;
}

function clamp(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}
