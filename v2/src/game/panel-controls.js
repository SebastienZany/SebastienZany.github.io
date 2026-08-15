import { PARAMETER_DEFINITIONS } from '../shared/params.js';

// The order and grouping are the UI contract from parity-checklist §2. Values,
// ranges, and input types are projected below from the shared parameter table.
const GROUP_PARAMETER_NAMES = Object.freeze([
  ['agents', 'Agents', ['uptakeRate', 'depositRate', 'burnRate', 'reproThreshold', 'stepSize']],
  ['steering', 'Steering', ['foodWeight', 'crowdWeight', 'crowdExponent', 'densityBlur', 'densityTarget', 'minMoveScale']],
  ['field', 'Field', [
    'fieldDecay', 'simulationSteps', 'foodClamp', 'oatPower', 'oatSupplyRate', 'useOatRationing',
  ]],
  ['population', 'Population', [
    'usePopulationControl', 'populationTarget', 'populationLambda', 'populationSupplyLogGain',
    'populationOatSupplyMin', 'populationOatSupplyMax', 'populationUseSecondaryActuator',
  ]],
  ['surface', 'Surface', [
    'smoothFieldDisplay', 'spatialSmoothing', 'temporalSmoothing', 'surfaceHeight', 'surfaceBump',
    'iridescenceStrength', 'slimeBaseColor', 'iridescenceMinThickness', 'iridescenceThickness',
    'filmThicknessCurve', 'filmFollowsSlimeHeight', 'useGoldWaferFilm', 'useGoldWaferBody',
    'goldBodyFade', 'goldBodyRoughness', 'goldBodyReflectivity', 'goldBodyColor', 'lightBrightness',
    'useIcosaFaceLights',
  ]],
  ['stories', 'Story labels', [
    'storyBoxesEnabled', 'observationTailLength', 'observationStrokeOpacity',
    'observationCornerRadius', 'observationEdgeFeather', 'observationBlurRadius',
    'observationTintColor', 'observationTintOpacity', 'observationSlimeTriggerThreshold',
  ]],
  ['visibility', 'Visibility', ['endingTimeLimitEnabled', 'showOats', 'showAgentDots', 'meshOutlineEnabled', 'showWireframe']],
  ['debug', 'Debug', ['useSeamStitching', 'useIslandMasking', 'useHeadingRotation', 'useOpticalZoom', 'statsReadbackEnabled', 'debugView']],
]);

