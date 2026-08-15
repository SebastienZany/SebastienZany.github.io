import assert from 'node:assert/strict';
import test from 'node:test';
import { PARAMETER_DEFINITIONS } from '../../src/shared/params.js';
import {
  SURFACE_PARAM_BINDINGS,
  SURFACE_PARAM_CONTROLS,
  SURFACE_PARAM_NAMES,
} from '../../src/render/surface-params.js';

const CHECKLIST_SURFACE_PARAMS = [
  'smoothFieldDisplay', 'spatialSmoothing', 'temporalSmoothing', 'surfaceHeight',
  'surfaceBump', 'iridescenceStrength', 'slimeBaseColor', 'iridescenceMinThickness',
  'iridescenceThickness', 'filmThicknessCurve', 'filmFollowsSlimeHeight',
  'useGoldWaferFilm', 'useGoldWaferBody', 'goldBodyFade', 'goldBodyRoughness',
  'goldBodyReflectivity', 'goldBodyColor', 'lightBrightness', 'useIcosaFaceLights',
];

test('look-dev binding table covers the parity checklist Surface group exactly', () => {
  assert.deepEqual([...SURFACE_PARAM_NAMES].sort(), [...CHECKLIST_SURFACE_PARAMS].sort());
  assert.deepEqual(Object.keys(SURFACE_PARAM_BINDINGS).sort(), [...CHECKLIST_SURFACE_PARAMS].sort());
  assert.equal(new Set(SURFACE_PARAM_NAMES).size, CHECKLIST_SURFACE_PARAMS.length);
  for (const control of SURFACE_PARAM_CONTROLS) {
    assert.equal(control.parameter, PARAMETER_DEFINITIONS[control.parameterName]);
    assert.match(control.uniformTarget, /^(display|material)$/);
  }
});
