// The falling intro oat: one additive glow sprite drawn over everything.
// The glow texture is built once and shared by every fall (a restart replays
// the intro); each fall gets its own sprite and material.

import {
  AdditiveBlending, CanvasTexture, ClampToEdgeWrapping, LinearFilter,
  Sprite, SpriteMaterial, SRGBColorSpace,
} from 'three';
import { introOatPose } from './intro-oat-path.js';

export function createIntroOatSprites(ctx, config) {
  let texture = null;

  // Begin the fall from `start` to `target` (world positions).
  function spawn(start, target) {
    if (!texture) texture = makeGlowTexture(ctx.dom.app.ownerDocument, config);
    const material = new SpriteMaterial({
      map: texture,
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      blending: AdditiveBlending,
      depthWrite: false,
      depthTest: false, // visible even where the body would hide it
    });
    const sprite = new Sprite(material);
    sprite.renderOrder = config.renderOrder;
    sprite.position.copy(start);
    sprite.scale.setScalar(config.baseScaleWorld);
    ctx.scene.add(sprite);

    return {
      position: sprite.position,
      setProgress(progress) {
        const pose = introOatPose(progress, config);
        sprite.position.lerpVectors(start, target, pose.descent);
        sprite.scale.setScalar(pose.scaleWorld);
        material.opacity = pose.opacity;
      },
      remove() {
        ctx.scene.remove(sprite);
        material.dispose();
      },
    };
  }

  return {
    spawn,
    dispose() {
      texture?.dispose();
      texture = null;
    },
  };
}

// A soft yellow disc. Filled pixel by pixel into an sRGB canvas rather than
// with a canvas radial gradient: iOS Safari dithers gradients and defaults
// canvases to Display-P3, which shows up as green speckles once the sprite
// is blended additively.
function makeGlowTexture(document, config) {
  const size = config.textureSizePx;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  let context = null;
  try {
    context = canvas.getContext('2d', { colorSpace: 'srgb' });
  } catch {
    // Older browsers reject the options bag.
  }
  if (!context) context = canvas.getContext('2d');

  const image = context.createImageData(size, size);
  const radius = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = Math.min(1, Math.hypot(x + 0.5 - radius, y + 0.5 - radius) / radius);
      const [red, green, blue, alpha] = sampleStops(config.glowStops, t);
      const i = (y * size + x) * 4;
      image.data[i] = Math.round(red);
      image.data[i + 1] = Math.round(green);
      image.data[i + 2] = Math.round(blue);
      image.data[i + 3] = Math.round(alpha * 255);
    }
  }
  context.putImageData(image, 0, 0);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  return texture;
}

// Linear blend between the two stops around t. Stops are [position, r, g, b, a].
function sampleStops(stops, t) {
  for (let i = 0; i < stops.length - 1; i++) {
    const [posA, ...a] = stops[i];
    const [posB, ...b] = stops[i + 1];
    if (t >= posA && t <= posB) {
      const f = (t - posA) / Math.max(posB - posA, 1e-6);
      return a.map((value, channel) => value + (b[channel] - value) * f);
    }
  }
  return stops[stops.length - 1].slice(1);
}
