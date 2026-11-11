// The one easing curve the flow uses everywhere: smoothstep on 0..1.

export function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

// Out-of-range input clamps, so "a fade that has not started" is simply 0
// and "a fade that is over" is 1.
export function smoothUnit(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

// The t for which smoothUnit(t) === value, by bisection (smoothstep has no
// tidy inverse). 18 halvings is finer than a frame of the 10 s oat fall.
export function inverseSmoothUnit(value) {
  const target = clamp01(value);
  let low = 0;
  let high = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) / 2;
    if (smoothUnit(mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
