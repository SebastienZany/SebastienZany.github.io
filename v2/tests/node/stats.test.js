import assert from 'node:assert/strict';
import test from 'node:test';
import { createStatsModel } from '../../src/game/stats.js';
import { createHistoryRing, deriveHistorySeries } from '../../src/game/stats-history.js';

test('history ring keeps its newest samples in chronological order', () => {
  const ring = createHistoryRing(3);
  ring.push({ timeMs: 0, agentCount: 5 });
  ring.push({ timeMs: 100, agentCount: 7 });
  ring.push({ timeMs: 200, agentCount: 11 });
  ring.push({ timeMs: 300, agentCount: 13 });
  assert.equal(ring.length, 3);
  assert.deepEqual(ring.toArray(), [
    { timeMs: 100, agentCount: 7 },
    { timeMs: 200, agentCount: 11 },
    { timeMs: 300, agentCount: 13 },
  ]);
});

test('growth and smoothed acceleration use sample time deltas', () => {
  const series = deriveHistorySeries([
    { timeMs: 0, agentCount: 0 },
    { timeMs: 1000, agentCount: 10 },
    { timeMs: 2000, agentCount: 30 },
    { timeMs: 3000, agentCount: 70 },
  ]);
  assert.deepEqual(series.population, [0, 10, 30, 70]);
  assert.deepEqual(series.growth, [10, 20, 40]);
  assert.deepEqual(series.acceleration, [10, 12.8]);
});

test('stats requests expose opt-in and load-suppression flags to the provider', () => {
  let nowMs = 0;
  let enabled = true;
  const requests = [];
  const model = createStatsModel({
    clock: { now: () => nowMs },
    provider: {
      getReadbackEnabled: () => enabled,
      readStats(request) {
        requests.push(request);
        return { agentCount: 42, oatCount: 3, coverageFraction: 0.25, historyAgentCount: 42 };
      },
    },
  });

  nowMs = 650;
  model.frame({ nowMs, frameDurationMs: 1000 / 60 });
  assert.equal(requests[0].readbackEnabled, true);
  assert.equal(requests[0].readbackPermitted, true);
  assert.equal(model.getState().history.length, 1);

  nowMs = 1300;
  model.frame({ nowMs, frameDurationMs: 100 });
  assert.equal(requests[1].skipReadbackUnderLoad, true);
  assert.equal(requests[1].readbackPermitted, false);

  enabled = false;
  nowMs = 1950;
  model.frame({ nowMs, frameDurationMs: 1000 / 60 });
  assert.equal(requests[2].readbackEnabled, false);
  assert.equal(requests[2].readbackPermitted, false);
});
