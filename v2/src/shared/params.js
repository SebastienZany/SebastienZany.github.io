// Data extraction anchors:
// - base values and both preset tables: main.js:325–529
// - effective params and referenced constants: main.js:123,158,175,531–546
// - numeric input ranges: index.html:317–714
// - bound-control completeness: main.js:18212–18253 and 18444–18515
// Values are semantic data transcribed fresh under PLAN §0's every-line-new mandate.

const WORLD_LINEAR_SCALE = 4;
const DEFAULT_OAT_POWER = 1.55;

export const BASE_SIMULATION_VALUES = Object.freeze({
  uptakeRate: 0.035,
  depositRate: 0.005,
  burnRate: 0.005,
  reproThreshold: 3,
  foodWeight: 1.5,
  crowdWeight: 1,
  crowdExponent: 1,
  densityBlur: 18,
  densityTarget: 0.02,
  simulationSteps: 1,
  minMoveScale: 0.18,
  stepSize: 0.0016 / WORLD_LINEAR_SCALE,
  sensorDistance: 0.032 / WORLD_LINEAR_SCALE,
  sensorAngle: 0.72,
  turnAngle: 0.34,
  wander: 0.092,
  reproAngle: 0.7,
  childStep: 0.0022 / WORLD_LINEAR_SCALE,
  maxReserve: 7,
  fieldDiffusion: 0.13,
  fieldDecay: 0.991,
  deltaScale: 1.35,
  foodClamp: 0.5,
  oatPower: DEFAULT_OAT_POWER,
  oatSupplyRate: 0.5,
  useOatRationing: false,
});

const simulationPreset = (id, label, note, overrides = {}) => Object.freeze({
  id,
  label,
  note,
  values: Object.freeze({ ...BASE_SIMULATION_VALUES, ...overrides }),
});

export const SIMULATION_PRESETS = Object.freeze([
  simulationPreset('default-current', 'Default', 'Current requested defaults.', {
    densityBlur: 30,
    oatSupplyRate: 0.14,
    useOatRationing: true,
  }),
  simulationPreset('stable-medium', 'Stable ~9k', 'Stable medium population.', {
    oatPower: 1,
    burnRate: 0.018,
    crowdWeight: 1.5,
    densityTarget: 0.28,
    reproThreshold: 4,
    maxReserve: 4.2,
    oatSupplyRate: 1,
    useOatRationing: true,
  }),
  simulationPreset('stable-compact', 'Compact ~7k', 'Compact stable population.', {
    oatPower: 1,
    burnRate: 0.018,
    crowdWeight: 1.65,
    densityTarget: 0.28,
    reproThreshold: 4,
    maxReserve: 4.2,
    useOatRationing: true,
  }),
  simulationPreset('stable-loose', 'Loose ~10k', 'Loose stable population.', {
    oatPower: 1,
    burnRate: 0.018,
    crowdWeight: 1.35,
    densityTarget: 0.28,
    reproThreshold: 4,
    maxReserve: 4.2,
    useOatRationing: true,
  }),
  simulationPreset('slow-growth', 'Slow growth ~20k', 'Slow long-running growth.', {
    oatPower: 0.95,
    burnRate: 0.016,
    crowdWeight: 1.1,
    densityTarget: 0.22,
    reproThreshold: 4,
    maxReserve: 4.2,
    useOatRationing: true,
  }),
  simulationPreset('original-defaults', 'Original defaults', 'Unmodified base tuning.'),
]);

export const BASE_POPULATION_CONTROL_VALUES = Object.freeze({
  usePopulationControl: false,
  populationTarget: 100000,
  populationControlPeriodMs: 1200,
  populationDeadbandFraction: 0.02,
  populationLambda: 0.03,
  populationMaxCommandedGrowthRate: 0.08,
  populationGrowthEmaAlpha: 0.25,
  populationSupplyLogGain: 0.45,
  populationOatSupplyMin: 0.001,
  populationOatSupplyMax: 1,
  populationUseSecondaryActuator: false,
  populationSecondaryOvershootRatio: 1.15,
  populationSecondaryGrowthThreshold: 0.01,
  populationBurnBoostMax: 0.02,
  populationReproBoostMax: 1,
});

