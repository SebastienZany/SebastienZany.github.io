import { CLIPS, PRELOAD_POLICY, getClip } from './clips.js';

/** Fetches and decodes each path once, including the sticky ambience fallback. */
export function createAudioBufferStore({ ensureContext, fetchResource, timers, logger }) {
  const buffers = new Map();
  const pending = new Map();
  let selectedEnvPath = null;
  let warnedForEnvFallback = false;

  async function loadPath(path, { resumeContext = false } = {}) {
    if (buffers.has(path)) return buffers.get(path);
    if (!pending.has(path)) {
      const promise = (async () => {
        const context = await ensureContext({ resume: resumeContext });
        const response = await fetchResource(path);
        if (!response?.ok) throw new Error(`Failed to load ${path}: ${response?.status ?? 'network error'}`);
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        buffers.set(path, buffer);
        return buffer;
      })().catch((error) => {
        pending.delete(path);
        throw error;
      });
      pending.set(path, promise);
    }
    return pending.get(path);
  }

  async function loadClipBuffer(clipOrId, { resumeContext = false } = {}) {
    const clip = requireClip(clipOrId);
    if (clip.id !== 'env') return loadPath(clip.path, { resumeContext });
    if (selectedEnvPath) return loadPath(selectedEnvPath, { resumeContext });
    try {
      const buffer = await loadPath(clip.path, { resumeContext });
      selectedEnvPath = clip.path;
      return buffer;
    } catch (primaryError) {
      if (!clip.fallbackPath || clip.fallbackPath === clip.path) throw primaryError;
      const buffer = await loadPath(clip.fallbackPath, { resumeContext });
      selectedEnvPath = clip.fallbackPath;
      if (!warnedForEnvFallback) {
        logger.warn(`Failed to load ${fileName(clip.path)}; using ${fileName(clip.fallbackPath)} instead.`, primaryError);
        warnedForEnvFallback = true;
      }
      return buffer;
    }
  }

  async function preloadAll() {
    const results = await Promise.allSettled(CLIPS.map((clip) => loadClipBuffer(clip, { resumeContext: false })));
    const failureCount = results.filter(({ status }) => status === 'rejected').length;
    if (failureCount > 0) logger.warn(`Sound preload skipped ${failureCount} clip(s); playback will retry on demand.`);
    return results;
  }

  function schedulePreload() {
    for (const clipId of PRELOAD_POLICY.priorityClipIds) {
      void loadClipBuffer(clipId, { resumeContext: false }).catch((error) => logger.warn(`Failed to warm ${clipId}.`, error));
    }
    const startIdleBatch = () => { void preloadAll(); };
    if (typeof timers.requestIdleCallback === 'function') {
      return timers.requestIdleCallback(startIdleBatch, { timeout: PRELOAD_POLICY.idleTimeoutMilliseconds });
    }
    return timers.setTimeout(startIdleBatch, PRELOAD_POLICY.fallbackDelayMilliseconds);
  }

  return Object.freeze({
    loadClipBuffer,
    preloadAll,
    schedulePreload,
    inspect: () => ({ loadedPaths: [...buffers.keys()], selectedEnvPath }),
  });
}

function requireClip(clipOrId) {
  const clip = typeof clipOrId === 'string' ? getClip(clipOrId) : clipOrId;
  if (!clip?.id) throw new RangeError(`Unknown audio clip: ${String(clipOrId)}`);
  return clip;
}

function fileName(path) {
  return String(path).split('/').pop();
}
