/** Sample-accurate mapping around getOutputTimestamp, with an injected-clock fallback. */
export function performanceMillisecondsToContextTime(context, clock, performanceMilliseconds) {
  const targetMilliseconds = Number(performanceMilliseconds);
  if (!Number.isFinite(targetMilliseconds)) return context.currentTime;
  const timestamp = validOutputTimestamp(context);
  const mappedSeconds = timestamp
    ? timestamp.contextTime + (targetMilliseconds - timestamp.performanceTime) / 1000
    : context.currentTime + (targetMilliseconds - Number(clock.now())) / 1000;
  return Math.max(context.currentTime, mappedSeconds);
}

export function contextTimeToPerformanceMilliseconds(context, clock, contextTimeSeconds) {
  const targetSeconds = Number(contextTimeSeconds);
  if (!Number.isFinite(targetSeconds)) return Number(clock.now());
  const timestamp = validOutputTimestamp(context);
  return timestamp
    ? timestamp.performanceTime + (targetSeconds - timestamp.contextTime) * 1000
    : Number(clock.now()) + (targetSeconds - context.currentTime) * 1000;
}

function validOutputTimestamp(context) {
  if (typeof context?.getOutputTimestamp !== 'function') return null;
  const timestamp = context.getOutputTimestamp();
  return Number.isFinite(timestamp?.contextTime) && Number.isFinite(timestamp?.performanceTime)
    ? timestamp
    : null;
}
