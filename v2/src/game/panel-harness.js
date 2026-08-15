import { createParams } from '../shared/params.js';
import { mountPanel } from './panel.js';
import { mountStats } from './stats.js';

const app = document.querySelector('#app');
const panelRoot = document.querySelector('#panelMount');
let nowMs = 0;
let autoAdvance = true;
let paused = false;
let params = createParams();
let agentCount = 6200;
let oatCount = 1;
let coverageFraction = 0;
let panelView;
const commandLog = [];
const patchLog = [];
const fakeClock = Object.freeze({ now: () => nowMs });

const stateProvider = Object.freeze({
  getParams: () => ({ ...params }),
  setParams(patch, context) {
    params = createParams({ ...params, ...patch });
    patchLog.push(Object.freeze({ timeMs: nowMs, patch: { ...patch }, source: context.source }));
  },
  getCameraPose() {
    const orbit = nowMs / 9000;
    const azimuthDeg = (orbit * 180 / Math.PI) % 360;
    const elevationDeg = 18 + Math.sin(orbit) * 7;
    const polarDeg = 90 - elevationDeg;
    const distance = 8.4 + Math.cos(orbit * 0.7) * 0.3;
    const fovDeg = params.useOpticalZoom ? 41 + Math.sin(orbit) * 5 : 45;
    const target = { x: 0, y: 0.14, z: 0 };
    const replay = { azimuthDeg, elevationDeg, polarDeg, distance, fovDeg, target };
    return Object.freeze({
      ...replay,
      command: `window.__v2.panel.setCameraPose(${JSON.stringify(replay)})`,
    });
  },
});

function logCommand(name) {
  commandLog.push(Object.freeze({ name, timeMs: nowMs }));
}

function setPanelsVisible(visible) {
  app.dataset.panelsVisible = String(Boolean(visible));
  panelView?.setVisible(visible);
}

const commands = {
  togglePanels() {
    const next = app.dataset.panelsVisible !== 'true';
    logCommand('togglePanels');
    setPanelsVisible(next);
  },
  skipIntro: () => logCommand('skipIntro'),
  toggleStories() {
    logCommand('toggleStories');
    panelView.model.setParam('storyBoxesEnabled', !params.storyBoxesEnabled);
  },
  toggleSlime: () => logCommand('toggleSlime'),
  toggleGoldBody() {
    logCommand('toggleGoldBody');
    panelView.model.setParam('useGoldWaferBody', !params.useGoldWaferBody);
  },
  toggleAgentDots() {
    logCommand('toggleAgentDots');
    panelView.model.setParam('showAgentDots', !params.showAgentDots);
  },
  togglePause() {
    paused = !paused;
    logCommand(paused ? 'pause' : 'resume');
    return paused;
  },
  reset() {
    agentCount = 6200;
    coverageFraction = 0;
    statsView.resetHistory();
    logCommand('reset');
  },
  resetCamera: () => logCommand('resetCamera'),
  seed() {
    agentCount += 480;
    logCommand('seed');
  },
  initialOat() {
    oatCount = 1;
    logCommand('initialOat');
  },
  copyCameraPose(command) {
    logCommand('copyCameraPose');
    navigator.clipboard?.writeText(command).catch(() => {});
  },
};

panelView = mountPanel(panelRoot, {
  stateProvider,
  commands,
  clock: fakeClock,
  hotspotRoot: app,
});

const statsProvider = Object.freeze({
  getReadbackEnabled: () => params.statsReadbackEnabled,
  readStats(request) {
    if (!paused) {
      const seconds = request.nowMs / 1000;
      agentCount = Math.max(0, Math.round(6200 + seconds * 18 + Math.sin(seconds * 0.45) * 520));
      coverageFraction = Math.min(0.94, 0.06 + seconds / 900);
    }
    return {
      agentCount,
      oatCount,
      coverageFraction: request.readbackPermitted ? coverageFraction : undefined,
      historyAgentCount: request.readbackPermitted ? agentCount : undefined,
    };
  },
});

const statsView = mountStats(panelView.statsRoot, { provider: statsProvider, clock: fakeClock });

function advance(milliseconds, frameDurationMs = milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError('advance milliseconds must be finite and non-negative');
  nowMs += milliseconds;
  panelView.update(nowMs);
  statsView.frame({ nowMs, frameDurationMs: Math.max(0.001, frameDurationMs) });
  return api.state;
}

let previousAnimationMs = null;
function animate(animationMs) {
  const elapsedMs = previousAnimationMs === null ? 1000 / 60 : Math.min(50, animationMs - previousAnimationMs);
  previousAnimationMs = animationMs;
  if (autoAdvance) advance(elapsedMs, elapsedMs);
  requestAnimationFrame(animate);
}

const api = {
  advance,
  setAutoAdvance(enabled) {
    autoAdvance = Boolean(enabled);
  },
  setPanelsVisible,
  setCameraPose(pose) {
    logCommand('setCameraPose');
    return pose;
  },
  get state() {
    return Object.freeze({
      nowMs,
      autoAdvance,
      paused,
      panelsVisible: app.dataset.panelsVisible === 'true',
      params: Object.freeze({ ...params }),
      panel: panelView.getState(),
      stats: statsView.getState(),
      commandLog: Object.freeze([...commandLog]),
      patchLog: Object.freeze([...patchLog]),
    });
  },
};

window.__v2 = Object.freeze({ ...(window.__v2 ?? {}), panel: api });
panelView.update();
requestAnimationFrame(animate);
