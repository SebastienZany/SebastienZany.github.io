import { ONE_SHOT_POLICY, getClip } from './clips.js';
import { rampAudioParam } from './audio-param.js';
import { createVoicePool } from './voice-pool.js';

/** Owns one-shot envelopes and the per-clip oldest-steal pool. */
export function createOneShotPlayer({
  clock,
  ensureContext,
  loadClipBuffer,
  getMasterGain,
  getClipSettings,
  mapPerformanceMilliseconds,
  mapContextSeconds,
}) {
  const voicePool = createVoicePool({
    clock,
    onSteal: (record, fadeSeconds) => stopRecord(record, fadeSeconds),
  });

  async function play(clipOrId, {
    restart = false,
    audition = false,
    startAtPerformanceMs = null,
    allowOverlap = !restart,
  } = {}) {
    const clip = requireClip(clipOrId);
    if (voicePool.activeForClip(clip.id).length > 0 && !allowOverlap) {
      stop(clip.id);
      if (!restart) return null;
    }
    const context = await ensureContext({ resume: true });
    const buffer = await loadClipBuffer(clip, { resumeContext: true });
    const startSeconds = Number.isFinite(startAtPerformanceMs)
      ? mapPerformanceMilliseconds(context, startAtPerformanceMs)
      : context.currentTime;
    const settings = getClipSettings(clip.id);
    const shouldLoop = Boolean(audition && settings.loop);
    const fadeInSeconds = Math.min(settings.fadeInSeconds, Math.max(0, buffer.duration - 0.001));
    const fadeOutSeconds = shouldLoop
      ? 0
      : Math.min(settings.fadeOutSeconds, Math.max(0, buffer.duration - fadeInSeconds - 0.001));
    const source = context.createBufferSource();
    const envelopeGain = context.createGain();
    const volumeGain = context.createGain();
    const record = {
      source, envelopeGain, volumeGain, context, clipId: clip.id, stopping: false, removed: false,
      startedAtSeconds: startSeconds,
      startedAtPerformanceMs: mapContextSeconds(context, startSeconds),
    };

    source.buffer = buffer;
    source.loop = shouldLoop;
    source.connect(envelopeGain);
    envelopeGain.connect(volumeGain);
    volumeGain.connect(getMasterGain());
    volumeGain.gain.setValueAtTime(settings.volume, startSeconds);
    envelopeGain.gain.setValueAtTime(fadeInSeconds > 0 ? 0.0001 : 1, startSeconds);
    if (fadeInSeconds > 0) envelopeGain.gain.linearRampToValueAtTime(1, startSeconds + fadeInSeconds);
    if (fadeOutSeconds > 0) {
      const fadeStartSeconds = startSeconds + Math.max(fadeInSeconds, buffer.duration - fadeOutSeconds);
      envelopeGain.gain.setValueAtTime(1, fadeStartSeconds);
      envelopeGain.gain.linearRampToValueAtTime(0.0001, startSeconds + buffer.duration);
    }
    source.addEventListener('ended', () => remove(record), { once: true });
    voicePool.admit(clip.id, record, clip.maxVoices ?? ONE_SHOT_POLICY.maximumVoicesPerClip);
    source.start(startSeconds);
    return record;
  }

  function stopRecord(record, fadeOutSeconds = getClipSettings(record.clipId).fadeOutSeconds) {
    if (!record || record.stopping) return;
    record.stopping = true;
    const nowSeconds = record.context?.currentTime ?? 0;
    const fadeSeconds = Math.max(0, Number(fadeOutSeconds) || 0);
    const envelopeParam = record.envelopeGain?.gain ?? record.volumeGain?.gain;
    if (envelopeParam) {
      envelopeParam.cancelScheduledValues(nowSeconds);
      envelopeParam.setValueAtTime(fadeSeconds > 0 ? envelopeParam.value : 0.0001, nowSeconds);
      if (fadeSeconds > 0) envelopeParam.linearRampToValueAtTime(0.0001, nowSeconds + fadeSeconds);
    }
    try {
      record.source.stop(Math.max(nowSeconds, record.startedAtSeconds ?? nowSeconds) + fadeSeconds + ONE_SHOT_POLICY.sourceStopTailSeconds);
    } catch {
      remove(record);
    }
  }

  function stop(clipId) {
    for (const record of voicePool.activeForClip(clipId)) stopRecord(record);
  }

  function remove(record) {
    if (record.removed) return;
    voicePool.remove(record);
    safeDisconnect(record.source);
    safeDisconnect(record.envelopeGain);
    safeDisconnect(record.volumeGain);
  }

  function rampVolumes(clipId, value, context, smooth) {
    for (const record of voicePool.activeForClip(clipId)) {
      rampAudioParam(record.volumeGain.gain, value, context, { smooth });
    }
  }

  return Object.freeze({
    play,
    stop,
    rampVolumes,
    inspect: () => voicePool.all()
      .filter(({ removed }) => !removed)
      .map(({ clipId, startedAtSeconds, stopping }) => ({ clipId, startedAtSeconds, stopping })),
  });
}

function requireClip(clipOrId) {
  const clip = typeof clipOrId === 'string' ? getClip(clipOrId) : clipOrId;
  if (!clip?.id) throw new RangeError(`Unknown audio clip: ${String(clipOrId)}`);
  return clip;
}

function safeDisconnect(node) {
  try { node?.disconnect?.(); } catch { /* An already-disconnected node is harmless. */ }
}
