// Smoke test: `node src/audio/smoke-test.mjs`
// Runs the engine against a fake AudioContext to check that the module loads,
// the API matches docs/CONTRACTS.md, and nothing throws in the awkward cases
// (no WebAudio, calls before unlock/load, a failed fetch). It cannot hear
// anything: timing and sound quality need a real browser.

import assert from 'node:assert/strict';
import { createAudio } from './index.js';
import { CLIPS, ONE_SHOT } from './audio.config.js';

const calls = []; // everything interesting the fakes were asked to do

function fakeParam(value = 0) {
  return {
    value,
    setValueAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v) { this.value = v; },
    setTargetAtTime(v) { this.value = v; },
    cancelScheduledValues() {},
  };
}

function fakeNode(kind, extra = {}) {
  return {
    kind,
    connect(target) { calls.push(['connect', kind, target.kind]); },
    disconnect() {},
    ...extra,
  };
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.state = 'suspended';
    this.destination = fakeNode('destination');
    this.listener = {
      positionX: fakeParam(), positionY: fakeParam(), positionZ: fakeParam(),
      forwardX: fakeParam(), forwardY: fakeParam(), forwardZ: fakeParam(),
      upX: fakeParam(), upY: fakeParam(), upZ: fakeParam(),
    };
    FakeAudioContext.instances.push(this);
  }
  resume() { this.state = 'running'; calls.push(['resume']); return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: performance.now() }; }
  createGain() { return fakeNode('gain', { gain: fakeParam(1) }); }
  createBiquadFilter() { return fakeNode('filter', { frequency: fakeParam(350), Q: fakeParam(1) }); }
  createConvolver() { return fakeNode('convolver'); }
  createDynamicsCompressor() { return fakeNode('compressor'); }
  createPanner() {
    return fakeNode('panner', { positionX: fakeParam(), positionY: fakeParam(), positionZ: fakeParam() });
  }
  createBuffer(channels, length) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, getChannelData: (c) => data[c] };
  }
  createBufferSource() {
    const listeners = [];
    const source = fakeNode('source', {
      addEventListener(_type, fn) { listeners.push(fn); },
      start(when, offset, duration) { calls.push(['start', source.buffer.name, when, offset, duration]); },
      stop(when) { calls.push(['stop', source.buffer.name, when]); },
      end() { listeners.forEach((fn) => fn()); },
    });
    FakeAudioContext.sources.push(source);
    return source;
  }
  decodeAudioData(arrayBuffer) {
    return Promise.resolve({ name: arrayBuffer.name, duration: arrayBuffer.durationSec });
  }
}
FakeAudioContext.instances = [];
FakeAudioContext.sources = [];

const DURATIONS_SEC = { 'slime-tumble': 24, 'env-under-25mb': 140 };
function fakeFetch(url) {
  const name = url.split('/').pop().replace('.wav', '');
  if (name === 'text-reveal') return Promise.resolve({ ok: false, status: 404 });
  return Promise.resolve({
    ok: true,
    arrayBuffer: async () => ({ name, durationSec: DURATIONS_SEC[name] ?? 2 }),
  });
}

const logs = [];
const makeCtx = () => ({
  diag: { log: (tag, detail) => logs.push(`${tag} ${detail ?? ''}`) },
  camera: null,
  cameraRig: { controls: { maxDistance: 22.4 } },
});
const camera = {
  position: { x: 0, y: 0, z: 10 },
  matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1] },
  updateMatrixWorld() {},
};
const frame = { camera, sourcePosition: { x: 1, y: 0, z: 0 }, referenceDistance: 10 };
const API = ['unlockFromGesture', 'preload', 'isReady', 'durationMs', 'playOneShot', 'startEnvLoop',
  'stopEnvLoop', 'startTumbleLoop', 'stopTumbleLoop', 'stopAll', 'update', 'dispose'];

function exerciseEverything(audio) {
  audio.unlockFromGesture();
  audio.playOneShot('intro', { atMs: performance.now() + 100 });
  audio.playOneShot('no-such-clip');
  audio.startEnvLoop();
  audio.startTumbleLoop({ fadeInMs: 100 });
  audio.update(0, frame);
  audio.update(100, { camera: null, sourcePosition: null });
  audio.update(200);
  audio.stopEnvLoop();
  audio.stopTumbleLoop({ fadeMs: 1200 });
  audio.stopAll();
}

