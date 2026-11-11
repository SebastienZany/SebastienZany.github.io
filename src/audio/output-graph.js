// The one AudioContext and the end of the signal chain:
//
//   everything -> master gain -> [compressor, if enabled] -> speakers
//
// The context is created lazily. Creating it (and decoding into it) does not
// need a user gesture; only *hearing* it does, which is what unlock() is for.

import { COMPRESSOR, MASTER } from './audio.config.js';

export function createOutputGraph({ diag }) {
  let context = null;
  let master = null;
  let unavailableLogged = false;

  function build() {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error('Web Audio is not available in this browser');
    context = new AudioContextClass();
    master = context.createGain();
    master.gain.setValueAtTime(MASTER.gain, context.currentTime);

    if (COMPRESSOR.enabled) {
      const compressor = context.createDynamicsCompressor();
      const at = context.currentTime;
      compressor.threshold.setValueAtTime(COMPRESSOR.thresholdDb, at);
      compressor.knee.setValueAtTime(COMPRESSOR.kneeDb, at);
      compressor.ratio.setValueAtTime(COMPRESSOR.ratio, at);
      compressor.attack.setValueAtTime(COMPRESSOR.attackSec, at);
      compressor.release.setValueAtTime(COMPRESSOR.releaseSec, at);
      master.connect(compressor);
      compressor.connect(context.destination);
    } else {
      master.connect(context.destination);
    }
  }

  // -> { context, master } or null when WebAudio cannot be used.
  function ensure() {
    if (context) return { context, master };
    if (unavailableLogged) return null;
    try {
      build();
      return { context, master };
    } catch (err) {
      context = null;
      master = null;
      unavailableLogged = true;
      diag.log('audio:unavailable', String(err?.message ?? err));
      return null;
    }
  }

  // Must run synchronously inside a user gesture: iOS only honours resume()
  // when it is called before the handler yields.
  function unlock() {
    const graph = ensure();
    if (!graph || graph.context.state === 'running') return;
    try {
      const resumed = graph.context.resume();
      resumed?.catch?.((err) => diag.log('audio:resume-failed', String(err?.message ?? err)));
    } catch (err) {
      diag.log('audio:resume-failed', String(err?.message ?? err));
    }
  }

  function dispose() {
    try {
      master?.disconnect();
      context?.close?.()?.catch?.(() => {});
    } catch {
      // closing an already closed context is fine
    }
    context = null;
    master = null;
    unavailableLogged = true; // a disposed engine must not quietly rebuild itself
  }

  return { ensure, unlock, dispose };
}
