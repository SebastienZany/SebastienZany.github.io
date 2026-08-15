import assert from 'node:assert/strict';
import test from 'node:test';
import { PANEL_CONTROLS, PANEL_GROUPS, PANEL_PARAMETER_NAMES } from '../../src/game/panel-controls.js';
import { createPanelModel } from '../../src/game/panel-model.js';
import { PARAMETER_DEFINITIONS, SIMULATION_PRESETS, createParams } from '../../src/shared/params.js';

const CHECKLIST_GROUPS = Object.freeze({
  agents: ['uptakeRate', 'depositRate', 'burnRate', 'reproThreshold', 'stepSize'],
  steering: ['foodWeight', 'crowdWeight', 'crowdExponent', 'densityBlur', 'densityTarget', 'minMoveScale'],
  field: ['fieldDecay', 'simulationSteps', 'foodClamp', 'oatPower', 'oatSupplyRate', 'useOatRationing'],
  population: ['usePopulationControl', 'populationTarget', 'populationLambda', 'populationSupplyLogGain', 'populationOatSupplyMin', 'populationOatSupplyMax', 'populationUseSecondaryActuator'],
  surface: ['smoothFieldDisplay', 'spatialSmoothing', 'temporalSmoothing', 'surfaceHeight', 'surfaceBump', 'iridescenceStrength', 'slimeBaseColor', 'iridescenceMinThickness', 'iridescenceThickness', 'filmThicknessCurve', 'filmFollowsSlimeHeight', 'useGoldWaferFilm', 'useGoldWaferBody', 'goldBodyFade', 'goldBodyRoughness', 'goldBodyReflectivity', 'goldBodyColor', 'lightBrightness', 'useIcosaFaceLights'],
  stories: ['storyBoxesEnabled', 'observationTailLength', 'observationStrokeOpacity', 'observationCornerRadius', 'observationEdgeFeather', 'observationBlurRadius', 'observationTintColor', 'observationTintOpacity', 'observationSlimeTriggerThreshold'],
  visibility: ['endingTimeLimitEnabled', 'showOats', 'showAgentDots', 'meshOutlineEnabled', 'showWireframe'],
  debug: ['useSeamStitching', 'useIslandMasking', 'useHeadingRotation', 'useOpticalZoom', 'statsReadbackEnabled', 'debugView'],
});

test('panel is a complete, drift-free projection of checklist section 2c', () => {
  assert.deepEqual(Object.fromEntries(PANEL_GROUPS.map(({ id, controls }) => [id, controls.map(({ parameterName }) => parameterName)])), CHECKLIST_GROUPS);
  assert.equal(new Set(PANEL_PARAMETER_NAMES).size, PANEL_PARAMETER_NAMES.length);
  for (const control of PANEL_CONTROLS) {
    const definition = PARAMETER_DEFINITIONS[control.parameterName];
    assert.ok(definition, `missing shared definition for ${control.parameterName}`);
    assert.deepEqual(
      { default: control.default, min: control.min, max: control.max, step: control.step },
      { default: definition.default, min: definition.min ?? null, max: definition.max ?? null, step: definition.step ?? null },
      `${control.parameterName} drifted from params.js`,
    );
    assert.ok(control.help.length > 0, `${control.parameterName} has no help string`);
  }
});

test('stable-medium applies its exact full vector and a subsequent edit marks it custom', () => {
  const patches = [];
  const model = createPanelModel({ onPatch: (patch, context) => patches.push({ patch, context }) });
  const expected = SIMULATION_PRESETS.find(({ id }) => id === 'stable-medium').values;
  model.applySimulationPreset('stable-medium');
  assert.equal(model.getState().simulationPresetId, 'stable-medium');
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((key) => [key, model.getState().params[key]])), expected);
  assert.deepEqual(patches[0].patch, expected);

  model.setParam('burnRate', 0.019);
  assert.equal(model.getState().params.burnRate, 0.019);
  assert.equal(model.getState().simulationPresetId, 'custom');
});

test('population control forces oat rationing without changing unrelated values', () => {
  const model = createPanelModel({ values: createParams({ useOatRationing: false }) });
  model.setParam('usePopulationControl', true);
  assert.equal(model.getState().params.usePopulationControl, true);
  assert.equal(model.getState().params.useOatRationing, true);
  assert.equal(model.getState().params.surfaceHeight, createParams().surfaceHeight);
});

