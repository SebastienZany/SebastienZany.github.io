// Oat markers: the small yellow glow that sits on the body at each oat, and
// the "fizzle" puff that flares and dies where an oat placement was rejected.
//
// A marker fades in when its oat is placed, dims as its patch of surface turns
// away from the camera or goes behind the body, and fades out for good when
// the oat's story begins (the stories module asks for that via fadeOut).

import * as THREE from 'three';
import { GLOW_TEXTURE, MARKER, MARKER_VISIBILITY, FIZZLE } from './oat-markers.config.js';

export function createOatMarkers(ctx) {
  const group = new THREE.Group();
  ctx.scene.add(group);
  const glowTexture = makeGlowTexture();

  const markers = new Map(); // oat.id -> marker
  const fizzles = [];
  let storyOatCount = 0; // staggers the occlusion re-tests of successive oats
  const toCamera = new THREE.Vector3();

  function makeSprite(sizeWorld, opacity) {
    const material = new THREE.SpriteMaterial({
      map: glowTexture,
      color: MARKER.tint,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Depth is ignored on purpose: hiding behind the body is done by the
      // occlusion fade below, which is soft where a depth test would pop.
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.setScalar(sizeWorld);
    sprite.renderOrder = MARKER.renderOrder;
    return sprite;
  }

  // The part of a marker's state that tracks "can the camera see this spot".
  function makeSpot(point, normal, now, recheckPhaseMs) {
    const unitNormal = normal ? normal.clone() : point.clone();
    if (unitNormal.lengthSq() < 1e-8) unitNormal.set(0, 1, 0);
    unitNormal.normalize();
    return {
      point: point.clone(),
      normal: unitNormal,
      occlusionTarget: null, // 0 or 1 from the last ray test; null = never tested
      occlusionOpacity: 1,
      occlusionUpdatedAtMs: now,
      nextOcclusionCheckAtMs: 0,
      recheckPhaseMs,
    };
  }

  // Returns 0..1: facing fade times eased occlusion fade.
  function spotVisibility(spot, now) {
    const V = MARKER_VISIBILITY;
    toCamera.copy(ctx.camera.position).sub(spot.point).normalize();
    const facing = THREE.MathUtils.smoothstep(
      spot.normal.dot(toCamera), V.facingHiddenDot, V.facingShownDot);

    if (facing <= V.skipOcclusionBelowFacing) {
      spot.occlusionTarget = 0;
    } else if (spot.occlusionTarget === null || now >= spot.nextOcclusionCheckAtMs) {
      spot.occlusionTarget = ctx.surface.isOccluded(ctx.camera.position, spot.point) ? 0 : 1;
      spot.nextOcclusionCheckAtMs = now + V.occlusionRecheckMs + spot.recheckPhaseMs;
    }

    const dtSec = Math.max(0, (now - spot.occlusionUpdatedAtMs) / 1000);
    const response = 1 - Math.exp(-dtSec * V.occlusionResponsePerSec);
    spot.occlusionOpacity += (spot.occlusionTarget - spot.occlusionOpacity) * response;
    spot.occlusionUpdatedAtMs = now;
    return facing * spot.occlusionOpacity;
  }

  function add(oat, now) {
    // The first oat never shows a marker: the falling intro oat lands there
    // and the colony grows over it straight away.
    if (oat.initial || markers.has(oat.id)) return;
    storyOatCount += 1;
    const V = MARKER_VISIBILITY;
    const sprite = makeSprite(MARKER.sizeWorld, MARKER.opacity);
    sprite.position.copy(oat.point);
    sprite.visible = false; // update() switches it on as it fades in
    group.add(sprite);
    markers.set(oat.id, {
      sprite,
      spot: makeSpot(oat.point, oat.normal, now,
        (storyOatCount * V.recheckPhaseStepMs) % V.occlusionRecheckMs),
      addedAtMs: now,
      fadeOutStartMs: null,
      fadeOutMs: 0,
    });
  }

  function remove(oat) {
    const marker = markers.get(oat.id);
    if (!marker) return;
    markers.delete(oat.id);
    discardSprite(marker.sprite);
  }

  function fadeOut(oat, now, durationMs) {
    const marker = markers.get(oat.id);
    if (!marker) return;
    marker.fadeOutStartMs = now;
    marker.fadeOutMs = Math.max(1, durationMs);
  }

  function fizzle(point, normal, now) {
    if (!point) return;
    const sprite = makeSprite(FIZZLE.sizeWorld, FIZZLE.opacity);
    sprite.position.copy(point);
    group.add(sprite);
    fizzles.push({
      sprite,
      spot: makeSpot(point, normal, now, Math.random() * MARKER_VISIBILITY.occlusionRecheckMs),
      startedAtMs: now,
      flickerPhase: Math.random() * 1000, // so no two fizzles flicker alike
    });
  }

  function setVisible(on) {
    group.visible = !!on;
  }

  function update(now) {
    // Hidden markers are not animated; a fizzle caught mid-flight simply
    // finishes (or is found expired) once markers are shown again.
    if (!group.visible) return;
    for (const marker of markers.values()) updateMarker(marker, now);
    for (let i = fizzles.length - 1; i >= 0; i--) {
      if (updateFizzle(fizzles[i], now)) continue;
      discardSprite(fizzles[i].sprite);
      fizzles.splice(i, 1);
    }
  }

  function updateMarker(marker, now) {
    const fadeIn = smoothUnit((now - marker.addedAtMs) / MARKER.fadeInMs);
    const fadeOutAmount = marker.fadeOutStartMs === null
      ? 0
      : smoothUnit((now - marker.fadeOutStartMs) / marker.fadeOutMs);
    const visibility = spotVisibility(marker.spot, now) * fadeIn * (1 - fadeOutAmount);
    marker.sprite.visible = visibility > MARKER.hiddenBelowOpacity;
    marker.sprite.material.opacity = MARKER.opacity * visibility;
  }

  // Returns false once the fizzle has burnt out.
  function updateFizzle(fizz, now) {
    const t = clamp01((now - fizz.startedAtMs) / FIZZLE.durationMs);
    if (t >= 1) return false;
    const visibility = spotVisibility(fizz.spot, now);
    const phase = fizz.flickerPhase;
    const jitter = 1 + FIZZLE.sizeJitterAmount * Math.sin(phase + t * FIZZLE.sizeJitterFrequency);
    const shrink = Math.max(FIZZLE.minShrink, Math.pow(1 - t, FIZZLE.shrinkPower));
    fizz.sprite.visible = visibility > MARKER.hiddenBelowOpacity;
    fizz.sprite.material.opacity = FIZZLE.opacity * visibility * fizzleFlame(t, phase);
    fizz.sprite.scale.setScalar(FIZZLE.sizeWorld * shrink * jitter);
    return true;
  }

  function discardSprite(sprite) {
    group.remove(sprite);
    sprite.material.dispose(); // the glow texture is shared and outlives the sprite
  }

  function reset() {
    for (const marker of markers.values()) discardSprite(marker.sprite);
    for (const fizz of fizzles) discardSprite(fizz.sprite);
    markers.clear();
    fizzles.length = 0;
    storyOatCount = 0;
  }

  function dispose() {
    reset();
    ctx.scene.remove(group);
    glowTexture.dispose();
  }

  return { add, remove, fadeOut, fizzle, setVisible, update, reset, dispose };
}

// Brightness of the fizzle flame at t (0..1 through its life): a decaying
// envelope with a last flare, multiplied by a flicker and late cut-outs.
function fizzleFlame(t, phase) {
  const F = FIZZLE;
  const envelope = Math.pow(1 - t, F.envelopePower);
  let flutter = F.flutterBase;
  for (const wave of F.flutterWaves) {
    flutter += wave.amount * Math.sin(phase * wave.phaseScale + t * wave.frequency);
  }
  const cutsOut = t > F.sputterAfter &&
    Math.sin(phase * F.sputterPhaseScale + t * F.sputterFrequency) <
      F.sputterCutoffBase + t * F.sputterCutoffSlope;
  const sputter = cutsOut ? F.sputterLevel : 1;
  const gaspDistance = (t - F.lastGaspAt) / F.lastGaspWidth;
  const lastGasp = Math.exp(-gaspDistance * gaspDistance) * F.lastGaspAmount;
  const flame = (envelope + lastGasp) * Math.max(0, flutter) * sputter;
  return Math.max(0, Math.min(F.maxFlame, flame));
}

// The glow is painted pixel by pixel into an sRGB canvas rather than with a
// Canvas2D radial gradient: iOS Safari dithers gradients and defaults canvases
// to Display-P3, which under additive blending turned the yellow glow into
// green speckles on every oat.
function makeGlowTexture() {
  const size = GLOW_TEXTURE.sizePx;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  let context = null;
  try {
    context = canvas.getContext('2d', { colorSpace: 'srgb' });
  } catch {
    context = null; // older browsers reject the options bag
  }
  if (!context) context = canvas.getContext('2d');

  const image = context.createImageData(size, size);
  const centre = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - centre, y + 0.5 - centre);
      const colour = sampleStops(GLOW_TEXTURE.stops, clamp01(distance / centre));
      const i = (y * size + x) * 4;
      image.data[i] = Math.round(colour.r);
      image.data[i + 1] = Math.round(colour.g);
      image.data[i + 2] = Math.round(colour.b);
      image.data[i + 3] = Math.round(colour.a * 255);
    }
  }
  context.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

// Linear interpolation between the two stops around t. Stops are sorted by `at`.
function sampleStops(stops, t) {
  if (t <= stops[0].at) return stops[0];
  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i];
    const to = stops[i + 1];
    if (t > to.at) continue;
    const f = (t - from.at) / Math.max(to.at - from.at, 1e-6);
    return {
      r: from.r + (to.r - from.r) * f,
      g: from.g + (to.g - from.g) * f,
      b: from.b + (to.b - from.b) * f,
      a: from.a + (to.a - from.a) * f,
    };
  }
  return stops[stops.length - 1];
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function smoothUnit(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}