export const BASE_RENDER_VALUES = Object.freeze({
  showAgentDots: false,
  showOats: true,
  meshOutlineEnabled: false,
  surfaceHeight: 1,
  surfaceBump: 10,
  iridescenceStrength: 0.8,
  slimeBaseColor: '#ffffff',
  iridescenceMinThickness: 370,
  iridescenceThickness: 600,
  filmThicknessCurve: 4,
  filmFollowsSlimeHeight: true,
  useGoldWaferFilm: false,
  useGoldWaferBody: true,
  goldBodyFade: 0.15,
  goldBodyRoughness: 0.33,
  goldBodyReflectivity: 1,
  goldBodyColor: '#8a889e',
  lightBrightness: 1,
  useIcosaFaceLights: false,
  spatialSmoothing: 1,
  temporalSmoothing: 1,
  observationTailLength: 0.15,
  observationStrokeOpacity: 0,
  observationCornerRadius: 24,
  observationEdgeFeather: 24,
  observationBlurRadius: 7,
  observationTintColor: '#000000',
  observationTintOpacity: 0.33,
  observationSlimeTriggerThreshold: 0.05,
  storyBoxesEnabled: true,
  showWireframe: false,
});

const renderPreset = (id, label, note, overrides = {}) => Object.freeze({
  id,
  label,
  note,
  values: Object.freeze({ ...BASE_RENDER_VALUES, ...overrides }),
});

export const RENDER_PRESETS = Object.freeze([
  renderPreset('render-default', 'Original defaults', 'Unmodified base render tuning.'),
  renderPreset('pearl-bright', 'Pearl bright', 'Current requested render look.', {
    spatialSmoothing: 1,
    temporalSmoothing: 0.93,
    surfaceHeight: 1.4,
    surfaceBump: 5,
    iridescenceStrength: 0.8,
    slimeBaseColor: '#ffffff',
    observationTailLength: 0.15,
    iridescenceMinThickness: 220,
    iridescenceThickness: 760,
    filmFollowsSlimeHeight: true,
    lightBrightness: 1,
  }),
]);

const selectedSimulation = SIMULATION_PRESETS.find(({ id }) => id === 'default-current').values;
const selectedRender = RENDER_PRESETS.find(({ id }) => id === 'pearl-bright').values;

export const DEFAULT_PARAMETER_VALUES = Object.freeze({
  ...selectedSimulation,
  ...selectedRender,
  ...BASE_POPULATION_CONTROL_VALUES,
  useSeamStitching: true,
  useIslandMasking: true,
  useHeadingRotation: true,
  useOpticalZoom: false,
  endingTimeLimitEnabled: false,
  statsReadbackEnabled: false,
  debugView: 'slime',
  performanceMode: 'quality',
  smoothFieldDisplay: true,
});

const range = (min, max, step) => ({ min, max, step });
const numeric = (name, space, unit, limits = {}) => Object.freeze({
  type: 'number',
  default: DEFAULT_PARAMETER_VALUES[name],
  min: limits.min ?? null,
  max: limits.max ?? null,
  step: limits.step ?? null,
  space,
  unit,
});
const boolean = (name) => Object.freeze({
  type: 'boolean', default: DEFAULT_PARAMETER_VALUES[name], space: 'dimensionless', unit: 'boolean',
});
const choice = (name, values, unit = 'mode') => Object.freeze({
  type: 'choice', default: DEFAULT_PARAMETER_VALUES[name], values: Object.freeze(values), space: 'dimensionless', unit,
});
const colour = (name) => Object.freeze({
  type: 'color', default: DEFAULT_PARAMETER_VALUES[name], space: 'dimensionless', unit: 'sRGB hex',
});

