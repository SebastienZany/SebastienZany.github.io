import assert from 'node:assert/strict';
import test from 'node:test';
import { HOTKEY_COMMANDS, createTripleTapStateMachine, routeHotkey } from '../../src/game/hotkeys.js';

test('hotkey routing table covers P/S/M/1/2/3', () => {
  assert.deepEqual(HOTKEY_COMMANDS, {
    p: 'togglePanels', s: 'skipIntro', m: 'toggleStories',
    1: 'toggleSlime', 2: 'toggleGoldBody', 3: 'toggleAgentDots',
  });
  for (const [key, commandName] of Object.entries(HOTKEY_COMMANDS)) {
    let routed = '';
    let prevented = false;
    assert.equal(routeHotkey({ key, preventDefault: () => { prevented = true; } }, { [commandName]: () => { routed = commandName; } }), true);
    assert.equal(routed, commandName);
    assert.equal(prevented, true);
  }
});

test('hotkeys are suppressed for fields, modifiers, and repeats', () => {
  let calls = 0;
  const commands = { togglePanels: () => { calls++; } };
  assert.equal(routeHotkey({ key: 'p', target: { tagName: 'INPUT' } }, commands), false);
  assert.equal(routeHotkey({ key: 'p', ctrlKey: true }, commands), false);
  assert.equal(routeHotkey({ key: 'p', repeat: true }, commands), false);
  assert.equal(calls, 0);
});

test('triple tap fires within 1200 ms and resets after firing', () => {
  let nowMs = 0;
  let toggles = 0;
  const gesture = createTripleTapStateMachine({ clock: { now: () => nowMs }, onTripleTap: () => { toggles++; } });
  for (const timeMs of [0, 500, 1199]) {
    nowMs = timeMs;
    gesture.pointerDown({ pointerId: 1, clientX: 4, clientY: 5 });
    gesture.pointerUp({ pointerId: 1, clientX: 4, clientY: 5 });
  }
  assert.equal(toggles, 1);
  assert.deepEqual(gesture.inspect().tapTimesMs, []);
});

test('a movement over 12 px or an expired first tap cancels the sequence', () => {
  let nowMs = 0;
  let toggles = 0;
  const gesture = createTripleTapStateMachine({ clock: { now: () => nowMs }, onTripleTap: () => { toggles++; } });
  const tap = (timeMs, endX = 0) => {
    nowMs = timeMs;
    gesture.pointerDown({ pointerId: 7, clientX: 0, clientY: 0 });
    gesture.pointerUp({ pointerId: 7, clientX: endX, clientY: 0 });
  };
  tap(0);
  tap(100, 12.01);
  tap(200);
  tap(300);
  assert.equal(toggles, 0);
  tap(400);
  assert.equal(toggles, 1);
  tap(1000);
  tap(2200);
  tap(2300);
  assert.equal(toggles, 1);
});
