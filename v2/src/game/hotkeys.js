export const HOTKEY_COMMANDS = Object.freeze({
  p: 'togglePanels',
  s: 'skipIntro',
  m: 'toggleStories',
  1: 'toggleSlime',
  2: 'toggleGoldBody',
  3: 'toggleAgentDots',
});

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);

export function routeHotkey(event, commands) {
  const key = String(event.key ?? '').toLowerCase();
  const commandName = HOTKEY_COMMANDS[key];
  if (!commandName || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return false;
  if (isEditableTarget(event.target)) return false;
  const command = commands?.[commandName];
  if (typeof command !== 'function') return false;
  event.preventDefault?.();
  command();
  return true;
}

export function isEditableTarget(target) {
  for (let node = target; node; node = node.parentElement) {
    if (EDITABLE_TAGS.has(String(node.tagName ?? '').toUpperCase())) return true;
    const editable = node.getAttribute?.('contenteditable');
    if (editable === '' || editable === 'true') return true;
  }
  return false;
}

// Pure pointer state machine for the coarse-pointer corner hotspot. The clock
// is injected so the 1200 ms gesture window can be proven without a browser.
export function createTripleTapStateMachine({ clock, onTripleTap, windowMs = 1200, movementTolerancePx = 12 }) {
  if (!clock || typeof clock.now !== 'function') throw new TypeError('A clock with now() is required');
  if (typeof onTripleTap !== 'function') throw new TypeError('onTripleTap must be a function');
  let tapTimesMs = [];
  let pointerDown = null;

  return Object.freeze({
    pointerDown({ pointerId, clientX, clientY }) {
      pointerDown = { pointerId, clientX, clientY };
    },
    pointerUp({ pointerId, clientX, clientY }) {
      if (!pointerDown || pointerDown.pointerId !== pointerId) {
        pointerDown = null;
        return false;
      }
      const movementPx = Math.hypot(clientX - pointerDown.clientX, clientY - pointerDown.clientY);
      pointerDown = null;
      if (movementPx > movementTolerancePx) {
        tapTimesMs = [];
        return false;
      }
      const nowMs = clock.now();
      tapTimesMs = tapTimesMs.filter((tapMs) => nowMs - tapMs < windowMs);
      tapTimesMs.push(nowMs);
      if (tapTimesMs.length < 3) return false;
      tapTimesMs = [];
      onTripleTap();
      return true;
    },
    pointerCancel() {
      pointerDown = null;
    },
    reset() {
      pointerDown = null;
      tapTimesMs = [];
    },
    inspect() {
      return Object.freeze({ pointerDown: pointerDown ? { ...pointerDown } : null, tapTimesMs: Object.freeze([...tapTimesMs]) });
    },
  });
}