export const PARAMETER_DEFINITIONS = Object.freeze({
  uptakeRate: numeric('uptakeRate', 'surface', 'reserve per step', range(0.005, 0.09, 0.001)),
  depositRate: numeric('depositRate', 'surface', 'field peak per step', range(0.001, 0.05, 0.001)),
  burnRate: numeric('burnRate', 'surface', 'reserve per step', range(0.001, 0.045, 0.001)),
  reproThreshold: numeric('reproThreshold', 'surface', 'reserve', range(0.2, 4.5, 0.05)),
  foodWeight: numeric('foodWeight', 'surface', 'steering weight', range(0.2, 3.5, 0.05)),
  crowdWeight: numeric('crowdWeight', 'surface', 'steering weight', range(0, 3.5, 0.05)),
  crowdExponent: numeric('crowdExponent', 'surface', 'exponent', range(1, 8, 0.05)),
  densityBlur: numeric('densityBlur', 'surface', 'legacy crowd-radius control', range(1, 64, 0.5)),
  densityTarget: numeric('densityTarget', 'surface', 'normalized density', range(0.02, 0.7, 0.01)),
  simulationSteps: numeric('simulationSteps', 'time', 'steps per rendered frame', range(0, 8, 1)),
  minMoveScale: numeric('minMoveScale', 'uv', 'step fraction', range(0, 0.6, 0.01)),
  stepSize: numeric('stepSize', 'uv', 'UV per step', range(0, 0.003, 0.00005)),
  sensorDistance: numeric('sensorDistance', 'uv', 'UV', {}),
  sensorAngle: numeric('sensorAngle', 'surface', 'radians', {}),
  turnAngle: numeric('turnAngle', 'surface', 'radians per step', {}),
  wander: numeric('wander', 'surface', 'radians per step', {}),
  reproAngle: numeric('reproAngle', 'surface', 'radians', {}),
  childStep: numeric('childStep', 'uv', 'UV', {}),
  maxReserve: numeric('maxReserve', 'surface', 'reserve', {}),
  fieldDiffusion: numeric('fieldDiffusion', 'texel', '3×3 mix per step', {}),
  fieldDecay: numeric('fieldDecay', 'texel', 'retained fraction per step', range(0.94, 1, 0.001)),
  deltaScale: numeric('deltaScale', 'texel', 'field delta multiplier', {}),
  foodClamp: numeric('foodClamp', 'surface', 'field value', range(0.05, 1.5, 0.01)),
  oatPower: numeric('oatPower', 'surface', 'field peak', range(0, 4, 0.05)),
  oatSupplyRate: numeric('oatSupplyRate', 'surface', 'field per step', range(0.001, 1, 0.001)),
  useOatRationing: boolean('useOatRationing'),
  usePopulationControl: boolean('usePopulationControl'),
  populationTarget: numeric('populationTarget', 'surface', 'agents', range(1, 262144, 1000)),
  populationControlPeriodMs: numeric('populationControlPeriodMs', 'time', 'milliseconds', {}),
  populationDeadbandFraction: numeric('populationDeadbandFraction', 'surface', 'fraction', {}),
  populationLambda: numeric('populationLambda', 'time', 'inverse seconds', range(0, 0.12, 0.005)),
  populationMaxCommandedGrowthRate: numeric('populationMaxCommandedGrowthRate', 'time', 'log growth per second', {}),
  populationGrowthEmaAlpha: numeric('populationGrowthEmaAlpha', 'time', 'EMA fraction', {}),
  populationSupplyLogGain: numeric('populationSupplyLogGain', 'surface', 'log-space gain', range(0, 1.5, 0.05)),
  populationOatSupplyMin: numeric('populationOatSupplyMin', 'surface', 'field per step', range(0.001, 0.1, 0.0005)),
  populationOatSupplyMax: numeric('populationOatSupplyMax', 'surface', 'field per step', range(0.05, 1, 0.01)),
  populationUseSecondaryActuator: boolean('populationUseSecondaryActuator'),
  populationSecondaryOvershootRatio: numeric('populationSecondaryOvershootRatio', 'surface', 'ratio', {}),
  populationSecondaryGrowthThreshold: numeric('populationSecondaryGrowthThreshold', 'time', 'log growth per second', {}),
  populationBurnBoostMax: numeric('populationBurnBoostMax', 'surface', 'reserve per step', {}),
  populationReproBoostMax: numeric('populationReproBoostMax', 'surface', 'reserve', {}),
  showAgentDots: boolean('showAgentDots'),
  showOats: boolean('showOats'),
  meshOutlineEnabled: boolean('meshOutlineEnabled'),
  surfaceHeight: numeric('surfaceHeight', 'surface', 'bump-height scale', range(0, 5, 0.01)),
  surfaceBump: numeric('surfaceBump', 'surface', 'normal-perturbation scale', range(0, 15, 0.1)),
  iridescenceStrength: numeric('iridescenceStrength', 'surface', 'mix weight', range(0, 2, 0.01)),
  slimeBaseColor: colour('slimeBaseColor'),
  iridescenceMinThickness: numeric('iridescenceMinThickness', 'surface', 'nanometres', range(0, 760, 5)),
  iridescenceThickness: numeric('iridescenceThickness', 'surface', 'nanometres', range(90, 760, 5)),
  filmThicknessCurve: numeric('filmThicknessCurve', 'surface', 'exponent', range(0.25, 12, 0.05)),
  filmFollowsSlimeHeight: boolean('filmFollowsSlimeHeight'),
  useGoldWaferFilm: boolean('useGoldWaferFilm'),
  useGoldWaferBody: boolean('useGoldWaferBody'),
  goldBodyFade: numeric('goldBodyFade', 'surface', 'field fraction', range(0.01, 1, 0.01)),
  goldBodyRoughness: numeric('goldBodyRoughness', 'surface', 'roughness', range(0.18, 1, 0.01)),
  goldBodyReflectivity: numeric('goldBodyReflectivity', 'surface', 'reflectivity', range(0, 1, 0.01)),
  goldBodyColor: colour('goldBodyColor'),
  lightBrightness: numeric('lightBrightness', 'surface', 'light multiplier', range(0, 1, 0.01)),
  useIcosaFaceLights: boolean('useIcosaFaceLights'),
  spatialSmoothing: numeric('spatialSmoothing', 'texel', 'iterated blur radius', range(0, 10, 0.25)),
  temporalSmoothing: numeric('temporalSmoothing', 'time', 'history fraction', range(0, 1, 0.01)),
  observationTailLength: numeric('observationTailLength', 'screen', 'viewport-height fraction', range(0, 0.9, 0.01)),
  observationStrokeOpacity: numeric('observationStrokeOpacity', 'screen', 'opacity', range(0, 1, 0.01)),
  observationCornerRadius: numeric('observationCornerRadius', 'screen', 'CSS pixels', range(0, 24, 1)),
  observationEdgeFeather: numeric('observationEdgeFeather', 'screen', 'CSS pixels', range(0, 48, 1)),
  observationBlurRadius: numeric('observationBlurRadius', 'screen', 'CSS pixels', range(0, 36, 1)),
  observationTintColor: colour('observationTintColor'),
  observationTintOpacity: numeric('observationTintOpacity', 'screen', 'opacity', range(0, 0.5, 0.01)),
  observationSlimeTriggerThreshold: numeric('observationSlimeTriggerThreshold', 'surface', 'field value', range(0, 1, 0.01)),
  storyBoxesEnabled: boolean('storyBoxesEnabled'),
  showWireframe: boolean('showWireframe'),
  useSeamStitching: boolean('useSeamStitching'),
  useIslandMasking: boolean('useIslandMasking'),
  useHeadingRotation: boolean('useHeadingRotation'),
  useOpticalZoom: boolean('useOpticalZoom'),
  endingTimeLimitEnabled: boolean('endingTimeLimitEnabled'),
  statsReadbackEnabled: boolean('statsReadbackEnabled'),
  debugView: choice('debugView', ['slime', 'food', 'chart-id', 'seam', 'domain', 'gutter']),
  performanceMode: choice('performanceMode', ['quality', 'balanced', 'fast']),
  smoothFieldDisplay: boolean('smoothFieldDisplay'),
});

