import { gameClock } from '../shared/clock.js';
import {
  AUDIO_NUMERICS,
  COMPRESSOR_CONTROLS,
  COMPRESSOR_DEFAULTS,
  ENV_LOOP,
  ONE_SHOT_POLICY,
  TUMBLE_LOOP,
  TUMBLE_SPATIAL,
} from './clips.js';
import { applyGainAutomation, clampFinite, rampAudioParam } from './audio-param.js';
import { createAudioBufferStore } from './buffer-store.js';
import { createClipSettingsStore } from './clip-settings.js';
import { createOneShotPlayer } from './one-shots.js';
import { defaultContextFactory, defaultTimers, safeDisconnect } from './platform.js';
import { planEnvSchedule, planTumbleSchedule } from './schedulers.js';
import {
  createStubPositionProvider,
  createTumbleSpatialGraph,
  initialTumbleReferenceDistance,
  syncTumbleSpatialGraph,
} from './spatial.js';
import {
  contextTimeToPerformanceMilliseconds,
  performanceMillisecondsToContextTime,
} from './timestamp.js';

export { contextTimeToPerformanceMilliseconds, performanceMillisecondsToContextTime } from './timestamp.js';

/**
 * Fresh WebAudio engine for the parity graph in reference/parity-checklist.md §3.
 * AudioContext creation is lazy. unlockFromGesture() calls resume synchronously before it
 * returns a promise; Begin must invoke it directly, before its first await (main.js:6092-6100).
 */
