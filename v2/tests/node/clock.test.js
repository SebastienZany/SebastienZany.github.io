import assert from 'node:assert/strict';
import test from 'node:test';
import { createClock } from '../../src/shared/clock.js';

test('clock changes scale without jumping', () => {
  let sourceNow = 100;
  const clock = createClock({ read: () => sourceNow });
  sourceNow = 125;
  assert.equal(clock.now(), 125);
  clock.timeScale = 4;
  sourceNow = 135;
  assert.equal(clock.now(), 165);
});

test('clock rejects a non-positive scale', () => {
  const clock = createClock({ read: () => 0 });
  assert.throws(() => { clock.timeScale = 0; }, /positive finite/);
});