export const SLIDER_PARAM_BINDINGS = Object.freeze({
  uptake: 'uptakeRate', deposit: 'depositRate', burn: 'burnRate', repro: 'reproThreshold',
  attract: 'foodWeight', avoid: 'crowdWeight', crowdCurve: 'crowdExponent', blur: 'densityBlur',
  ideal: 'densityTarget', minSpeed: 'minMoveScale', decay: 'fieldDecay', steps: 'simulationSteps',
  foodClamp: 'foodClamp', oatPower: 'oatPower', oatSupply: 'oatSupplyRate',
  populationTarget: 'populationTarget', populationLambda: 'populationLambda',
  populationSupplyLogGain: 'populationSupplyLogGain', populationOatSupplyMin: 'populationOatSupplyMin',
  populationOatSupplyMax: 'populationOatSupplyMax', spatialSmooth: 'spatialSmoothing',
  temporalSmooth: 'temporalSmoothing', surfaceHeight: 'surfaceHeight', surfaceBump: 'surfaceBump',
  iridescenceStrength: 'iridescenceStrength', iridescenceMinThickness: 'iridescenceMinThickness',
  iridescenceThickness: 'iridescenceThickness', filmThicknessCurve: 'filmThicknessCurve',
  goldBodyFade: 'goldBodyFade', goldBodyRoughness: 'goldBodyRoughness',
  goldBodyReflectivity: 'goldBodyReflectivity', lightBrightness: 'lightBrightness',
  observationTailLength: 'observationTailLength', observationStrokeOpacity: 'observationStrokeOpacity',
  observationCornerRadius: 'observationCornerRadius', observationEdgeFeather: 'observationEdgeFeather',
  observationBlurRadius: 'observationBlurRadius', observationTintOpacity: 'observationTintOpacity',
  observationSlimeTriggerThreshold: 'observationSlimeTriggerThreshold', speed: 'stepSize',
});

