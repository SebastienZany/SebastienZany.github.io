import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticFieldValue } from '../../src/shared/field-provider.js';

test('synthetic field is deterministic, bounded, and visibly structured', () => {
  const sample = syntheticFieldValue(0.25, 0.5, 0.75);
  assert.equal(sample, syntheticFieldValue(0.25, 0.5, 0.75));
  assert.ok(sample >= 0 && sample <= 1);
  assert.notEqual(sample, syntheticFieldValue(0.8, 0.2, 0.75));
});

