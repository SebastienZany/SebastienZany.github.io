// Tunable settings of the physarum model, and the fixed numbers behind it.
//
// Distances are in world units (the body is 9.6 units long), at slime size 1;
// the model multiplies them by the game's slime size (SLIME_SIZE in src/config.js). The old game
// expressed them in atlas units on a mesh whose atlas averaged 19.483 world
// units per atlas unit; the values here are those numbers converted, so the
// organism behaves the same but no longer depends on how a mesh is unwrapped.

export const paramSchema = [
  { section: 'Agents', items: [
    { key: 'uptakeRate', label: 'Uptake', type: 'range', min: 0.005, max: 0.09, step: 0.001, default: 0.035, help: 'How fast an agent turns the food under it into reserve.' },
    { key: 'depositRate', label: 'Deposit', type: 'range', min: 0, max: 0.03, step: 0.0005, default: 0.005, help: 'Reserve an agent spends per step laying trail.' },
    { key: 'burnRate', label: 'Burn', type: 'range', min: 0, max: 0.04, step: 0.0005, default: 0.005, help: 'Reserve an agent spends per step just staying alive.' },
    { key: 'reproThreshold', label: 'Divide above', type: 'range', min: 0.2, max: 4.5, step: 0.05, default: 3.0, help: 'Reserve at which an agent buds two children.' },
    { key: 'stepWorld', label: 'Speed', type: 'range', min: 0, max: 0.06, step: 0.0005, default: 0.00779, help: 'World distance an agent moves per step at full speed.' },
  ] },
  { section: 'Steering', items: [
    { key: 'foodWeight', label: 'Food pull', type: 'range', min: 0, max: 4, step: 0.05, default: 1.5, help: 'How strongly agents steer toward food and trail.' },
    { key: 'crowdWeight', label: 'Crowd pull', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, help: 'How strongly agents steer toward (and away from too much) company.' },
    { key: 'crowdExponent', label: 'Crowd curve', type: 'range', min: 1, max: 4, step: 0.05, default: 1.0, help: 'How sharply overcrowding is punished.' },
    { key: 'crowdKernelWorld', label: 'Crowd reach', type: 'range', min: 0.004, max: 0.2, step: 0.001, default: 0.0951, help: 'Diameter, in world units, over which an agent is felt by others.' },
    { key: 'densityTarget', label: 'Ideal crowd', type: 'range', min: 0.005, max: 0.5, step: 0.005, default: 0.02, help: 'Crowd level agents find comfortable.' },
    { key: 'minMoveScale', label: 'Minimum speed', type: 'range', min: 0, max: 1, step: 0.01, default: 0.18, help: 'Fraction of full speed an agent keeps when nowhere looks better than here.' },
  ] },
  { section: 'Trail', items: [
    { key: 'fieldDecay', label: 'Trail decay', type: 'range', min: 0.94, max: 1, step: 0.0005, default: 0.991, help: 'Fraction of the trail that survives each step.' },
    { key: 'fieldDiffusion', label: 'Trail spread', type: 'range', min: 0, max: 0.5, step: 0.005, default: 0.13, help: 'How much the trail blurs into its neighbours each step.' },
    { key: 'simulationSteps', label: 'Steps per frame', type: 'range', min: 0, max: 8, step: 1, default: 1, help: 'Simulation steps taken each rendered frame.' },
    { key: 'foodClamp', label: 'Trail ceiling', type: 'range', min: 0.1, max: 2, step: 0.01, default: 0.5, help: 'Most trail a texel can hold.' },
    { key: 'oatSupplyRate', label: 'Oat supply', type: 'range', min: 0.001, max: 1, step: 0.001, default: 0.14, help: 'Food an oat can hand out per step when rationing is on.' },
    { key: 'useOatRationing', label: 'Ration oats', type: 'toggle', default: true, help: 'Share an oat\'s food among the agents crowding it instead of feeding each in full.' },
  ] },
];

export function defaultParams() {
  const params = {};
  for (const section of paramSchema) for (const item of section.items) params[item.key] = item.default;
  return params;
}

// Fixed parts of the behaviour (the old game had no controls for these).
export const PHYSARUM = Object.freeze({
  sensorDistanceWorld: 0.1559,
  sensorAngleRad: 0.72,
  turnAngleRad: 0.34,
  wanderRad: 0.092,
  reproAngleRad: 0.7,
  childStepWorld: 0.01072,
  maxReserve: 7.0,
  // Scales the trail's response to the agents standing on it.
  deltaScale: 1.35,
  // An agent's reserve, times this, is how strongly it registers in the crowd
  // and deposit maps; reserve beyond the cap registers no further.
  crowdMassScale: 0.032,
  crowdMassCap: 64.0,
  // A new colony.
  colonySize: 4096,
  colonySpreadWorld: 0.1753,
  colonyReserveMin: 1.0,
  colonyReserveSpan: 0.45,
  colonyPlacementTries: 24,
  // coverageNear() reports the peak trail within this world distance.
  coverageRadiusWorld: 0.038,
  // Per-texel quantities (how much trail one agent lays, how far the trail
  // spreads per step) were tuned on texels this many world units across: the
  // mean texel of the old game's 1536 atlas.
  referenceTexelWorld: 19.483 / 1536,
});
