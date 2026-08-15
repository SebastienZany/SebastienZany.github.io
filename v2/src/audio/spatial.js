import { TUMBLE_SPATIAL } from './clips.js';
import { rampAudioParam } from './audio-param.js';

const ORIGIN = Object.freeze({ x: 0, y: 0, z: 0 });

/**
 * Resolves the audible organism position without depending on sim types.
 * Precedence and oat weighting preserve main.js:8564-8578.
 */
export function resolveAudioSourceWorldPos(snapshot = {}) {
  const introWorldPos = finiteVector(snapshot.introSpriteWorldPos);
  if (introWorldPos) return introWorldPos;

  const weighted = { x: 0, y: 0, z: 0 };
  let totalWeight = 0;
  for (const oat of snapshot.oats ?? []) {
    const worldPos = finiteVector(oat?.worldPos);
    if (!worldPos) continue;
    const numericPower = Number(oat.power);
    const weight = Math.max(0.1, numericPower || 1);
    weighted.x += worldPos.x * weight;
    weighted.y += worldPos.y * weight;
    weighted.z += worldPos.z * weight;
    totalWeight += weight;
  }
  if (totalWeight > 0) {
    return { x: weighted.x / totalWeight, y: weighted.y / totalWeight, z: weighted.z / totalWeight };
  }

  return finiteVector(snapshot.initialHitWorldPos)
    ?? finiteVector(snapshot.targetWorldPos)
    ?? { ...ORIGIN };
}

/** Default provider until the sim and camera supply live snapshots in M7. */
export function createStubPositionProvider() {
  let sourceSnapshot = { oats: [], targetWorldPos: { ...ORIGIN } };
  let listenerPose = {
    position: { x: 0, y: 0, z: 4 },
    forward: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
    maximumDistance: 5.6 * 4,
  };

  return Object.freeze({
    getSourceSnapshot: () => sourceSnapshot,
    getListenerPose: () => listenerPose,
    setSourceSnapshot(nextSnapshot) { sourceSnapshot = nextSnapshot ?? {}; },
    setListenerPose(nextPose) { listenerPose = { ...listenerPose, ...nextPose }; },
  });
}

export function createTumbleSpatialGraph(context, masterGain, {
  positionProvider,
  volume,
  random = Math.random,
} = {}) {
  const sourceSnapshot = positionProvider.getSourceSnapshot();
  const sourceWorldPos = resolveAudioSourceWorldPos(sourceSnapshot);
  const listenerPose = positionProvider.getListenerPose();
  const referenceTarget = finiteVector(sourceSnapshot.targetWorldPos) ?? sourceWorldPos;
  const referenceDistance = Math.max(0.001, distance(listenerPose.position, referenceTarget));
  const fallbackFarDistance = referenceDistance * 2;
  const maximumDistance = Number.isFinite(listenerPose.maximumDistance)
    ? listenerPose.maximumDistance
    : fallbackFarDistance;
  const farDistance = Math.max(referenceDistance + 0.001, maximumDistance || fallbackFarDistance);

  const graph = {
    panner: context.createPanner(),
    fadeGain: context.createGain(),
    distanceFilter: context.createBiquadFilter(),
    volumeGain: context.createGain(),
    dryGain: context.createGain(),
    reverbSendGain: context.createGain(),
    reverbWetGain: context.createGain(),
    convolver: context.createConvolver(),
    referenceDistance,
    farDistance,
    lastSyncMilliseconds: -Infinity,
    lastPannerWorldPos: null,
    lastListenerPosition: null,
    lastListenerForward: null,
    lastListenerUp: null,
    lastVolume: NaN,
    lastLowpassHz: NaN,
    lastWet: NaN,
  };

  graph.convolver.buffer = makeTumbleReverbImpulse(context, random);
  Object.assign(graph.panner, {
    panningModel: TUMBLE_SPATIAL.panningModel,
    distanceModel: TUMBLE_SPATIAL.distanceModel,
    refDistance: referenceDistance,
    maxDistance: farDistance,
    rolloffFactor: TUMBLE_SPATIAL.pannerRolloff,
    coneInnerAngle: TUMBLE_SPATIAL.coneInnerAngleDegrees,
    coneOuterAngle: TUMBLE_SPATIAL.coneOuterAngleDegrees,
  });
  graph.distanceFilter.type = 'lowpass';
  const initialDistance = Math.max(0.001, distance(listenerPose.position, sourceWorldPos));
  const initialTargets = distanceTargets(initialDistance, referenceDistance, farDistance);
  setParamNow(graph.fadeGain.gain, 0.0001, context);
  setParamNow(graph.distanceFilter.frequency, initialTargets.lowpassHz, context);
  setParamNow(graph.distanceFilter.Q, TUMBLE_SPATIAL.lowpassQ, context);
  setParamNow(graph.volumeGain.gain, volume, context);
  setParamNow(graph.dryGain.gain, 1, context);
  setParamNow(graph.reverbSendGain.gain, 1, context);
  setParamNow(graph.reverbWetGain.gain, initialTargets.wet, context);

  graph.panner.connect(graph.fadeGain);
  graph.fadeGain.connect(graph.distanceFilter);
  graph.distanceFilter.connect(graph.volumeGain);
  graph.volumeGain.connect(graph.dryGain);
  graph.volumeGain.connect(graph.reverbSendGain);
  graph.reverbSendGain.connect(graph.convolver);
  graph.convolver.connect(graph.reverbWetGain);
  graph.dryGain.connect(masterGain);
  graph.reverbWetGain.connect(masterGain);
  return graph;
}

