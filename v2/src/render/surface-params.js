import { PARAMETER_DEFINITIONS } from '../shared/params.js';

// Checklist §2c is the completeness authority for this lane. Keeping the UI
// description and GPU destination together makes a missing live binding testable.
export const SURFACE_PARAM_CONTROLS = Object.freeze([
  control('smoothFieldDisplay', 'Smooth sampling', 'Choose bilinear rather than nearest field sampling.', 'material'),
  control('spatialSmoothing', 'Spatial smoothing', 'Spread the synthetic display field before material sampling.', 'display'),
  control('temporalSmoothing', 'Temporal smoothing', 'Blend the current synthetic field with its prior history.', 'display'),
  control('surfaceHeight', 'Height', 'Scale food into the slime height function.', 'material'),
  control('surfaceBump', 'Bump', 'Scale the height-gradient normal perturbation.', 'material'),
  control('iridescenceStrength', 'Iridescence', 'Set the thin-film colour contribution.', 'material'),
  control('slimeBaseColor', 'Slime base', 'Choose the body colour beneath the slime film.', 'material'),
  control('iridescenceMinThickness', 'Minimum film', 'Set the thin end of the food-driven film range.', 'material'),
  control('iridescenceThickness', 'Maximum film', 'Set the thick end of the food-driven film range.', 'material'),
  control('filmThicknessCurve', 'Film curve', 'Shape food into normalized film thickness.', 'material'),
  control('filmFollowsSlimeHeight', 'Film follows height', 'Drive film thickness from local food.', 'material'),
  control('useGoldWaferFilm', 'Gold LUT film', 'Use the measured gold-wafer response for the slime film.', 'material'),
  control('useGoldWaferBody', 'Gold body', 'Draw the opaque remembered-food body below the slime.', 'material'),
  control('goldBodyFade', 'Gold fade', 'Set the low-end history range over which gold appears.', 'material'),
  control('goldBodyRoughness', 'Gold roughness', 'Soften or sharpen the gold reflection.', 'material'),
  control('goldBodyReflectivity', 'Gold reflectivity', 'Scale the gold specular response.', 'material'),
  control('goldBodyColor', 'Gold base', 'Choose the diffuse tint beneath the gold film response.', 'material'),
  control('lightBrightness', 'Light brightness', 'Scale the white icosahedron light rig.', 'material'),
  control('useIcosaFaceLights', 'Face lights', 'Use all 32 lights with total radiance renormalized.', 'material'),
]);

export const SURFACE_PARAM_NAMES = Object.freeze(
  SURFACE_PARAM_CONTROLS.map(({ parameterName }) => parameterName),
);

export const SURFACE_PARAM_BINDINGS = Object.freeze(Object.fromEntries(
  SURFACE_PARAM_CONTROLS.map(({ parameterName, uniformTarget }) => [
    parameterName,
    Object.freeze({ uniformTarget }),
  ]),
));

function control(parameterName, label, help, uniformTarget) {
  const parameter = PARAMETER_DEFINITIONS[parameterName];
  if (!parameter) throw new Error(`Surface control has no parameter definition: ${parameterName}`);
  return Object.freeze({ parameterName, label, help, uniformTarget, parameter });
}
