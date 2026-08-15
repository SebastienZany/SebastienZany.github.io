import assert from 'node:assert/strict';
import test from 'node:test';
import {
  crowdProfileResidual,
  legacyCrowdProfile,
  realizedCrowdProfile,
} from '../../src/sim/crowd-profile.js';

const SIZE = 65;
const CENTER = 32;
const phases = [0.05, 0.25, 0.5, 0.75, 0.95];

test('realized crowd kernel profile matches phase, reserve amplitude, and slider regimes', () => {
  for (const densityBlur of [1, 30, 64]) {
    for (const phase of phases) {
      const agents = [{ texelX: CENTER + phase, texelY: CENTER + 0.37, reserve: 5.25 }];
      assertProfile(densityBlur, agents, `single phase=${phase}`);
    }
    assertProfile(densityBlur, [
      { texelX: CENTER + 0.13, texelY: CENTER - 1.62, reserve: 2.5 },
      { texelX: CENTER - 1.27, texelY: CENTER + 0.44, reserve: 6.75 },
      { texelX: CENTER + 1.61, texelY: CENTER + 1.28, reserve: 4 },
    ], 'reserve-weighted superposition');
  }
});

function assertProfile(densityBlur, agents, scenario) {
  const reference = legacyCrowdProfile({ size: SIZE, agents, densityBlur });
  const realized = realizedCrowdProfile({ size: SIZE, agents, densityBlur });
  const residual = crowdProfileResidual(reference, realized);
  // The replacement preserves total mass and second moment; this tolerance admits
  // the deliberate Gaussian-vs-disc shape delta while rejecting radius, phase,
  // reserve, or superposition mistakes. `plot` is retained in assertion output.
  assert.ok(
    residual.normalizedRmse <= 0.045 && residual.normalizedMax <= 0.65,
    JSON.stringify({ densityBlur, scenario, ...residual, plot: residual.plot.slice(0, 80) }, null, 2),
  );
}
