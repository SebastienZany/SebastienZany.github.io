// Tunable settings of the look: how the slime film and the gold body beneath
// it are drawn. Defaults are the old game's "Pearl bright" look.

export const paramSchema = [
  { section: 'Slime film', items: [
    { key: 'spatialSmoothing', label: 'Spatial smoothing', type: 'range', min: 0, max: 10, step: 0.05, default: 1, help: 'Blur radius, in texels, applied to the slime before it is drawn.' },
    { key: 'temporalSmoothing', label: 'Temporal smoothing', type: 'range', min: 0, max: 4, step: 0.01, default: 0.93, help: 'How much of the previous frame\'s slime is kept each frame.' },
    { key: 'surfaceHeight', label: 'Height', type: 'range', min: 0, max: 4, step: 0.05, default: 1.4, help: 'How tall thick slime stands.' },
    { key: 'surfaceBump', label: 'Bump', type: 'range', min: 0, max: 30, step: 0.5, default: 5, help: 'How strongly height differences catch the light.' },
    { key: 'iridescenceStrength', label: 'Iridescence', type: 'range', min: 0, max: 2, step: 0.01, default: 0.8, help: 'Strength of the thin-film colour.' },
    { key: 'slimeBaseColor', label: 'Body colour', type: 'color', default: '#ffffff', help: 'Colour of the slime under its film. Story text follows it.' },
    { key: 'iridescenceMinThickness', label: 'Film at edge (nm)', type: 'range', min: 10, max: 1200, step: 5, default: 220, help: 'Film thickness where the slime is thinnest.' },
    { key: 'iridescenceThickness', label: 'Film at peak (nm)', type: 'range', min: 10, max: 1200, step: 5, default: 760, help: 'Film thickness where the slime is thickest.' },
    { key: 'filmThicknessCurve', label: 'Film curve', type: 'range', min: 0.1, max: 12, step: 0.1, default: 4, help: 'How quickly film thickness rises with slime thickness.' },
    { key: 'filmFollowsSlimeHeight', label: 'Film follows height', type: 'toggle', default: true, help: 'Vary film thickness with slime thickness; off uses the peak value everywhere.' },
    { key: 'sculptDetail', label: 'Sculpt detail', type: 'range', min: 0, max: 2, step: 0.05, default: 1, help: 'Strength of the sculpt\'s normal map.' },
    { key: 'lightBrightness', label: 'Light', type: 'range', min: 0, max: 3, step: 0.01, default: 1, help: 'Brightness of the ring of lights around the body.' },
    { key: 'useFaceLights', label: 'More lights', type: 'toggle', default: false, help: 'Thirty-two lights instead of twelve, at the same total brightness.' },
  ] },
  { section: 'Gold body', items: [
    { key: 'useGoldBody', label: 'Gold body', type: 'toggle', default: true, help: 'Show the gilded body wherever slime has been.' },
    { key: 'goldBodyFade', label: 'Reveal threshold', type: 'range', min: 0.01, max: 1, step: 0.01, default: 0.15, help: 'How much slime it takes to fully reveal the gold.' },
    { key: 'goldBodyRoughness', label: 'Roughness', type: 'range', min: 0.04, max: 1, step: 0.01, default: 0.33 },
    { key: 'goldBodyReflectivity', label: 'Reflectivity', type: 'range', min: 0, max: 1, step: 0.01, default: 1 },
    { key: 'goldBodyColor', label: 'Colour', type: 'color', default: '#8a889e' },
  ] },
  { section: 'View', items: [
    { key: 'view', label: 'Show', type: 'select', options: ['slime', 'thickness'], default: 'slime', help: '"thickness" draws the raw slime amount, for debugging.' },
    { key: 'showSlime', label: 'Slime layer', type: 'toggle', default: true },
    { key: 'showGold', label: 'Gold layer', type: 'toggle', default: true },
    { key: 'showOats', label: 'Oat markers', type: 'toggle', default: true },
    { key: 'meshOutline', label: 'Body outline', type: 'toggle', default: false, help: 'A faint rim so the body can be seen without slime.' },
  ] },
];

export function defaultParams() {
  const params = {};
  for (const section of paramSchema) for (const item of section.items) params[item.key] = item.default;
  return params;
}

// Detail levels. Phones get the cheap one.
export const DETAIL = Object.freeze({
  full: { smoothingTaps: 14, diagonalBumpTaps: true },
  light: { smoothingTaps: 3, diagonalBumpTaps: false },
});
