import { AUDIO_RAMP } from './clips.js';

/** WebAudio setTargetAtTime's ideal exponential trajectory. */
export function targetRampValue(initialValue, targetValue, elapsedSeconds, timeConstantSeconds = AUDIO_RAMP.targetTimeConstantSeconds) {
  const elapsed = Math.max(0, Number(elapsedSeconds) || 0);
  const timeConstant = Number(timeConstantSeconds);
  if (!Number.isFinite(timeConstant) || timeConstant <= 0) return targetValue;
  return targetValue + (initialValue - targetValue) * Math.exp(-elapsed / timeConstant);
}

/**
 * Applies the shared 35 ms parameter ramp used for volume and compressor changes.
 * Parity contract: main.js:8428-8480,8719-8734.
 */
export function rampAudioParam(audioParam, value, context, { smooth = true } = {}) {
  if (!audioParam || !context) return;
  const nowSeconds = context.currentTime;
  audioParam.cancelScheduledValues(nowSeconds);
  if (smooth) {
    audioParam.setValueAtTime(audioParam.value, nowSeconds);
    audioParam.setTargetAtTime(value, nowSeconds, AUDIO_RAMP.targetTimeConstantSeconds);
  } else {
    audioParam.setValueAtTime(value, nowSeconds);
  }
}

export function applyGainAutomation(audioParam, events) {
  for (const event of events) {
    if (event.type === 'linear') {
      audioParam.linearRampToValueAtTime(event.value, event.timeSeconds);
    } else {
      audioParam.setValueAtTime(event.value, event.timeSeconds);
    }
  }
}

export function clampFinite(value, minimum, maximum, fallback = minimum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}
