// The ending's two DOM pieces: a black sheet that fades in over the scene,
// and a pair of faint countdown clocks in the bottom corners.

import { clamp01 } from './easing.js';

export function createEndingOverlay(ctx) {
  const app = ctx.dom.app;
  const document = app.ownerDocument;

  function make(className, text = '') {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = text;
    return element;
  }

  const fade = make('ending-fade');
  fade.setAttribute('aria-hidden', 'true');
  const countdownLayer = make('ending-countdown-layer');
  countdownLayer.setAttribute('aria-hidden', 'true');
  const clocks = [
    make('ending-countdown left', formatCountdown(0)),
    make('ending-countdown right', formatCountdown(0)),
  ];
  countdownLayer.append(...clocks);
  app.append(fade, countdownLayer);

  let shownText = '';

  return {
    setFadeOpacity(opacity) {
      fade.style.opacity = clamp01(opacity).toFixed(3);
    },
    setCountdownVisible(visible) {
      countdownLayer.style.opacity = visible ? '1' : '0';
      countdownLayer.setAttribute('aria-hidden', String(!visible));
    },
    setCountdownMs(remainingMs) {
      const text = formatCountdown(remainingMs);
      if (text === shownText) return; // only touch the DOM when a digit changes
      shownText = text;
      for (const clock of clocks) clock.textContent = text;
    },
    dispose() {
      fade.remove();
      countdownLayer.remove();
    },
  };
}

// 83450 ms -> "01:23.5" (minutes, seconds, tenths; never negative).
export function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Number(ms) || 0) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
}
