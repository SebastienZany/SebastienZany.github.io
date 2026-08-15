import assert from 'node:assert/strict';
import test from 'node:test';
import { CLIPS, getClip } from '../../src/audio/clips.js';

const EXPECTED_CLIPS = Object.freeze({
  intro: { gain: 1, maxGain: 2.1809, usedInGame: true },
  env: { gain: 2, maxGain: 15.5816, usedInGame: true },
  'slime-appear': { gain: 1, maxGain: 3.4979, usedInGame: false },
  'slime-appear-stretch': { gain: 2, maxGain: 4.1431, usedInGame: true },
  'slime-tumble': { gain: 0.5, maxGain: 1.9959, usedInGame: true },
  'slime-tumble-complete': { gain: 1, maxGain: 3.0304, usedInGame: false },
  'slime-fuse': { gain: 1, maxGain: 1.7083, usedInGame: true },
  'cuttlefish-reveal': { gain: 0.5, maxGain: 2.2347, usedInGame: true },
  'cuttlefish-camouflage': { gain: 1, maxGain: 1.6634, usedInGame: true },
  'text-reveal': { gain: 1, maxGain: 5.2462, usedInGame: false },
  'game-complete': { gain: 1, maxGain: 2.4264, usedInGame: false },
});

test('clip table is complete and preserves parity gains', () => {
  assert.deepEqual(CLIPS.map(({ id }) => id), Object.keys(EXPECTED_CLIPS));
  for (const clip of CLIPS) {
    const expected = EXPECTED_CLIPS[clip.id];
    assert.equal(clip.gain, expected.gain, `${clip.id} gain`);
    assert.equal(clip.maxGain, expected.maxGain, `${clip.id} maxGain`);
    assert.equal(clip.usedInGame, expected.usedInGame, `${clip.id} use classification`);
    assert.match(clip.path, /^\.\.\/shen-soundpack\/wav\/.+\.wav$/);
    assert.match(clip.legacyAnchor, /^main\.js:\d+/);
  }
});

test('scheduled loops carry their fallback, crop, and overlap metadata', () => {
  assert.equal(getClip('env').fallbackPath, '../shen-soundpack/wav/env-under-25mb.wav');
  assert.deepEqual(getClip('env').scheduledLoop, { kind: 'overlap-crossfade', crossfadeSeconds: 2.5 });
  assert.deepEqual(getClip('slime-tumble').scheduledLoop, {
    kind: 'crop-overlap-crossfade', cropStartSeconds: 8, crossfadeSeconds: 2,
  });
  assert.equal(getClip('missing'), null);
});
