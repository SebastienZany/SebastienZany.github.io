// Places the tumble loop in the scene, so orbiting and zooming the camera
// changes how the slime sounds:
//
//   copies -> panner (HRTF, inverse distance) -> fade gain -> lowpass -> volume
//                                             volume -> dry ----------------> master
//                                             volume -> send -> convolver -> wet -> master
//
// Three things change with the camera's distance to the source, all measured
// between `referenceDistance` (where the game starts) and the far distance
// (the orbit controls' zoom-out limit):
//   - the panner makes it quieter,
//   - the lowpass closes from 18 kHz to 900 Hz (far things sound dull),
//   - the reverb's wet level rises from 0 to 0.58 (far things sound roomy).
//
// `view` is { camera, source: {x,y,z}, referenceDistance } and is owned by the
// caller. This file deliberately does not import three: it reads the camera's
// position and world matrix as plain numbers.

import { SILENT_GAIN, TUMBLE_SPATIAL as cfg } from './audio.config.js';
import { disconnectQuietly, glideParam } from './param-ramps.js';
import { makeReverbImpulse } from './reverb-impulse.js';

const unknownVector = () => ({ x: NaN, y: NaN, z: NaN });
const copyVector = (target, v) => { target.x = v.x; target.y = v.y; target.z = v.z; };
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// NaN-safe "has it moved at least epsilon": an unknown last value counts as moved.
function movedAtLeast(a, b, epsilon) {
  return !(distanceBetween(a, b) < epsilon);
}

function turnedAtLeast(next, last, epsilon) {
  return !(1 - dot(next, last) < epsilon);
}

function smoothstep(x, min, max) {
  if (x <= min) return 0;
  if (x >= max) return 1;
  const t = (x - min) / (max - min);
  return t * t * (3 - 2 * t);
}

// Column `index` of the camera's world matrix, normalised and scaled by `sign`.
function readCameraAxis(camera, index, sign, target) {
  const e = camera.matrixWorld.elements;
  const x = e[index * 4], y = e[index * 4 + 1], z = e[index * 4 + 2];
  const length = Math.hypot(x, y, z) || 1;
  target.x = (sign * x) / length;
  target.y = (sign * y) / length;
  target.z = (sign * z) / length;
  return target;
}

