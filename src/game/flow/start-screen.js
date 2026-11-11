// The start screen: title, intro line, "loading..." status and Begin button.
// Its markup is static in index.html (visible before any script runs); this
// file drives it. Every opacity is recomputed from `now` each frame, so the
// choreography is a pure function of four timestamps and can be scrubbed.

import { clamp01, smoothUnit } from './easing.js';
import { createBeginButton } from './begin-button.js';

// `getIntro()` -> { requested, completed, requestedAtMs }: the intro timeline's
// state. requestedAtMs is the moment the screen starts to let go (0 until the
// timeline is committed). `onBegin(now)` fires on the Begin click.
export function createStartScreen(ctx, config, { getIntro, onBegin }) {
  const app = ctx.dom.app;
  const view = app.ownerDocument.defaultView;
  const root = app.querySelector('#startScreen');
  if (!root) throw new Error('flow: #startScreen markup is missing from index.html');
  const title = root.querySelector('#startScreenTitle');
  const introLine = root.querySelector('#startScreenIntroLine');
  const dots = Array.from(root.querySelectorAll('.start-screen-intro-dot'));
  const status = root.querySelector('#startScreenStatus');
  const button = root.querySelector('#startButton');

  const fadeMs = config.startScreen.uiFadeMs;
  const state = {
    ready: false,        // loading finished and nothing failed
    failed: false,
    readyAtMs: 0,        // when "loading..." began to give way to Begin
    clickedAtMs: 0,      // when the Begin press took effect (the timeline's zero)
    beginFadeOutAtMs: 0, // when Begin starts to fade away
  };

  const beginButton = createBeginButton(
    button,
    { ...config.beginButton, fadeOutMs: fadeMs },
    () => ({
      introRequested: getIntro().requested,
      clickedAtMs: state.clickedAtMs,
      fadeOutAtMs: state.beginFadeOutAtMs,
    }),
  );

  const clock = () => view.performance.now();
  const listeners = [
    ['click', () => onBegin(clock())],
    ['pointerdown', () => beginButton.setHoverTarget(1, clock(), true)],
    ['keydown', (event) => {
      // Enter and Space activate a button natively; light it up at once.
      if (event.key === 'Enter' || event.key === ' ') beginButton.setHoverTarget(1, clock(), true);
    }],
    ['pointerenter', () => beginButton.setHoverTarget(1, clock())],
    ['pointerleave', () => beginButton.setHoverTarget(0, clock())],
    ['focus', () => {
      // Keyboard focus looks like hover; a mouse click's focus does not.
      if (button.matches?.(':focus-visible')) beginButton.setHoverTarget(1, clock());
    }],
    ['blur', () => beginButton.setHoverTarget(0, clock())],
  ];
  for (const [type, handler] of listeners) button.addEventListener(type, handler);
  button.disabled = true; // until setReady

  function setOpacity(element, opacity) {
    element.style.opacity = clamp01(opacity).toFixed(3);
  }

  function showStatus(text, isError) {
    status.textContent = text;
    status.classList.toggle('error', isError);
  }

  function clearPress(now) {
    state.clickedAtMs = 0;
    state.beginFadeOutAtMs = 0;
    beginButton.setHoverTarget(0, now, true);
  }

  // Loading finished: "loading..." fades out, then Begin fades in.
  function setReady(now) {
    state.ready = true;
    state.failed = false;
    state.readyAtMs = now;
    clearPress(now);
    showStatus(config.startScreen.loadingText, false);
    button.disabled = false;
    update(now);
  }

  // Fatal load error: the message replaces "loading..." in red and stays.
  function fail(message, now) {
    state.ready = false;
    state.failed = true;
    state.readyAtMs = 0;
    clearPress(now);
    root.classList.remove('is-armed', 'is-running', 'is-complete');
    root.removeAttribute('aria-hidden');
    showStatus(String(message || config.startScreen.fallbackErrorText), true);
    button.disabled = true;
    update(now);
  }

  // After an ending: the black screen is back with Begin already fully shown.
  function returnToBegin(now) {
    state.ready = true;
    state.failed = false;
    state.readyAtMs = now - fadeMs * 2; // as if both fades finished long ago
    clearPress(now);
    root.classList.remove('is-armed', 'is-running', 'is-complete');
    root.removeAttribute('aria-hidden');
    root.style.display = ''; // undo hide(): under ?dev the screen was never shown
    showStatus(config.startScreen.loadingText, false);
    button.disabled = false;
    update(now);
  }

  // The Begin press has taken effect at clickedAtMs; Begin holds, glowing,
  // until fadeOutAtMs.
  function markBeginPressed(clickedAtMs, fadeOutAtMs) {
    state.clickedAtMs = clickedAtMs;
    state.beginFadeOutAtMs = fadeOutAtMs;
    beginButton.setHoverTarget(1, clickedAtMs, true);
    root.classList.add('is-armed');
    update(clickedAtMs);
  }

  // The intro was skipped: no glow, no hold. The caller redraws once it has
  // updated the intro state.
  function markSkipped(now) {
    state.clickedAtMs = now;
    state.beginFadeOutAtMs = now;
    beginButton.setHoverTarget(0, now, true);
    button.disabled = true;
    root.classList.add('is-armed', 'is-running');
  }

  function update(now) {
    const intro = getIntro();
    let beginOpacity = 0;
    let showStatusText = true;
    let showButton = false;

    // Status and Begin share one spot: the status fades out over one fade
    // length, then Begin fades in over the next.
    const waiting = state.failed || !state.ready || state.readyAtMs <= 0;
    const readyForMs = waiting ? 0 : now - state.readyAtMs;
    if (waiting) {
      setOpacity(status, 1);
    } else if (readyForMs < fadeMs) {
      setOpacity(status, 1 - smoothUnit(readyForMs / fadeMs));
    } else {
      const fadeIn = smoothUnit((readyForMs - fadeMs) / fadeMs);
      const fadeOut = state.beginFadeOutAtMs > 0
        ? smoothUnit((now - state.beginFadeOutAtMs) / fadeMs)
        : 0;
      beginOpacity = fadeIn * (1 - fadeOut);
      showStatusText = false;
      // Once pressed and faded away, take it out of the tab order too.
      showButton = !(fadeOut >= 1 && intro.requested);
    }
    status.hidden = !showStatusText;
    button.hidden = !showButton;
    setOpacity(button, beginOpacity);
    beginButton.draw(now);
    const clickable = state.ready && !intro.requested && !intro.completed &&
      !button.disabled && beginOpacity > config.startScreen.beginClickableAboveOpacity;
    button.style.pointerEvents = clickable ? 'auto' : 'none';

    // Before the timeline is committed the screen just sits there.
    if (!intro.requested || intro.requestedAtMs <= 0) {
      setOpacity(root, intro.completed ? 0 : 1);
      setOpacity(title, 1);
      setOpacity(introLine, 0);
      for (const dot of dots) setOpacity(dot, 0);
      return;
    }

    // After it: title out; a silent beat; intro line in, its three dots
    // arriving one by one; intro line out; then the whole screen clears just
    // as the oat reaches the top edge.
    const elapsedMs = now - intro.requestedAtMs;
    const lineInAtMs = fadeMs + config.intro.silentBeatMs;
    const screenClearAtMs = lineInAtMs + config.intro.oatTopEdgeDelayMs;
    const lineOutAtMs = screenClearAtMs - fadeMs * 2;
    setOpacity(root, 1 - smoothUnit((elapsedMs - (screenClearAtMs - fadeMs)) / fadeMs));
    setOpacity(title, 1 - smoothUnit(elapsedMs / fadeMs));
    setOpacity(
      introLine,
      smoothUnit((elapsedMs - lineInAtMs) / fadeMs) * (1 - smoothUnit((elapsedMs - lineOutAtMs) / fadeMs)),
    );
    // The dots split the line's time on screen into four equal waits.
    const dotStepMs = Math.max(1, (lineOutAtMs - lineInAtMs) / 4);
    dots.forEach((dot, index) => {
      setOpacity(dot, smoothUnit((elapsedMs - (lineInAtMs + dotStepMs * (index + 1))) / fadeMs));
    });
  }

  return {
    get ready() { return state.ready; },
    get failed() { return state.failed; },
    get clickedAtMs() { return state.clickedAtMs; },
    setReady,
    fail,
    returnToBegin,
    markBeginPressed,
    markSkipped,
    update,
    disableButton() { button.disabled = true; },
    // Input passes through to the canvas from here on.
    setRunning() { root.classList.add('is-running'); },
    setComplete() {
      root.classList.add('is-complete');
      root.setAttribute('aria-hidden', 'true');
    },
    // ?dev: the screen never shows at all.
    hide() { root.style.display = 'none'; },
    dispose() {
      for (const [type, handler] of listeners) button.removeEventListener(type, handler);
    },
  };
}
