// One-shot voices: play a clip once, possibly many overlapping copies.
//
//   source -> envelope gain (fades) -> volume gain -> master
//
// The envelope and the volume are separate nodes so a stop-fade never fights
// with the clip's volume.

import { CLIPS, ONE_SHOT, SILENT_GAIN } from './audio.config.js';
import { contextSecToPerformanceMs, performanceMsToContextSec } from './clock.js';
import { disconnectQuietly, fadeMsToSec, fadeToSilence } from './param-ramps.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function clipVolume(clip, requestedVolume) {
  const maxGain = Math.max(0.01, clip.maxGain ?? 1);
  const wanted = Number.isFinite(requestedVolume) ? requestedVolume : (clip.gain ?? 1);
  return clamp(wanted, 0, maxGain);
}

export function createOneShots({ output, buffers, diag }) {
  const voices = []; // every voice that has been started and has not ended yet

  function forget(voice) {
    if (voice.ended) return;
    voice.ended = true;
    const index = voices.indexOf(voice);
    if (index >= 0) voices.splice(index, 1);
    disconnectQuietly(voice.source);
    disconnectQuietly(voice.envelope);
    disconnectQuietly(voice.volume);
  }

  function stopVoice(context, voice, fadeSec) {
    if (voice.ended || voice.stopping) return;
    voice.stopping = true;
    fadeToSilence(context, voice.envelope.gain, fadeSec);
    try {
      // A voice scheduled for the future still has to reach its start before
      // it can be stopped, hence the max().
      const from = Math.max(context.currentTime, voice.startSec);
      voice.source.stop(from + fadeSec + ONE_SHOT.stopTailSec);
    } catch {
      forget(voice);
    }
  }

  // Keep at most maxVoicesPerClip of one clip sounding: the oldest go first.
  function stealOldestVoices(context, name) {
    const active = voices
      .filter((voice) => voice.name === name && !voice.stopping)
      .sort((a, b) => a.startSec - b.startSec);
    const excess = active.length - ONE_SHOT.maxVoicesPerClip + 1;
    for (let i = 0; i < excess; i++) stopVoice(context, active[i], ONE_SHOT.stealFadeSec);
  }

  // -> { stop({ fadeMs }), startedAtMs } or null if the clip cannot play now.
  function play(name, { atMs, volume } = {}) {
    const clip = CLIPS[name];
    if (!clip) {
      diag.log('audio:unknown-clip', String(name));
      return null;
    }
    const graph = output.ensure();
    if (!graph) return null;
    const buffer = buffers.get(name);
    if (!buffer) {
      // Not decoded yet: skip this play, but make sure the next one works.
      diag.log('audio:not-ready', name);
      buffers.load(name);
      return null;
    }
    const { context, master } = graph;
    stealOldestVoices(context, name);

    const startSec = performanceMsToContextSec(context, atMs);
    const durationSec = buffer.duration;
    const fadeInSec = clamp(clip.fadeInSec ?? ONE_SHOT.defaultFadeInSec, 0,
      Math.min(ONE_SHOT.maxFadeSec, Math.max(0, durationSec - 0.001)));
    const fadeOutSec = clamp(clip.fadeOutSec ?? ONE_SHOT.defaultFadeOutSec, 0,
      Math.min(ONE_SHOT.maxFadeSec, Math.max(0, durationSec - fadeInSec - 0.001)));

    const source = context.createBufferSource();
    const envelope = context.createGain();
    const volumeGain = context.createGain();
    source.buffer = buffer;
    source.connect(envelope);
    envelope.connect(volumeGain);
    volumeGain.connect(master);

    volumeGain.gain.setValueAtTime(clipVolume(clip, volume), startSec);
    envelope.gain.setValueAtTime(fadeInSec > 0 ? SILENT_GAIN : 1, startSec);
    if (fadeInSec > 0) envelope.gain.linearRampToValueAtTime(1, startSec + fadeInSec);
    if (fadeOutSec > 0) {
      // A short fade at the natural end hides any click in the file's last samples.
      envelope.gain.setValueAtTime(1, startSec + Math.max(fadeInSec, durationSec - fadeOutSec));
      envelope.gain.linearRampToValueAtTime(SILENT_GAIN, startSec + durationSec);
    }

    const voice = { name, source, envelope, volume: volumeGain, startSec, stopping: false, ended: false };
    source.addEventListener('ended', () => forget(voice), { once: true });
    voices.push(voice);
    source.start(startSec);

    const defaultStopFadeSec = clip.fadeOutSec ?? ONE_SHOT.defaultFadeOutSec;
    return {
      // When the first sample is actually heard, in the game's clock.
      startedAtMs: contextSecToPerformanceMs(context, startSec),
      stop({ fadeMs } = {}) {
        try {
          stopVoice(context, voice, fadeMsToSec(fadeMs, defaultStopFadeSec));
        } catch (err) {
          diag.log('audio:stop-failed', `${name}: ${err?.message ?? err}`);
        }
      },
    };
  }

  // fadeMs undefined -> each clip's own default stop fade.
  function stopAll({ fadeMs } = {}) {
    if (voices.length === 0) return;
    const graph = output.ensure();
    if (!graph) return;
    for (const voice of [...voices]) {
      const clip = CLIPS[voice.name];
      const fallbackSec = clip?.fadeOutSec ?? ONE_SHOT.defaultFadeOutSec;
      stopVoice(graph.context, voice, fadeMsToSec(fadeMs, fallbackSec));
    }
  }

  return { play, stopAll, activeCount: () => voices.length };
}
