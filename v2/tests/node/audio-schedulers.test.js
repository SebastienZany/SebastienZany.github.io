import assert from 'node:assert/strict';
import test from 'node:test';
import { planEnvSchedule, planTumbleSchedule } from '../../src/audio/schedulers.js';

function fakeClock(initialMilliseconds = 0) {
  let nowMilliseconds = initialMilliseconds;
  return {
    now: () => nowMilliseconds,
    advance(milliseconds) { nowMilliseconds += milliseconds; },
  };
}

test('ambience lookahead pumps exact overlap times for ten minutes', () => {
  const clock = fakeClock();
  let nextStartSeconds;
  const scheduled = [];

  for (let second = 0; second <= 600; second++) {
    const plan = planEnvSchedule(clock, 30, { nextStartSeconds });
    scheduled.push(...plan.sources);
    nextStartSeconds = plan.nextStartSeconds;
    if (second < 600) clock.advance(1000);
  }

  assert.equal(scheduled.length, 23);
  assert.deepEqual(scheduled[0], {
    startSeconds: 0.05,
    offsetSeconds: 0,
    playDurationSeconds: 30,
    stopSeconds: 30.05,
    nodeStopSeconds: 30.1,
    gainAutomation: [
      { type: 'set', timeSeconds: 0.05, value: 1 },
      { type: 'set', timeSeconds: 27.55, value: 1 },
      { type: 'linear', timeSeconds: 30.05, value: 0.0001 },
    ],
  });
  assert.equal(scheduled[1].startSeconds, 27.55);
  assert.equal(scheduled.at(-1).startSeconds, 605.05);
  assert.equal(nextStartSeconds, 632.55);
});

test('tumble plans the post-crop tail with symmetric crossfade overlap', () => {
  const clock = fakeClock(10_000);
  const plan = planTumbleSchedule(clock, 20);

  assert.equal(plan.cropStartSeconds, 8);
  assert.equal(plan.loopDurationSeconds, 12);
  assert.equal(plan.crossfadeSeconds, 2);
  assert.equal(plan.intervalSeconds, 10);
  assert.equal(plan.sources.length, 2);
  assert.deepEqual(plan.sources[0], {
    startSeconds: 10.02,
    offsetSeconds: 8,
    playDurationSeconds: 12,
    stopSeconds: 22.02,
    nodeStopSeconds: 22.07,
    gainAutomation: [
      { type: 'set', timeSeconds: 10.02, value: 0.0001 },
      { type: 'linear', timeSeconds: 12.02, value: 1 },
      { type: 'set', timeSeconds: 20.02, value: 1 },
      { type: 'linear', timeSeconds: 22.02, value: 0.0001 },
    ],
  });
  assert.equal(plan.sources[1].startSeconds, 20.02);
});

test('scheduler validation rejects unusable durations and clocks', () => {
  assert.throws(() => planEnvSchedule({ now: () => 0 }, 0), /positive and finite/);
  assert.throws(() => planTumbleSchedule({ now: () => 0 }, 8), /after its crop/);
  assert.throws(() => planEnvSchedule({}, 20), /clock must expose/);
});
