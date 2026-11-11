// Fetches and decodes clips, once each. Nothing here needs a user gesture.

import { CLIPS, SOUNDS_DIR } from './audio.config.js';

// Old Safari only has the callback form of decodeAudioData; newer browsers
// return a promise. Listening to both covers either.
function decode(context, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const maybePromise = context.decodeAudioData(arrayBuffer, resolve, reject);
    maybePromise?.then?.(resolve, reject);
  });
}

export function createBufferCache({ output, diag }) {
  const decoded = new Map();   // name -> AudioBuffer
  const inFlight = new Map();  // name -> Promise<AudioBuffer | null>

  async function fetchAndDecode(name) {
    const graph = output.ensure();
    if (!graph) return null;
    const url = `${SOUNDS_DIR}/${name}.wav`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const buffer = await decode(graph.context, await response.arrayBuffer());
    decoded.set(name, buffer);
    return buffer;
  }

  // Resolves to the buffer, or null on any failure (logged). Never rejects.
  // A failed load is forgotten, so a later call tries again.
  function load(name) {
    if (decoded.has(name)) return Promise.resolve(decoded.get(name));
    if (!CLIPS[name]) {
      diag.log('audio:unknown-clip', String(name));
      return Promise.resolve(null);
    }
    if (!inFlight.has(name)) {
      const loading = fetchAndDecode(name)
        .catch((err) => {
          diag.log('audio:load-failed', `${name}: ${err?.message ?? err}`);
          return null;
        })
        .finally(() => inFlight.delete(name));
      inFlight.set(name, loading);
    }
    return inFlight.get(name);
  }

  return {
    load,
    get: (name) => decoded.get(name) ?? null,
    clear: () => decoded.clear(),
  };
}
