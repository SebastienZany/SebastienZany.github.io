// The "Story labels" settings: their schema for the dev panel, their defaults,
// and how they map onto the CSS variables that story.css reads.

import { FALLBACK_RGB } from './stories.config.js';

export const paramSchema = [
  { section: 'Story labels', items: [
    { key: 'storyBoxesEnabled', label: 'Story boxes', type: 'toggle', default: true,
      help: 'Show story boxes and let slime trigger new ones.' },
    { key: 'tailLengthVh', label: 'Tail length', type: 'range', min: 0, max: 0.9, step: 0.01, default: 0.15,
      help: 'Screen-space distance from each oat to its story box, as a fraction of the viewport height.' },
    { key: 'strokeOpacity', label: 'Tail opacity', type: 'range', min: 0, max: 1, step: 0.01, default: 0,
      help: 'Opacity shared by the story box border and tail line.' },
    { key: 'cornerRadiusPx', label: 'Corner round', type: 'range', min: 0, max: 24, step: 1, default: 24,
      help: 'Corner radius for story boxes.' },
    { key: 'edgeFeatherPx', label: 'Edge feather', type: 'range', min: 0, max: 48, step: 1, default: 24,
      help: 'Soft outer feather around story boxes.' },
    { key: 'blurRadiusPx', label: 'Blur radius', type: 'range', min: 0, max: 36, step: 1, default: 7,
      help: 'Backdrop blur radius for story boxes.' },
    { key: 'tintColor', label: 'Tint color', type: 'color', default: '#000000',
      help: 'Color of the softly feathered story box blur.' },
    { key: 'tintOpacity', label: 'Tint strength', type: 'range', min: 0, max: 0.5, step: 0.01, default: 0.33,
      help: 'Opacity of the story box tint; the blur stays feathered at zero border opacity.' },
    { key: 'triggerThreshold', label: 'Story trigger', type: 'range', min: 0, max: 1, step: 0.01, default: 0.05,
      help: 'Local slime amount needed before an oat starts its story box animation.' },
  ] },
];

export function defaultParams() {
  const params = {};
  for (const section of paramSchema) {
    for (const item of section.items) params[item.key] = item.default;
  }
  return params;
}

// The feathered glass is a layer larger than the box, masked to fade out at
// its edges. Both sizes follow the one "edge feather" setting.
const FEATHER_OUTSET_SCALE = 1.75; // how far the glass extends past the box
const FEATHER_MASK_SCALE = 2.6; // width of the fade at each edge of the glass
const FEATHER_FULL_OPACITY_AT_PX = 8; // below this the glass itself thins out

// CSS variable name -> value, for the current settings.
export function cssVarsFor(params, textColor) {
  const feather = Math.max(0, params.edgeFeatherPx ?? 24);
  return {
    '--story-stroke-opacity': clamp01(params.strokeOpacity ?? 0).toFixed(3),
    '--story-corner-radius': `${Math.max(0, params.cornerRadiusPx ?? 24).toFixed(1)}px`,
    '--story-edge-feather-outset': `${(feather * FEATHER_OUTSET_SCALE).toFixed(1)}px`,
    '--story-edge-feather-mask': `${(feather * FEATHER_MASK_SCALE).toFixed(1)}px`,
    '--story-edge-feather-opacity': Math.min(1, feather / FEATHER_FULL_OPACITY_AT_PX).toFixed(3),
    '--story-blur-radius': `${Math.max(0, params.blurRadiusPx ?? 7).toFixed(1)}px`,
    '--story-tint-rgb': rgbTripletFromHex(params.tintColor ?? '#000000'),
    '--story-tint-opacity': clamp01(params.tintOpacity ?? 0.15).toFixed(3),
    '--story-text-rgb': rgbTripletFromHex(textColor),
  };
}

// '#ff8000' -> '255, 128, 0', the form rgba(var(--x), alpha) needs.
export function rgbTripletFromHex(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!match) return FALLBACK_RGB;
  const value = Number.parseInt(match[1], 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