// 1. No WebAudio at all: everything is a quiet no-op.
{
  const audio = createAudio(makeCtx());
  assert.deepEqual(Object.keys(audio).sort(), [...API].sort(), 'API surface matches the contract');
  exerciseEverything(audio);
  await audio.preload(['intro']);
  assert.equal(audio.isReady('intro'), false);
  assert.equal(audio.durationMs('intro'), null);
  assert.equal(audio.playOneShot('intro'), null);
  audio.dispose();
  assert.ok(logs.some((line) => line.startsWith('audio:unavailable')), 'the missing WebAudio is logged');
}

globalThis.AudioContext = FakeAudioContext;
globalThis.fetch = fakeFetch;

// 2. Calls before unlock and before any clip has loaded.
{
  const audio = createAudio(makeCtx());
  assert.equal(audio.playOneShot('slime-fuse'), null, 'an undecoded clip does not play');
  audio.update(0, frame);
  audio.stopAll();
  audio.stopTumbleLoop();
  audio.dispose();
}

// 3. The normal path.
{
  const audio = createAudio(makeCtx());
  await audio.preload(Object.keys(CLIPS)); // includes text-reveal, which 404s
  const context = FakeAudioContext.instances.at(-1);
  assert.equal(context.state, 'suspended', 'preloading does not need (or fake) a gesture');
  assert.equal(audio.isReady('intro'), true);
  assert.equal(audio.isReady('text-reveal'), false);
  assert.equal(audio.durationMs('intro'), 2000);
  assert.equal(audio.playOneShot('text-reveal'), null);

  calls.length = 0;
  audio.unlockFromGesture();
  assert.deepEqual(calls[0], ['resume'], 'unlock resumes synchronously');

  const voice = audio.playOneShot('intro', { atMs: performance.now() + 500 });
  assert.equal(typeof voice.stop, 'function');
  const introStart = calls.find((call) => call[0] === 'start' && call[1] === 'intro');
  assert.ok(Math.abs(introStart[2] - 0.5) < 0.05, `atMs maps onto the audio clock (${introStart[2]})`);
  voice.stop({ fadeMs: 0 });
  voice.stop(); // stopping twice is harmless

  // Voice stealing: the 17th overlapping voice stops the oldest.
  calls.length = 0;
  for (let i = 0; i < ONE_SHOT.maxVoicesPerClip + 1; i++) audio.playOneShot('cuttlefish-reveal');
  assert.equal(calls.filter((call) => call[0] === 'start').length, ONE_SHOT.maxVoicesPerClip + 1);
  assert.equal(calls.filter((call) => call[0] === 'stop').length, 1);

  // Env loop: 140 s file, 2.5 s overlap, 12 s lookahead -> one copy queued.
  calls.length = 0;
  audio.startEnvLoop();
  audio.startEnvLoop(); // a second start is ignored
  const envStarts = calls.filter((call) => call[0] === 'start');
  assert.equal(envStarts.length, 1);
  assert.ok(Math.abs(envStarts[0][2] - 0.05) < 1e-9, 'env starts 50 ms ahead');

  // Tumble loop: 24 s file cropped at 8 s -> 16 s copies every 14 s.
  calls.length = 0;
  audio.update(0, frame);
  audio.startTumbleLoop({ fadeInMs: 3460 });
  const tumbleStarts = calls.filter((call) => call[0] === 'start');
  assert.equal(tumbleStarts.length, 1);
  assert.deepEqual(tumbleStarts[0].slice(3), [8, 16], 'copies play the cropped region');
  assert.ok(calls.some((call) => call[1] === 'panner' && call[2] === 'gain'), 'spatial chain is wired');
  context.currentTime = 3;
  await new Promise((resolve) => setTimeout(resolve, 1100)); // one pump
  const queued = calls.filter((call) => call[0] === 'start' && call[1] === 'slime-tumble');
  assert.equal(queued.length, 2, 'the pump queues the next copy');
  assert.ok(Math.abs(queued[1][2] - queued[0][2] - 14) < 1e-9, 'copies are one interval apart');

  for (let ms = 0; ms < 1000; ms += 16) audio.update(ms, frame);
  audio.update(2000, { camera, sourcePosition: null, referenceDistance: 10 });

  audio.stopAll({ fadeMs: 200 });
  FakeAudioContext.sources.forEach((source) => source.end());
  audio.dispose();
  audio.playOneShot('intro'); // after dispose: still must not throw
  assert.equal(context.state, 'closed');
}

assert.ok(!logs.some((line) => /-failed/.test(line) && !line.startsWith('audio:load-failed')),
  `no unexpected failures were logged:\n${logs.join('\n')}`);
console.log(`audio smoke test passed (${logs.length} diagnostic lines)`);
