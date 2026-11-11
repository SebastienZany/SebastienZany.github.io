// A reverb "room" made of nothing but decaying noise: no impulse file to load.
// Two independent noise channels give the tail its stereo width.

import { TUMBLE_SPATIAL } from './audio.config.js';

export function makeReverbImpulse(context) {
  const cfg = TUMBLE_SPATIAL;
  const sampleRate = context.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * cfg.reverbLengthSec));
  const earlyLiftSamples = sampleRate * cfg.reverbEarlyLiftSec;
  const impulse = context.createBuffer(2, length, sampleRate);

  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const samples = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const progress = i / Math.max(1, length - 1);
      const decay = Math.pow(1 - progress, cfg.reverbDecayPower);
      // Holding the first few milliseconds down softens the direct "slap", so
      // the reverb reads as distance and not as an echo.
      const earlyLift = cfg.reverbEarlyLiftFloor +
        (1 - cfg.reverbEarlyLiftFloor) * Math.min(1, i / earlyLiftSamples);
      const noise = Math.random() * 2 - 1;
      samples[i] = noise * decay * earlyLift * cfg.reverbNoiseGain;
    }
  }
  return impulse;
}
