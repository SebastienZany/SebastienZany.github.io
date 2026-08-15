import { CLIPS, CLIP_DEFAULTS } from './clips.js';
import { clampFinite } from './audio-param.js';

/** Mutable audition/game settings constrained by the anchored clip table. */
export function createClipSettingsStore() {
  const settingsById = new Map(CLIPS.map((clip) => [clip.id, {
    volume: clip.gain,
    maximumVolume: clip.maxGain,
    loop: clip.loop,
    fadeInSeconds: clip.fadeInSeconds,
    fadeOutSeconds: clip.fadeOutSeconds,
  }]));

  function mutable(clipId) {
    const settings = settingsById.get(clipId);
    if (!settings) throw new RangeError(`Unknown audio clip: ${clipId}`);
    return settings;
  }

  return Object.freeze({
    get(clipId) {
      return { ...mutable(clipId) };
    },
    setVolume(clipId, value) {
      const settings = mutable(clipId);
      settings.volume = clampFinite(value, 0, settings.maximumVolume, settings.volume);
      return settings.volume;
    },
    setLoop(clipId, enabled) {
      const settings = mutable(clipId);
      settings.loop = Boolean(enabled);
      return settings.loop;
    },
    setFadeIn(clipId, seconds) {
      const settings = mutable(clipId);
      settings.fadeInSeconds = clampFinite(seconds, 0, CLIP_DEFAULTS.maximumFadeSeconds, settings.fadeInSeconds);
      return settings.fadeInSeconds;
    },
    setFadeOut(clipId, seconds) {
      const settings = mutable(clipId);
      settings.fadeOutSeconds = clampFinite(seconds, 0, CLIP_DEFAULTS.maximumFadeSeconds, settings.fadeOutSeconds);
      return settings.fadeOutSeconds;
    },
    inspect() {
      return Object.fromEntries([...settingsById].map(([clipId, settings]) => [clipId, { ...settings }]));
    },
  });
}
