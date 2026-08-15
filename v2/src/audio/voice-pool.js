import { ONE_SHOT_POLICY } from './clips.js';

/** A per-clip one-shot pool with stable oldest-first stealing. */
export function createVoicePool({ clock, onSteal = () => {} } = {}) {
  if (typeof clock?.now !== 'function') throw new TypeError('voice pool clock must expose now()');
  const records = [];
  let sequence = 0;

  function activeForClip(clipId) {
    return records
      .filter((record) => record.clipId === clipId && !record.removed && !record.stopping)
      .sort(compareAge);
  }

  return Object.freeze({
    admit(clipId, record, maximumVoices = ONE_SHOT_POLICY.maximumVoicesPerClip) {
      const voiceLimit = Math.max(1, Math.floor(Number(maximumVoices) || ONE_SHOT_POLICY.maximumVoicesPerClip));
      const active = activeForClip(clipId);
      const stealCount = Math.max(0, active.length - voiceLimit + 1);
      const stolen = active.slice(0, stealCount);
      for (const oldRecord of stolen) {
        onSteal(oldRecord, ONE_SHOT_POLICY.stealFadeSeconds);
        oldRecord.stopping = true;
      }

      record.clipId = clipId;
      record.startedAtSeconds = Number.isFinite(record.startedAtSeconds)
        ? record.startedAtSeconds
        : Number(clock.now()) / 1000;
      record.voiceSequence = sequence++;
      records.push(record);
      return { admitted: record, stolen };
    },

    remove(record) {
      record.removed = true;
      const index = records.indexOf(record);
      if (index >= 0) records.splice(index, 1);
    },

    activeForClip,

    all() {
      return [...records];
    },
  });
}

function compareAge(left, right) {
  return left.startedAtSeconds - right.startedAtSeconds || left.voiceSequence - right.voiceSequence;
}