export function createAudioEngine({
  clock = gameClock,
  schedulerClock = null,
  positionProvider = createStubPositionProvider(),
  createContext = defaultContextFactory,
  fetchResource = (...args) => globalThis.fetch(...args),
  timers = defaultTimers(),
  random = Math.random,
  logger = console,
} = {}) {
  const clipSettings = createClipSettingsStore();
  const compressorSettings = { ...COMPRESSOR_DEFAULTS };
  const state = {
    context: null,
    masterGain: null,
    compressor: null,
    masterRoute: 'uninitialized',
    env: { output: null, sources: [], running: false, nextStartSeconds: null, timerId: null },
    tumble: {
      graph: null, sources: [], running: false, nextStartSeconds: null,
      scheduleTimerId: null, spatialTimerId: null, duration: 0, startingPromise: null,
      referenceDistance: initialTumbleReferenceDistance(positionProvider),
    },
  };

  const bufferStore = createAudioBufferStore({ ensureContext, fetchResource, timers, logger });
  const oneShots = createOneShotPlayer({
    clock,
    ensureContext,
    loadClipBuffer: bufferStore.loadClipBuffer,
    getMasterGain: () => state.masterGain,
    getClipSettings,
    mapPerformanceMilliseconds: (context, milliseconds) => performanceMillisecondsToContextTime(context, clock, milliseconds),
    mapContextSeconds: (context, seconds) => contextTimeToPerformanceMilliseconds(context, clock, seconds),
  });
  const { loadClipBuffer, preloadAll, schedulePreload } = bufferStore;
  const playOneShot = oneShots.play;
  const stopOneShots = oneShots.stop;

  function ensureContextSync() {
    if (state.context) return state.context;
    const context = createContext();
    if (!context) throw new Error('Web Audio is not available in this browser.');
    state.context = context;
    state.masterGain = context.createGain();
    connectMasterOutput();
    return context;
  }

  async function ensureContext({ resume = true } = {}) {
    const context = ensureContextSync();
    if (resume && context.state !== 'running') await context.resume();
    return context;
  }

  function unlockFromGesture() {
    const context = ensureContextSync();
    // Do not make this function async: resume() must be invoked in the gesture stack.
    const resumeResult = context.state === 'running' ? undefined : context.resume();
    return Promise.resolve(resumeResult).then(() => context);
  }

  function connectMasterOutput() {
    if (!state.context || !state.masterGain) return;
    safeDisconnect(state.masterGain);
    safeDisconnect(state.compressor);
    if (compressorSettings.enabled) {
      const compressor = ensureCompressor();
      state.masterGain.connect(compressor);
      compressor.connect(state.context.destination);
      state.masterRoute = 'compressor';
    } else {
      state.masterGain.connect(state.context.destination);
      state.masterRoute = 'destination';
    }
  }

  function ensureCompressor() {
    if (!state.compressor) state.compressor = state.context.createDynamicsCompressor();
    applyCompressorSettings(false);
    return state.compressor;
  }

  function applyCompressorSettings(smooth = true) {
    if (!state.compressor) return;
    for (const control of COMPRESSOR_CONTROLS) {
      rampAudioParam(state.compressor[control.key], compressorSettings[control.key], state.context, { smooth });
    }
  }

  function setCompressorEnabled(enabled) {
    compressorSettings.enabled = Boolean(enabled);
    if (state.context) connectMasterOutput();
    return compressorSettings.enabled;
  }

  function setCompressorParam(key, value, { smooth = true } = {}) {
    const control = COMPRESSOR_CONTROLS.find((candidate) => candidate.key === key);
    if (!control) return null;
    compressorSettings[key] = clampFinite(value, control.min, control.max, COMPRESSOR_DEFAULTS[key]);
    if (state.compressor) rampAudioParam(state.compressor[key], compressorSettings[key], state.context, { smooth });
    return compressorSettings[key];
  }

  function ensureEnvOutput() {
    if (!state.env.output) {
      state.env.output = state.context.createGain();
      state.env.output.gain.setValueAtTime(getClipSettings('env').volume, state.context.currentTime);
      state.env.output.connect(state.masterGain);
    }
    return state.env.output;
  }

  async function startEnv() {
    if (state.env.running) return getState().env;
    const context = await ensureContext({ resume: true });
    const buffer = await loadClipBuffer('env', { resumeContext: true });
    planEnvSchedule(getSchedulerClock(), buffer.duration, { untilSeconds: -Infinity });
    const output = ensureEnvOutput();
    const settings = getClipSettings('env');
    output.gain.cancelScheduledValues(context.currentTime);
    output.gain.setValueAtTime(settings.fadeInSeconds > 0 ? AUDIO_NUMERICS.silenceGain : settings.volume, context.currentTime);
    if (settings.fadeInSeconds > 0) output.gain.linearRampToValueAtTime(settings.volume, context.currentTime + settings.fadeInSeconds);
    state.env.buffer = buffer;
    state.env.running = true;
    state.env.nextStartSeconds = null;
    pumpEnvSchedule();
    state.env.timerId = timers.setInterval(pumpEnvSchedule, ENV_LOOP.pumpIntervalMilliseconds);
    return getState().env;
  }

  function pumpEnvSchedule() {
    if (!state.env.running) return;
    const plan = planEnvSchedule(getSchedulerClock(), state.env.buffer.duration, {
      nextStartSeconds: state.env.nextStartSeconds,
      crossfadeSeconds: getClipSettings('env').fadeOutSeconds,
    });
    for (const sourcePlan of plan.sources) scheduleLoopSource('env', sourcePlan, state.env.buffer, ensureEnvOutput());
    state.env.nextStartSeconds = plan.nextStartSeconds;
  }

  function stopEnv() {
    state.env.running = false;
    clearTimer('env', 'timerId');
    fadeAndStopLoopSources(state.env.sources, getClipSettings('env').fadeOutSeconds);
  }

  function startTumble(options = {}) {
    if (state.tumble.running) {
      syncSpatial({ force: true });
      return Promise.resolve(getState().tumble);
    }
    if (state.tumble.startingPromise) return state.tumble.startingPromise;
    state.tumble.startingPromise = startTumbleOnce(options).finally(() => {
      state.tumble.startingPromise = null;
    });
    return state.tumble.startingPromise;
  }

  async function startTumbleOnce({
    fadeInSeconds = TUMBLE_LOOP.defaultGameFadeInSeconds,
    startAtPerformanceMs = null,
  } = {}) {
    const context = await ensureContext({ resume: true });
    const buffer = await loadClipBuffer('slime-tumble', { resumeContext: true });
    planTumbleSchedule(getSchedulerClock(), buffer.duration, { untilSeconds: -Infinity });
    state.tumble.buffer = buffer;
    state.tumble.duration = buffer.duration;
    if (!state.tumble.graph) {
      state.tumble.graph = createTumbleSpatialGraph(context, state.masterGain, {
        positionProvider, volume: getClipSettings('slime-tumble').volume, random,
        referenceDistance: state.tumble.referenceDistance,
      });
    }
    syncSpatial({ force: true, smooth: false });
    const startSeconds = Number.isFinite(startAtPerformanceMs)
      ? performanceMillisecondsToContextTime(context, clock, startAtPerformanceMs)
      : context.currentTime + TUMBLE_LOOP.startDelaySeconds;
    const fadeSeconds = Math.max(0, Number(fadeInSeconds) || 0);
    const fadeParam = state.tumble.graph.fadeGain.gain;
    fadeParam.cancelScheduledValues(context.currentTime);
    fadeParam.setValueAtTime(AUDIO_NUMERICS.silenceGain, startSeconds);
    if (fadeSeconds > 0) fadeParam.linearRampToValueAtTime(1, startSeconds + fadeSeconds);
    else fadeParam.setValueAtTime(1, startSeconds);
    state.tumble.running = true;
    state.tumble.nextStartSeconds = startSeconds;
    pumpTumbleSchedule();
    state.tumble.scheduleTimerId = timers.setInterval(pumpTumbleSchedule, TUMBLE_LOOP.pumpIntervalMilliseconds);
    state.tumble.spatialTimerId = timers.setInterval(syncSpatial, TUMBLE_SPATIAL.syncIntervalMilliseconds);
    return getState().tumble;
  }

  function pumpTumbleSchedule() {
    if (!state.tumble.running) return;
    const plan = planTumbleSchedule(getSchedulerClock(), state.tumble.duration, {
      nextStartSeconds: state.tumble.nextStartSeconds,
    });
    for (const sourcePlan of plan.sources) {
      scheduleLoopSource('tumble', sourcePlan, state.tumble.buffer, state.tumble.graph.panner);
    }
    state.tumble.nextStartSeconds = plan.nextStartSeconds;
  }

  function stopTumble({ fadeOutSeconds = getClipSettings('slime-tumble').fadeOutSeconds } = {}) {
    state.tumble.running = false;
    clearTimer('tumble', 'scheduleTimerId');
    clearTimer('tumble', 'spatialTimerId');
    const fadeSeconds = Math.max(0, Number(fadeOutSeconds) || 0);
    const fadeParam = state.tumble.graph?.fadeGain.gain;
    if (fadeParam) {
      fadeParam.cancelScheduledValues(state.context.currentTime);
      fadeParam.setValueAtTime(fadeSeconds > 0 ? fadeParam.value : AUDIO_NUMERICS.silenceGain, state.context.currentTime);
      if (fadeSeconds > 0) fadeParam.linearRampToValueAtTime(AUDIO_NUMERICS.silenceGain, state.context.currentTime + fadeSeconds);
    }
    fadeAndStopLoopSources(state.tumble.sources, fadeSeconds);
  }

  function scheduleLoopSource(kind, sourcePlan, buffer, destination) {
    const source = state.context.createBufferSource();
    const gain = state.context.createGain();
    const records = kind === 'env' ? state.env.sources : state.tumble.sources;
    const record = { source, gain, ...sourcePlan, removed: false };
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(destination);
    applyGainAutomation(gain.gain, sourcePlan.gainAutomation);
    if (kind === 'env') source.start(sourcePlan.startSeconds, 0);
    else source.start(sourcePlan.startSeconds, sourcePlan.offsetSeconds, sourcePlan.playDurationSeconds);
    source.stop(sourcePlan.nodeStopSeconds);
    source.addEventListener('ended', () => removeLoopSource(records, record), { once: true });
    records.push(record);
  }

  function fadeAndStopLoopSources(records, fadeOutSeconds) {
    const nowSeconds = state.context?.currentTime ?? 0;
    for (const record of [...records]) {
      record.gain.gain.cancelScheduledValues(nowSeconds);
      record.gain.gain.setValueAtTime(fadeOutSeconds > 0 ? record.gain.gain.value : AUDIO_NUMERICS.silenceGain, nowSeconds);
      if (fadeOutSeconds > 0) record.gain.gain.linearRampToValueAtTime(AUDIO_NUMERICS.silenceGain, nowSeconds + fadeOutSeconds);
      try {
        record.source.stop(nowSeconds + fadeOutSeconds + ONE_SHOT_POLICY.sourceStopTailSeconds);
      } catch {
        removeLoopSource(records, record);
      }
    }
  }

  function removeLoopSource(records, record) {
    if (record.removed) return;
    record.removed = true;
    const index = records.indexOf(record);
    if (index >= 0) records.splice(index, 1);
    safeDisconnect(record.source);
    safeDisconnect(record.gain);
  }

  function syncSpatial(options = {}) {
    if (!state.context || !state.tumble.graph) return { updated: false, volume: getClipSettings('slime-tumble').volume };
    return syncTumbleSpatialGraph(
      state.tumble.graph,
      state.context,
      clock,
      positionProvider,
      getClipSettings('slime-tumble').volume,
      options,
    );
  }

  function setClipVolume(clipId, value, { smooth = true } = {}) {
    const volume = clipSettings.setVolume(clipId, value);
    if (clipId === 'env' && state.env.output) rampAudioParam(state.env.output.gain, volume, state.context, { smooth });
    if (clipId === 'slime-tumble' && state.tumble.graph) syncSpatial({ force: true, smooth });
    oneShots.rampVolumes(clipId, volume, state.context, smooth);
    return volume;
  }

  function setClipLoop(clipId, enabled) {
    return clipSettings.setLoop(clipId, enabled);
  }

  function setClipFadeIn(clipId, seconds) {
    return clipSettings.setFadeIn(clipId, seconds);
  }

  function setClipFadeOut(clipId, seconds) {
    return clipSettings.setFadeOut(clipId, seconds);
  }

  function getClipSettings(clipId) {
    return clipSettings.get(clipId);
  }

  function getSchedulerClock() {
    return schedulerClock ?? { now: () => state.context.currentTime * 1000 };
  }

  function clearTimer(section, timerKey) {
    const timerId = state[section][timerKey];
    if (timerId !== null) timers.clearInterval(timerId);
    state[section][timerKey] = null;
  }

  function getState() {
    const tumbleGraph = state.tumble.graph;
    const buffers = bufferStore.inspect();
    return {
      contextCreated: Boolean(state.context),
      contextState: state.context?.state ?? 'absent',
      masterRoute: state.masterRoute,
      graph: {
        oneShots: 'source>envelopeGain>volumeGain>master',
        env: 'source>crossfadeGain>envOutput>master',
        tumble: 'source>crossfadeGain>panner>fadeGain>distanceFilter>volumeGain>{dry,reverbSend>convolver>wet}>master',
        master: state.masterRoute === 'uninitialized'
          ? 'uninitialized'
          : state.masterRoute === 'compressor' ? 'master>compressor>destination' : 'master>destination',
      },
      compressor: { ...compressorSettings, nodeCreated: Boolean(state.compressor) },
      loadedPaths: buffers.loadedPaths,
      activeOneShots: oneShots.inspect(),
      env: {
        running: state.env.running,
        selectedPath: buffers.selectedEnvPath,
        scheduledSources: state.env.sources.length,
        sourcePlans: state.env.sources.map(({ startSeconds, stopSeconds }) => ({ startSeconds, stopSeconds })),
        nextStartSeconds: state.env.nextStartSeconds,
      },
      tumble: {
        running: state.tumble.running,
        scheduledSources: state.tumble.sources.length,
        sourcePlans: state.tumble.sources.map(({ startSeconds, stopSeconds, offsetSeconds }) => ({
          startSeconds, stopSeconds, offsetSeconds,
        })),
        nextStartSeconds: state.tumble.nextStartSeconds,
        graph: tumbleGraph ? {
          panningModel: tumbleGraph.panner.panningModel,
          distanceModel: tumbleGraph.panner.distanceModel,
          referenceDistance: tumbleGraph.referenceDistance,
          maximumDistance: tumbleGraph.farDistance,
          rolloffFactor: tumbleGraph.panner.rolloffFactor,
          lowpassType: tumbleGraph.distanceFilter.type,
          lowpassQ: tumbleGraph.distanceFilter.Q.value,
          hasStereoReverb: tumbleGraph.convolver.buffer?.numberOfChannels === 2,
          route: 'copyGain>panner>fadeGain>distanceFilter>volumeGain>{dry,reverbSend>convolver>wet}>master',
        } : null,
      },
      clipSettings: clipSettings.inspect(),
    };
  }

  return Object.freeze({
    ensureContext,
    unlockFromGesture,
    loadClipBuffer,
    preloadAll,
    schedulePreload,
    playOneShot,
    stopOneShots,
    startEnv,
    stopEnv,
    startTumble,
    stopTumble,
    syncSpatial,
    setClipVolume,
    setClipLoop,
    setClipFadeIn,
    setClipFadeOut,
    getClipSettings,
    setCompressorEnabled,
    setCompressorParam,
    getState,
    getContext: () => state.context,
  });
}