export function makeTumbleReverbImpulse(context, random = Math.random) {
  const length = Math.max(1, Math.floor(context.sampleRate * TUMBLE_SPATIAL.reverbSeconds));
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const samples = impulse.getChannelData(channel);
    for (let sampleIndex = 0; sampleIndex < length; sampleIndex++) {
      const progress = sampleIndex / Math.max(1, length - 1);
      const decayEnvelope = (1 - progress) ** TUMBLE_SPATIAL.reverbDecay;
      const earlyLift = 0.36 + 0.64 * Math.min(
        1,
        sampleIndex / (context.sampleRate * TUMBLE_SPATIAL.reverbEarlyLiftSeconds),
      );
      samples[sampleIndex] = (random() * 2 - 1) * decayEnvelope * earlyLift * TUMBLE_SPATIAL.reverbAmplitude;
    }
  }
  return impulse;
}

export function syncTumbleSpatialGraph(graph, context, clock, positionProvider, volume, { force = false, smooth = true } = {}) {
  const nowMilliseconds = Number(clock.now());
  if (!force && nowMilliseconds - graph.lastSyncMilliseconds < TUMBLE_SPATIAL.syncIntervalMilliseconds) {
    return { updated: false, volume };
  }
  if (!force) graph.lastSyncMilliseconds = nowMilliseconds;

  const sourceWorldPos = resolveAudioSourceWorldPos(positionProvider.getSourceSnapshot());
  const listenerPose = positionProvider.getListenerPose();
  if (force || vectorMoved(sourceWorldPos, graph.lastPannerWorldPos, TUMBLE_SPATIAL.positionEpsilonWorld)) {
    setNodePosition(graph.panner, sourceWorldPos, context, smooth);
    graph.lastPannerWorldPos = sourceWorldPos;
  }
  if (force || vectorMoved(listenerPose.position, graph.lastListenerPosition, TUMBLE_SPATIAL.positionEpsilonWorld)) {
    setNodePosition(context.listener, listenerPose.position, context, smooth);
    graph.lastListenerPosition = copyVector(listenerPose.position);
  }
  if (
    force
    || directionMoved(listenerPose.forward, graph.lastListenerForward)
    || directionMoved(listenerPose.up, graph.lastListenerUp)
  ) {
    setListenerOrientation(context.listener, listenerPose.forward, listenerPose.up, context, smooth);
    graph.lastListenerForward = normalized(listenerPose.forward);
    graph.lastListenerUp = normalized(listenerPose.up);
  }

  const sourceDistance = Math.max(0.001, distance(listenerPose.position, sourceWorldPos));
  const targets = distanceTargets(sourceDistance, graph.referenceDistance, graph.farDistance);
  const minimumVolumeDelta = Math.max(TUMBLE_SPATIAL.volumeEpsilonMinimum, volume * TUMBLE_SPATIAL.volumeEpsilonRatio);
  if (force || !Number.isFinite(graph.lastVolume) || Math.abs(volume - graph.lastVolume) >= minimumVolumeDelta) {
    rampAudioParam(graph.volumeGain.gain, volume, context, { smooth });
    graph.lastVolume = volume;
  }
  if (force || !Number.isFinite(graph.lastLowpassHz) || Math.abs(targets.lowpassHz - graph.lastLowpassHz) >= TUMBLE_SPATIAL.lowpassEpsilonHz) {
    rampAudioParam(graph.distanceFilter.frequency, targets.lowpassHz, context, { smooth });
    graph.lastLowpassHz = targets.lowpassHz;
  }
  const minimumWetDelta = Math.max(
    TUMBLE_SPATIAL.wetEpsilonMinimum,
    TUMBLE_SPATIAL.reverbMaximumWet * TUMBLE_SPATIAL.wetEpsilonRatio,
  );
  if (force || !Number.isFinite(graph.lastWet) || Math.abs(targets.wet - graph.lastWet) >= minimumWetDelta) {
    rampAudioParam(graph.reverbWetGain.gain, targets.wet, context, { smooth });
    graph.lastWet = targets.wet;
  }
  return { updated: true, volume, sourceWorldPos, distance: sourceDistance, ...targets };
}

