export function defaultContextFactory() {
  const AudioContextConstructor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AudioContextConstructor) return null;
  return new AudioContextConstructor();
}

export function defaultTimers() {
  return {
    setInterval: (...args) => globalThis.setInterval(...args),
    clearInterval: (...args) => globalThis.clearInterval(...args),
    setTimeout: (...args) => globalThis.setTimeout(...args),
    requestIdleCallback: globalThis.requestIdleCallback?.bind(globalThis),
  };
}

export function safeDisconnect(node) {
  try { node?.disconnect?.(); } catch { /* An already-disconnected node is harmless. */ }
}
