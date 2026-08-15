import assert from 'node:assert/strict';
import test from 'node:test';
import { FIXTURE_FORMAT, buildFixtureSet } from '../../tools/fixtures.mjs';

test('fixture generator emits the three day-one packed-asset stubs', () => {
  const fixtures = buildFixtureSet();
  assert.deepEqual(Object.keys(fixtures).sort(), ['cylinder', 'seam-quad', 'two-chart-sphere']);
  for (const fixture of Object.values(fixtures)) {
    assert.equal(fixture.format, FIXTURE_FORMAT);
    assert.equal(fixture.attributes.positions.length % 3, 0);
    assert.equal(fixture.attributes.uv.length / 2, fixture.attributes.positions.length / 3);
    assert.equal(fixture.indices.length % 3, 0);
    assert.equal(fixture.triangleChartIds.length, fixture.indices.length / 3);
    assert.ok(fixture.seams.length > 0);
  }
  assert.notEqual(fixtures['seam-quad'].attributes.uv[3], fixtures['seam-quad'].attributes.uv[13]);
});

