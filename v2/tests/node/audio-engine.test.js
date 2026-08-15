import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contextTimeToPerformanceMilliseconds,
  createAudioEngine,
  performanceMillisecondsToContextTime,
} from '../../src/audio/engine.js';
import { FakeAudioContext, createFakeTimers, successfulFetch } from '../fixtures/fake-audio.js';

function harness(contextOptions = {}) {
  let nowMilliseconds = 0;
  const context = new FakeAudioContext(contextOptions);
  const timers = createFakeTimers();
  const engine = createAudioEngine({
    clock: { now: () => nowMilliseconds },
    createContext: () => context,
    fetchResource: successfulFetch,
    timers,
    random: () => 0.75,
    logger: { warn() {} },
  });
  return { context, engine, timers, setNow(value) { nowMilliseconds = value; } };
}

test('context is lazy, gesture unlock resumes synchronously, and compressor rewires master', async () => {
  const { context, engine } = harness();
  assert.equal(engine.getState().contextCreated, false);

  const unlocked = engine.unlockFromGesture();
  assert.equal(context.resumeCalls, 1, 'resume is invoked before unlockFromGesture returns');
  await unlocked;
  assert.equal(engine.getState().masterRoute, 'destination');

  engine.setCompressorEnabled(true);
  assert.deepEqual(engine.getState().compressor, {
    enabled: true, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25,
    legacyAnchor: 'main.js:222-236,8842-8876', nodeCreated: true,
  });
  assert.equal(engine.getState().masterRoute, 'compressor');
  assert.equal(engine.setCompressorParam('ratio', 40), 20);
  engine.setCompressorEnabled(false);
  assert.equal(engine.getState().masterRoute, 'destination');
});

test('preloading decodes while leaving a suspended context locked', async () => {
  const context = new FakeAudioContext({ decodeDurations: [30] });
  const engine = createAudioEngine({
    clock: { now: () => 0 },
    createContext: () => context,
    fetchResource: successfulFetch,
    timers: createFakeTimers(),
    logger: { warn() {} },
  });
  await engine.loadClipBuffer('intro', { resumeContext: false });
  assert.equal(context.state, 'suspended');
  assert.equal(context.resumeCalls, 0);
});

test('env fallback is sticky and warned once', async () => {
  const context = new FakeAudioContext({ decodeDurations: [30] });
  const requests = [];
  const warnings = [];
  const engine = createAudioEngine({
    clock: { now: () => 0 },
    createContext: () => context,
    fetchResource: async (path) => {
      requests.push(path);
      return path.endsWith('/env.wav')
        ? { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
        : { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
    },
    timers: createFakeTimers(),
    logger: { warn: (...args) => warnings.push(args) },
  });
  await engine.loadClipBuffer('env');
  await engine.loadClipBuffer('env');
  assert.deepEqual(requests, [
    '../shen-soundpack/wav/env.wav',
    '../shen-soundpack/wav/env-under-25mb.wav',
  ]);
  assert.equal(warnings.length, 1);
  assert.equal(engine.getState().env.selectedPath, '../shen-soundpack/wav/env-under-25mb.wav');
});

test('engine one-shots enforce the per-clip voice cap and oldest steal fade', async () => {
  const { context, engine, setNow } = harness({ decodeDurations: [2] });
  for (let voice = 0; voice < 17; voice++) {
    context.currentTime = voice;
    setNow(voice * 1000);
    await engine.playOneShot('slime-fuse');
  }
  const oneShots = engine.getState().activeOneShots;
  assert.equal(oneShots.filter(({ stopping }) => !stopping).length, 16);
  assert.equal(oneShots[0].stopping, true);
  const sources = context.createdNodes.filter(({ kind }) => kind === 'bufferSource');
  assert.ok(Math.abs(sources[0].stopCalls.at(-1)[0] - 16.045) < 1e-12);
});

test('env and tumble build and schedule their real node graphs', async () => {
  const { context, engine, timers } = harness({ decodeDurations: [30, 20] });
  await engine.startEnv();
  assert.equal(engine.getState().env.scheduledSources, 1);
  assert.equal(engine.getState().env.nextStartSeconds, 27.55);

  const firstTumbleStart = engine.startTumble({ fadeInSeconds: 0 });
  const duplicateTumbleStart = engine.startTumble({ fadeInSeconds: 0 });
  assert.equal(duplicateTumbleStart, firstTumbleStart);
  await firstTumbleStart;
  const tumble = engine.getState().tumble;
  assert.equal(tumble.scheduledSources, 2);
  assert.deepEqual(tumble.graph, {
    panningModel: 'HRTF',
    distanceModel: 'inverse',
    referenceDistance: 4,
    maximumDistance: 22.4,
    rolloffFactor: 4.8,
    lowpassType: 'lowpass',
    lowpassQ: 0.55,
    hasStereoReverb: true,
    route: 'copyGain>panner>fadeGain>distanceFilter>volumeGain>{dry,reverbSend>convolver>wet}>master',
  });
  assert.deepEqual([...timers.intervals.values()].map(({ delay }) => delay).sort((a, b) => a - b), [66, 1000, 1000]);
  const tumbleSources = context.createdNodes.filter(({ kind, startCalls }) => kind === 'bufferSource' && startCalls[0]?.length === 3);
  assert.deepEqual(tumbleSources.map(({ startCalls }) => startCalls[0]), [[0.02, 8, 12], [10.02, 8, 12]]);
});

test('output timestamps map both directions and fallback to the injected clock', () => {
  const timestamped = new FakeAudioContext({ outputTimestamp: { contextTime: 5, performanceTime: 10_000 } });
  timestamped.currentTime = 4;
  const clock = { now: () => 20_000 };
  assert.equal(performanceMillisecondsToContextTime(timestamped, clock, 12_000), 7);
  assert.equal(contextTimeToPerformanceMilliseconds(timestamped, clock, 8), 13_000);

  timestamped.outputTimestamp = null;
  assert.equal(performanceMillisecondsToContextTime(timestamped, clock, 21_000), 5);
  assert.equal(contextTimeToPerformanceMilliseconds(timestamped, clock, 6), 22_000);
});
