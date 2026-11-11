// Converts between the game's clock (performance.now() milliseconds) and the
// AudioContext's clock (seconds since the context started).
//
// The two clocks drift and the audio one runs ahead of what is audible by the
// output latency. getOutputTimestamp() gives one instant expressed on both
// clocks, which is what makes "start this sound exactly at frame time T"
// possible. Where it is missing or not meaningful we fall back to "now on both
// clocks", which is accurate to a few milliseconds.

function readOutputTimestamp(context) {
  if (typeof context.getOutputTimestamp !== 'function') return null;
  // While the context is not running the timestamp is zero or stale, and using
  // it would push the start time far into the future.
  if (context.state !== 'running') return null;
  const stamp = context.getOutputTimestamp();
  if (!stamp) return null;
  if (!Number.isFinite(stamp.contextTime) || !Number.isFinite(stamp.performanceTime)) return null;
  if (stamp.performanceTime <= 0) return null;
  return stamp;
}

// -> context time in seconds, never earlier than "now" on the audio clock.
export function performanceMsToContextSec(context, atMs) {
  if (!Number.isFinite(atMs)) return context.currentTime;
  const stamp = readOutputTimestamp(context);
  const contextSec = stamp
    ? stamp.contextTime + (atMs - stamp.performanceTime) / 1000
    : context.currentTime + (atMs - performance.now()) / 1000;
  return Math.max(context.currentTime, contextSec);
}

// -> performance.now()-domain milliseconds at which `contextSec` is heard.
export function contextSecToPerformanceMs(context, contextSec) {
  const stamp = readOutputTimestamp(context);
  if (stamp) return stamp.performanceTime + (contextSec - stamp.contextTime) * 1000;
  return performance.now() + (contextSec - context.currentTime) * 1000;
}