// Help copy is intentionally new prose. Anchored values live only in params.js.
export const PANEL_STRINGS = Object.freeze({
  uptakeRate: ['Uptake', 'Food reserve absorbed from the field on each simulation step.', { scale: 100, suffix: '%', digits: 1 }],
  depositRate: ['Deposit', 'Trail field left behind by an agent on each step.', { scale: 100, digits: 1 }],
  burnRate: ['Burn', 'Reserve consumed by an agent to remain alive.', { scale: 100, digits: 1 }],
  reproThreshold: ['Birth reserve', 'Reserve level at which an agent can reproduce.'],
  stepSize: ['Speed', 'Base distance travelled per step in atlas UV space.', { scale: 10000, digits: 1 }],
  foodWeight: ['Food pull', 'Steering influence of nearby food.'],
  crowdWeight: ['Crowding', 'Steering penalty for density above the preferred level.'],
  crowdExponent: ['Crowd curve', 'Shape of the above-target crowding response.', { digits: 2 }],
  densityBlur: ['Crowd radius', 'Neighborhood size used to build the sensed crowd field.'],
  densityTarget: ['Ideal density', 'Preferred local population density.'],
  minMoveScale: ['Minimum speed', 'Smallest fraction of the base step a living agent may move.', { scale: 100, suffix: '%', digits: 0 }],
  fieldDecay: ['Field retention', 'Fraction of the trail field retained after one update.', { scale: 100, suffix: '%', digits: 1 }],
  simulationSteps: ['Steps', 'Simulation updates performed for each rendered frame.', { digits: 0 }],
  foodClamp: ['Food maximum', 'Upper bound of the food field and the top of the film mapping.', { digits: 2 }],
  oatPower: ['Oat food', 'Peak food influence supplied by every oat; changes refresh existing oats.'],
  oatSupplyRate: ['Oat supply', 'Shared amount available to agents feeding near an oat.', { digits: 3 }],
  useOatRationing: ['Ration oats', 'Share an oat supply budget among its nearby agents.'],
  usePopulationControl: ['Control population', 'Regulate oat supply toward a target population; enabling this also enables rationing.'],
  populationTarget: ['Target', 'Desired live-agent count for population control.', { digits: 0 }],
  populationLambda: ['Lambda', 'Rate at which the controller aims to remove log-population error.', { digits: 3 }],
  populationSupplyLogGain: ['Supply gain', 'Log-space correction applied to the oat supply.', { digits: 2 }],
  populationOatSupplyMin: ['Supply minimum', 'Lowest oat supply the controller may command.', { digits: 4 }],
  populationOatSupplyMax: ['Supply maximum', 'Highest oat supply the controller may command.', { digits: 2 }],
  populationUseSecondaryActuator: ['Secondary control', 'Permit birth and burn controls to assist after sustained overshoot.'],
  smoothFieldDisplay: ['Smooth field', 'Filter the displayed field instead of showing its raw texel facets.'],
  spatialSmoothing: ['Spatial blur', 'Radius of the iterated display-field smoothing.', { digits: 2 }],
  temporalSmoothing: ['Temporal blend', 'Contribution retained from the previous displayed field.', { scale: 100, suffix: '%', digits: 0 }],
  surfaceHeight: ['Height', 'Scale of the height field used for the slime surface.'],
  surfaceBump: ['Bump', 'Strength of the surface-normal perturbation.', { digits: 1 }],
  iridescenceStrength: ['Iridescence', 'Blend strength of the thin-film colour response.', { scale: 100, suffix: '%', digits: 0 }],
  slimeBaseColor: ['Body colour', 'Base colour beneath the iridescent film; also colours observation text.'],
  iridescenceMinThickness: ['Minimum film', 'Lower thin-film thickness when height following is active.', { suffix: 'nm', digits: 0 }],
  iridescenceThickness: ['Maximum film', 'Upper thin-film thickness used by the colour bands.', { suffix: 'nm', digits: 0 }],
  filmThicknessCurve: ['Film curve', 'Nonlinear mapping from slime height to film thickness.', { digits: 2 }],
  filmFollowsSlimeHeight: ['Film follows height', 'Vary film thickness with the local slime field.'],
  useGoldWaferFilm: ['Gold wafer film', 'Use the baked gold optical lookup for the film.'],
  useGoldWaferBody: ['Gold wafer body', 'Reveal the remembered gold body beneath the slime.'],
  goldBodyFade: ['Gold fade', 'Food-history range over which the gold body fades in.', { scale: 100, suffix: '%', digits: 0 }],
  goldBodyRoughness: ['Roughness', 'Surface roughness of the gold body.', { scale: 100, suffix: '%', digits: 0 }],
  goldBodyReflectivity: ['Reflectivity', 'Reflection strength of the gold body.', { scale: 100, suffix: '%', digits: 0 }],
  goldBodyColor: ['Gold base', 'Base colour underneath the gold optical response.'],
  lightBrightness: ['Brightness', 'Intensity multiplier for the icosahedral light rig.', { scale: 100, suffix: '%', digits: 0 }],
  useIcosaFaceLights: ['Extra lights', 'Switch between the 12-vertex and 32-face light rigs.'],
  storyBoxesEnabled: ['Story boxes', 'Show observation labels when oats meet their slime trigger.'],
  observationTailLength: ['Tail length', 'Screen-space distance between an oat and its label.', { scale: 100, suffix: '%', digits: 0 }],
  observationStrokeOpacity: ['Tail opacity', 'Opacity shared by the label border and tail.', { scale: 100, suffix: '%', digits: 0 }],
  observationCornerRadius: ['Corner radius', 'Roundness of observation-label corners.', { suffix: 'px', digits: 0 }],
  observationEdgeFeather: ['Edge feather', 'Soft extent around the observation-label glass.', { suffix: 'px', digits: 0 }],
  observationBlurRadius: ['Blur radius', 'Backdrop blur used by observation labels.', { suffix: 'px', digits: 0 }],
  observationTintColor: ['Tint colour', 'Colour of the observation-label glass.'],
  observationTintOpacity: ['Tint strength', 'Opacity of the observation-label tint.', { scale: 100, suffix: '%', digits: 0 }],
  observationSlimeTriggerThreshold: ['Story trigger', 'Local slime value required to reveal an observation.', { digits: 2 }],
  endingTimeLimitEnabled: ['Time limit', 'Allow the optional timed ending sequence.'],
  showOats: ['Oat glow', 'Draw the glowing oat markers.'],
  showAgentDots: ['Agent dots', 'Draw individual agents over the surface.'],
  meshOutlineEnabled: ['Mesh outline', 'Draw the outside silhouette of the mesh.'],
  showWireframe: ['Wireframe', 'Overlay the mesh triangle edges.'],
  useSeamStitching: ['Gutter fill', 'Enable the v2 seam-safe gutter display path.'],
  useIslandMasking: ['Atlas domain', 'Restrict field work to the baked atlas domain.'],
  useHeadingRotation: ['Heading transport', 'Rotate agent headings as they cross chart seams.'],
  useOpticalZoom: ['Optical zoom', 'Change camera field of view instead of dollying.'],
  statsReadbackEnabled: ['Stats readback', 'Opt in to throttled GPU-derived statistics when frame load permits.'],
  debugView: ['Debug view', 'Choose the surface field or atlas diagnostic to display.'],
});

function projectControl(parameterName) {
  const definition = PARAMETER_DEFINITIONS[parameterName];
  const [label, help, format = {}] = PANEL_STRINGS[parameterName] ?? [];
  if (!definition || !label || !help) throw new Error(`Incomplete panel control: ${parameterName}`);
  const widget = definition.type === 'number'
    ? (parameterName === 'populationTarget' ? 'number' : 'range')
    : definition.type === 'boolean' ? 'checkbox'
      : definition.type === 'choice' ? 'select' : definition.type;
  return Object.freeze({
    parameterName,
    label,
    help,
    widget,
    default: definition.default,
    min: definition.min ?? null,
    max: definition.max ?? null,
    step: definition.step ?? null,
    choices: definition.values ?? null,
    format: Object.freeze({ ...format }),
  });
}

export const PANEL_GROUPS = Object.freeze(GROUP_PARAMETER_NAMES.map(([id, label, parameterNames]) => Object.freeze({
  id,
  label,
  controls: Object.freeze(parameterNames.map(projectControl)),
})));

export const PANEL_CONTROLS = Object.freeze(PANEL_GROUPS.flatMap(({ controls }) => controls));
export const PANEL_PARAMETER_NAMES = Object.freeze(PANEL_CONTROLS.map(({ parameterName }) => parameterName));