export function createSpatialChain({ context, master, volume, getOrbitMaxDistance }) {
  const panner = context.createPanner();
  const fadeGain = context.createGain();
  const lowpass = context.createBiquadFilter();
  const volumeGain = context.createGain();
  const dryGain = context.createGain();
  const reverbSend = context.createGain();
  const convolver = context.createConvolver();
  const wetGain = context.createGain();
  const nodes = [panner, fadeGain, lowpass, volumeGain, dryGain, reverbSend, convolver, wetGain];

  panner.panningModel = cfg.panningModel;
  panner.distanceModel = cfg.distanceModel;
  panner.rolloffFactor = cfg.rolloffFactor;
  panner.coneInnerAngle = cfg.coneAngleDeg;
  panner.coneOuterAngle = cfg.coneAngleDeg;
  lowpass.type = 'lowpass';
  convolver.buffer = makeReverbImpulse(context);

  const at = context.currentTime;
  fadeGain.gain.setValueAtTime(SILENT_GAIN, at);
  lowpass.Q.setValueAtTime(cfg.lowpassQ, at);
  volumeGain.gain.setValueAtTime(volume, at);
  dryGain.gain.setValueAtTime(1, at);
  reverbSend.gain.setValueAtTime(1, at);

  panner.connect(fadeGain);
  fadeGain.connect(lowpass);
  lowpass.connect(volumeGain);
  volumeGain.connect(dryGain);
  volumeGain.connect(reverbSend);
  reverbSend.connect(convolver);
  convolver.connect(wetGain);
  dryGain.connect(master);
  wetGain.connect(master);

  // What was last sent to the audio thread. NaN = nothing yet.
  const sent = {
    source: unknownVector(),
    listenerPosition: unknownVector(),
    forward: unknownVector(),
    up: unknownVector(),
    lowpassHz: NaN,
    wet: NaN,
    referenceDistance: NaN,
    farDistance: NaN,
  };
  const forward = unknownVector();
  const up = unknownVector();
  let lastSyncMs = -Infinity;

  // Positions glide with their own, slightly slower constant, and without
  // pinning the current value (they are retargeted while still moving).
  function moveParam(param, value, smooth) {
    const nowSec = context.currentTime;
    param.cancelScheduledValues(nowSec);
    if (smooth) param.setTargetAtTime(value, nowSec, cfg.positionSmoothingSec);
    else param.setValueAtTime(value, nowSec);
  }

  function setPosition(node, position, smooth) {
    if (node.positionX) {
      moveParam(node.positionX, position.x, smooth);
      moveParam(node.positionY, position.y, smooth);
      moveParam(node.positionZ, position.z, smooth);
    } else {
      node.setPosition?.(position.x, position.y, position.z); // older Safari / Firefox
    }
  }

  function setListenerOrientation(listener, smooth) {
    if (listener.forwardX) {
      moveParam(listener.forwardX, forward.x, smooth);
      moveParam(listener.forwardY, forward.y, smooth);
      moveParam(listener.forwardZ, forward.z, smooth);
      moveParam(listener.upX, up.x, smooth);
      moveParam(listener.upY, up.y, smooth);
      moveParam(listener.upZ, up.z, smooth);
    } else {
      listener.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  function syncListener(camera, smooth, force) {
    const listener = context.listener;
    if (!listener) return;
    camera.updateMatrixWorld?.(true);
    readCameraAxis(camera, 2, -1, forward); // a camera looks down its own -Z
    readCameraAxis(camera, 1, 1, up);
    if (force || movedAtLeast(camera.position, sent.listenerPosition, cfg.positionEpsilonWorld)) {
      setPosition(listener, camera.position, smooth);
      copyVector(sent.listenerPosition, camera.position);
    }
    if (force ||
        turnedAtLeast(forward, sent.forward, cfg.directionEpsilon) ||
        turnedAtLeast(up, sent.up, cfg.directionEpsilon)) {
      setListenerOrientation(listener, smooth);
      copyVector(sent.forward, forward);
      copyVector(sent.up, up);
    }
  }

  function farDistanceFor(referenceDistance) {
    const fallback = Math.max(0.001, referenceDistance * cfg.farDistanceFallbackFactor);
    const orbitMax = getOrbitMaxDistance();
    const far = Number.isFinite(orbitMax) && orbitMax > 0 ? orbitMax : fallback;
    return Math.max(referenceDistance + 0.001, far);
  }

  function syncNow(view, { smooth }, force = true) {
    const { camera, source } = view;
    if (camera) syncListener(camera, smooth, force);
    if (force || movedAtLeast(source, sent.source, cfg.positionEpsilonWorld)) {
      setPosition(panner, source, smooth);
      copyVector(sent.source, source);
    }

    const distance = camera ? Math.max(0.001, distanceBetween(camera.position, source)) : NaN;
    const wantedReference = Number.isFinite(view.referenceDistance) && view.referenceDistance > 0
      ? view.referenceDistance
      : (Number.isFinite(distance) ? distance : 1);
    const referenceDistance = Math.max(0.001, wantedReference);
    const farDistance = farDistanceFor(referenceDistance);
    if (referenceDistance !== sent.referenceDistance || farDistance !== sent.farDistance) {
      panner.refDistance = referenceDistance;
      panner.maxDistance = farDistance;
      sent.referenceDistance = referenceDistance;
      sent.farDistance = farDistance;
    }

    // 0 at the reference distance, 1 at the far distance.
    const farness = Number.isFinite(distance)
      ? smoothstep(distance, referenceDistance, farDistance)
      : 0;

    const lowpassHz = cfg.lowpassNearHz + (cfg.lowpassFarHz - cfg.lowpassNearHz) * farness;
    if (force || !(Math.abs(lowpassHz - sent.lowpassHz) < cfg.lowpassMinChangeHz)) {
      glideParam(context, lowpass.frequency, lowpassHz, { smooth });
      sent.lowpassHz = lowpassHz;
    }

    const wet = cfg.reverbMaxWet * farness;
    const minWetChange = Math.max(
      cfg.minGainChangeAbsolute, cfg.reverbMaxWet * cfg.minGainChangeFraction);
    if (force || !(Math.abs(wet - sent.wet) < minWetChange)) {
      glideParam(context, wetGain.gain, wet, { smooth });
      sent.wet = wet;
    }
  }

  // Per-frame entry. The params already glide on the audio thread, so
  // retargeting them every frame would only churn its automation timeline.
  function update(now, view) {
    if (now - lastSyncMs < cfg.syncIntervalMs) return;
    lastSyncMs = now;
    syncNow(view, { smooth: true }, false);
  }

  function dispose() {
    for (const node of nodes) disconnectQuietly(node);
  }

  return { input: panner, fadeGain, update, syncNow, dispose };
}