export function distanceTargets(sourceDistance, referenceDistance, farDistance) {
  const linearProgress = clamp((sourceDistance - referenceDistance) / (farDistance - referenceDistance), 0, 1);
  const smoothProgress = linearProgress * linearProgress * (3 - 2 * linearProgress);
  return {
    progress: smoothProgress,
    lowpassHz: TUMBLE_SPATIAL.lowpassNearHz
      + (TUMBLE_SPATIAL.lowpassFarHz - TUMBLE_SPATIAL.lowpassNearHz) * smoothProgress,
    wet: TUMBLE_SPATIAL.reverbMaximumWet * smoothProgress,
  };
}

function setNodePosition(node, worldPos, context, smooth) {
  if (node.positionX) {
    setSpatialTarget(node.positionX, worldPos.x, context, smooth);
    setSpatialTarget(node.positionY, worldPos.y, context, smooth);
    setSpatialTarget(node.positionZ, worldPos.z, context, smooth);
  } else {
    node.setPosition?.(worldPos.x, worldPos.y, worldPos.z);
  }
}

function setListenerOrientation(listener, forward, up, context, smooth) {
  const forwardUnit = normalized(forward);
  const upUnit = normalized(up);
  if (listener.forwardX) {
    setSpatialTarget(listener.forwardX, forwardUnit.x, context, smooth);
    setSpatialTarget(listener.forwardY, forwardUnit.y, context, smooth);
    setSpatialTarget(listener.forwardZ, forwardUnit.z, context, smooth);
    setSpatialTarget(listener.upX, upUnit.x, context, smooth);
    setSpatialTarget(listener.upY, upUnit.y, context, smooth);
    setSpatialTarget(listener.upZ, upUnit.z, context, smooth);
  } else {
    listener.setOrientation?.(forwardUnit.x, forwardUnit.y, forwardUnit.z, upUnit.x, upUnit.y, upUnit.z);
  }
}

function setSpatialTarget(audioParam, value, context, smooth) {
  audioParam.cancelScheduledValues(context.currentTime);
  if (smooth) audioParam.setTargetAtTime(value, context.currentTime, TUMBLE_SPATIAL.spatialSmoothSeconds);
  else audioParam.setValueAtTime(value, context.currentTime);
}

function setParamNow(audioParam, value, context) {
  audioParam.setValueAtTime(value, context.currentTime);
}

function vectorMoved(next, previous, epsilon) {
  return !previous || squaredDistance(next, previous) >= epsilon * epsilon;
}

function directionMoved(next, previous) {
  return !previous || 1 - dot(normalized(next), previous) >= TUMBLE_SPATIAL.directionEpsilon;
}

function finiteVector(value) {
  if (![value?.x, value?.y, value?.z].every(Number.isFinite)) return null;
  return copyVector(value);
}

function copyVector(value) {
  return { x: value.x, y: value.y, z: value.z };
}

function normalized(value) {
  const length = Math.hypot(value.x, value.y, value.z) || 1;
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function distance(left, right) {
  return Math.sqrt(squaredDistance(left, right));
}

function squaredDistance(left, right) {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2;
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
