import assert from 'node:assert/strict';
import test from 'node:test';
import { FIXTURE_FORMAT, buildFixtureSet } from '../../tools/fixtures.mjs';

test('fixture generator emits every M2 analytic seam fixture', () => {
  const fixtures = buildFixtureSet();
  assert.deepEqual(Object.keys(fixtures).sort(), [
    'cylinder',
    'folded-quad-45',
    'folded-quad-80',
    'seam-quad',
    'thin-sheet',
    'three-chart-corner',
    'two-chart-sphere',
  ]);
  for (const fixture of Object.values(fixtures)) {
    assert.equal(fixture.format, FIXTURE_FORMAT);
    assert.equal(fixture.attributes.positions.length % 3, 0);
    assert.equal(fixture.attributes.uv.length / 2, fixture.attributes.positions.length / 3);
    assert.equal(fixture.indices.length % 3, 0);
    assert.equal(fixture.triangleChartIds.length, fixture.indices.length / 3);
    assert.ok(fixture.seams.length > 0);
  }
  assert.notEqual(fixtures['seam-quad'].attributes.uv[3], fixtures['seam-quad'].attributes.uv[13]);
  assert.equal(fixtures['folded-quad-80'].seams[0].foldAngleDegrees, 80);
  assert.equal(fixtures['three-chart-corner'].seams.length, 3);
  assert.equal(fixtures['thin-sheet'].seams[0].worldGap, 0.02);
});
