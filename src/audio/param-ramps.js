// Small helpers for moving AudioParams without clicks, and for tearing nodes down.

import { MASTER, SILENT_GAIN } from './audio.config.js';

// Glide a gain / frequency towards `value`. Pinning the current value first
// makes the glide start from where the param really is, not from the end point
// of whatever automation was cancelled.
export function glideParam(context, param, value, { smooth = true } = {}) {
  if (!param) return;
  const nowSec = context.currentTime;
  param.cancelScheduledValues(nowSec);
  if (smooth) {
    param.setValueAtTime(param.value, nowSec);
    param.setTargetAtTime(value, nowSec, MASTER.paramSmoothingSec);
  } else {
    param.setValueAtTime(value, nowSec);
  }
}

// Linear fade to silence starting now. fadeSec 0 cuts immediately.
export function fadeToSilence(context, param, fadeSec) {
  const nowSec = context.currentTime;
  param.cancelScheduledValues(nowSec);
  if (fadeSec > 0) {
    param.setValueAtTime(param.value, nowSec);
    param.linearRampToValueAtTime(SILENT_GAIN, nowSec + fadeSec);
  } else {
    param.setValueAtTime(SILENT_GAIN, nowSec);
  }
}

// disconnect() throws when a node has no connections; that is harmless here.
export function disconnectQuietly(node) {
  try {
    node?.disconnect?.();
  } catch {
    // already disconnected
  }
}

// API fades arrive in milliseconds and may be missing or nonsense.
export function fadeMsToSec(fadeMs, fallbackSec) {
  if (!Number.isFinite(fadeMs)) return fallbackSec;
  return Math.max(0, fadeMs / 1000);
}