// GUTTER = ceil(max sample reach + bilinear support) = ceil(2.33 + 1) = 4.
// Iterated kernels never increase their single-pass footprint; gutters are refilled between passes.
export const MAX_KERNEL_FOOTPRINT = Object.freeze({
  bumpTaps: Object.freeze({ maxSampleReachTexels: 2.33, bilinearSupportTexels: 1, requiredGutterTexels: 4 }),
  blurPass: Object.freeze({ maxSampleReachTexels: 1, bilinearSupportTexels: 0, requiredGutterTexels: 1 }),
  bilinearSample: Object.freeze({ maxSampleReachTexels: 0, bilinearSupportTexels: 1, requiredGutterTexels: 1 }),
});

export function createParams(overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!(key in PARAMETER_DEFINITIONS)) throw new Error(`Unknown parameter: ${key}`);
  }
  const values = { ...DEFAULT_PARAMETER_VALUES, ...overrides };
  for (const [name, definition] of Object.entries(PARAMETER_DEFINITIONS)) {
    validateValue(name, values[name], definition);
  }
  return values;
}

export function serializeParams(values) {
  const checked = createParams(values);
  return JSON.stringify(Object.fromEntries(Object.keys(PARAMETER_DEFINITIONS).map((key) => [key, checked[key]])));
}

export function parseParams(serialized) {
  const parsed = JSON.parse(serialized);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new TypeError('Parameter payload must be an object');
  return createParams(parsed);
}

function validateValue(name, value, definition) {
  if (definition.type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
    if (definition.min !== null && value < definition.min) throw new RangeError(`${name} is below its UI minimum`);
    if (definition.max !== null && value > definition.max) throw new RangeError(`${name} is above its UI maximum`);
  } else if (definition.type === 'boolean' && typeof value !== 'boolean') {
    throw new TypeError(`${name} must be boolean`);
  } else if (definition.type === 'color' && !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new TypeError(`${name} must be a six-digit sRGB hex colour`);
  } else if (definition.type === 'choice' && !definition.values.includes(value)) {
    throw new RangeError(`${name} is not an allowed choice`);
  }
}

