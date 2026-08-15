import assert from 'node:assert/strict';
import test from 'node:test';
import { rampAudioParam, targetRampValue } from '../../src/audio/audio-param.js';
import {
  createStubPositionProvider,
  createTumbleSpatialGraph,
  makeTumbleReverbImpulse,
  resolveAudioSourceWorldPos,
  syncTumbleSpatialGraph,
} from '../../src/audio/spatial.js';
import { createVoicePool } from '../../src/audio/voice-pool.js';
import { FakeAudioContext } from '../fixtures/fake-audio.js';

test('35 ms target ramp follows the WebAudio exponential trajectory', () => {
  assert.equal(targetRampValue(0, 1, 0), 0);
  assert.ok(Math.abs(targetRampValue(0, 1, 0.035) - (1 - Math.exp(-1))) < 1e-12);
  assert.ok(Math.abs(targetRampValue(0, 1, 0.105) - (1 - Math.exp(-3))) < 1e-12);

  const calls = [];
  const audioParam = {
    value: 0.25,
    cancelScheduledValues: (...args) => calls.push(['cancel', ...args]),
    setValueAtTime: (...args) => calls.push(['set', ...args]),
    setTargetAtTime: (...args) => calls.push(['target', ...args]),
  };
  rampAudioParam(audioParam, 0.75, { currentTime: 4 });
  assert.deepEqual(calls, [
    ['cancel', 4],
    ['set', 0.25, 4],
    ['target', 0.75, 4, 0.035],
  ]);
});

test('voice pool caps each clip at 16 and steals equal-time voices oldest first', () => {
  let nowMilliseconds = 1000;
  const stolenIds = [];
  const pool = createVoicePool({
    clock: { now: () => nowMilliseconds },
    onSteal: (record, fadeSeconds) => stolenIds.push([record.id, fadeSeconds]),
  });

  for (let id = 0; id < 18; id++) {
    pool.admit('intro', { id, stopping: false, removed: false });
  }
  assert.equal(pool.activeForClip('intro').length, 16);
  assert.deepEqual(stolenIds, [[0, 0.025], [1, 0.025]]);
  assert.equal(pool.all().length, 18);

  nowMilliseconds += 1000;
  pool.admit('slime-fuse', { id: 'other', stopping: false, removed: false });
  assert.equal(pool.activeForClip('slime-fuse').length, 1);
});

test('audio position precedence is intro, weighted oats, initial hit, then target', () => {
  const base = {
    targetWorldPos: { x: 9, y: 8, z: 7 },
    initialHitWorldPos: { x: 6, y: 5, z: 4 },
    oats: [
      { worldPos: { x: 0, y: 0, z: 0 }, power: 1 },
      { worldPos: { x: 10, y: 20, z: 30 }, power: 3 },
    ],
  };
  assert.deepEqual(resolveAudioSourceWorldPos(base), { x: 7.5, y: 15, z: 22.5 });
  assert.deepEqual(resolveAudioSourceWorldPos({ ...base, introSpriteWorldPos: { x: 1, y: 2, z: 3 } }), { x: 1, y: 2, z: 3 });
  assert.deepEqual(resolveAudioSourceWorldPos({ ...base, oats: [] }), base.initialHitWorldPos);
  assert.deepEqual(resolveAudioSourceWorldPos({ ...base, oats: [], initialHitWorldPos: null }), base.targetWorldPos);
});

test('oat centroid preserves legacy minimum and invalid-power weights', () => {
  assert.deepEqual(resolveAudioSourceWorldPos({
    oats: [
      { worldPos: { x: 0, y: 0, z: 0 }, power: -10 },
      { worldPos: { x: 11, y: 0, z: 0 }, power: Number.NaN },
    ],
  }), { x: 10, y: 0, z: 0 });
});

test('spatial sync rate-limits updates and gates sub-epsilon movement', () => {
  const context = new FakeAudioContext();
  const provider = createStubPositionProvider();
  let nowMilliseconds = 0;
  const clock = { now: () => nowMilliseconds };
  const graph = createTumbleSpatialGraph(context, context.createGain(), {
    positionProvider: provider,
    volume: 0.5,
    random: () => 0.5,
  });

  syncTumbleSpatialGraph(graph, context, clock, provider, 0.5, { force: true, smooth: false });
  const initialPositionEventCount = graph.panner.positionX.events.length;
  syncTumbleSpatialGraph(graph, context, clock, provider, 0.5);
  provider.setSourceSnapshot({ introSpriteWorldPos: { x: 0.02, y: 0, z: 0 } });
  nowMilliseconds = 65;
  assert.equal(syncTumbleSpatialGraph(graph, context, clock, provider, 0.5).updated, false);
  nowMilliseconds = 66;
  syncTumbleSpatialGraph(graph, context, clock, provider, 0.5);
  assert.equal(
    graph.panner.positionX.events.length,
    initialPositionEventCount,
    '0.02 world units is below the 0.048 epsilon',
  );

  provider.setSourceSnapshot({ introSpriteWorldPos: { x: 0.1, y: 0, z: 0 } });
  nowMilliseconds = 132;
  syncTumbleSpatialGraph(graph, context, clock, provider, 0.5);
  assert.deepEqual(graph.panner.positionX.events.at(-1), {
    type: 'target', value: 0.1, time: 0, timeConstant: 0.045,
  });
});

test('procedural reverb is stereo with the anchored duration, decay, and early lift', () => {
  const context = new FakeAudioContext({ sampleRate: 100 });
  const impulse = makeTumbleReverbImpulse(context, () => 0.75);
  assert.equal(impulse.numberOfChannels, 2);
  assert.equal(impulse.length, 380);
  assert.ok(Math.abs(impulse.getChannelData(0)[0] - 0.0396) < 1e-7);
  assert.equal(impulse.getChannelData(0).at(-1), 0);
  assert.deepEqual(impulse.getChannelData(0), impulse.getChannelData(1));
});
