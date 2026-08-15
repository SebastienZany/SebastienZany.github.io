import { createHistoryRing, deriveHistorySeries } from './stats-history.js';

export const STATS_POLICY = Object.freeze({
  pollIntervalMs: 650, // main.js:268
  fpsHistoryWeight: 0.92,
  fpsSampleWeight: 0.08,
  minimumReadbackFps: 24, // main.js:270
  maximumReadbackFrameMs: (2.15 * 1000) / 60, // main.js:271 stores 60 Hz frame units.
});

/**
 * Provider contract:
 * - getReadbackEnabled() returns the opt-in flag.
 * - readStats(request) returns free counters plus optional GPU-derived values.
 * - request.readbackPermitted is false when opt-out or frame load suppresses a readback.
 * - historyAgentCount is optional; supplying it records one history sample.
 */
export function createStatsModel({ provider, clock }) {
  if (!provider || typeof provider.readStats !== 'function') throw new TypeError('Stats provider requires readStats()');
  if (!clock || typeof clock.now !== 'function') throw new TypeError('Stats model requires a clock');
  const history = createHistoryRing();
  const listeners = new Set();
  let lastPollMs = 0;
  let pending = false;
  let fps = 60;
  let latest = Object.freeze({ agentCount: 0, oatCount: 0, coverageFraction: 0 });
  let lastRequest = null;

  function notify() {
    const state = getState();
    for (const listener of listeners) listener(state);
    return state;
  }

  function applySnapshot(snapshot, nowMs) {
    if (!snapshot || typeof snapshot !== 'object') return notify();
    latest = Object.freeze({
      agentCount: finiteOr(snapshot.agentCount, latest.agentCount),
      oatCount: finiteOr(snapshot.oatCount, latest.oatCount),
      coverageFraction: finiteOr(snapshot.coverageFraction, latest.coverageFraction),
    });
    if (Number.isFinite(snapshot.historyAgentCount)) {
      history.push({ timeMs: nowMs, agentCount: snapshot.historyAgentCount });
    }
    return notify();
  }

  function poll(nowMs, frameDurationMs) {
    if (pending || nowMs - lastPollMs < STATS_POLICY.pollIntervalMs) return null;
    lastPollMs = nowMs;
    const readbackEnabled = Boolean(provider.getReadbackEnabled?.());
    const underLoad = fps < STATS_POLICY.minimumReadbackFps
      || frameDurationMs > STATS_POLICY.maximumReadbackFrameMs;
    lastRequest = Object.freeze({
      nowMs,
      readbackEnabled,
      skipReadbackUnderLoad: true,
      readbackPermitted: readbackEnabled && !underLoad,
      fps,
      frameDurationMs,
    });
    const result = provider.readStats(lastRequest);
    if (!result || typeof result.then !== 'function') return applySnapshot(result, nowMs);
    pending = true;
    return result
      .then((snapshot) => applySnapshot(snapshot, nowMs))
      .finally(() => { pending = false; });
  }

  function frame({ frameDurationMs = 1000 / 60, nowMs = clock.now() } = {}) {
    const instantFps = 1000 / Math.max(frameDurationMs, 0.001);
    fps = fps * STATS_POLICY.fpsHistoryWeight + instantFps * STATS_POLICY.fpsSampleWeight;
    notify();
    return poll(nowMs, frameDurationMs);
  }

  function getState() {
    const samples = history.toArray();
    return Object.freeze({
      ...latest,
      fps,
      history: Object.freeze(samples),
      series: deriveHistorySeries(samples),
      lastRequest,
      pending,
    });
  }

  return Object.freeze({
    frame,
    getState,
    resetHistory() {
      history.clear();
      return notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

export function mountStats(root, options) {
  if (!root?.ownerDocument) throw new TypeError('Stats root must be a DOM element');
  const document = root.ownerDocument;
  const model = createStatsModel(options);
  const statsGrid = element(document, 'section', 'stats-grid', { 'aria-label': 'Simulation statistics' });
  const lines = {
    agentCount: makeStatLine(document, statsGrid, 'agentCount', 'agents', '0'),
    oatCount: makeStatLine(document, statsGrid, 'oatCount', 'oats', '0'),
    coverageFraction: makeStatLine(document, statsGrid, 'slimeCoverage', 'slime', '0.0%'),
    fps: makeStatLine(document, statsGrid, 'fps', 'fps', '60'),
  };
  const historyPanel = element(document, 'section', 'history-panel', { 'aria-label': 'Agent count history' });
  const historyHead = element(document, 'div', 'history-head');
  historyHead.append('Population');
  const historyRange = element(document, 'output', '', { id: 'agentHistoryRange' });
  historyRange.value = 'waiting';
  historyHead.append(historyRange);
  historyPanel.append(historyHead);
  const canvases = [
    makeCanvas(document, historyPanel, 'agentHistoryChart', 'Population history'),
    makeCanvas(document, historyPanel, 'agentGrowthChart', 'Population growth history'),
    makeCanvas(document, historyPanel, 'agentAccelerationChart', 'Population acceleration history'),
  ];
  root.replaceChildren(statsGrid, historyPanel);

  function render(state) {
    lines.agentCount.textContent = Math.max(0, Math.round(state.agentCount)).toLocaleString();
    lines.oatCount.textContent = String(Math.max(0, Math.round(state.oatCount)));
    lines.coverageFraction.textContent = `${(Math.max(0, state.coverageFraction) * 100).toFixed(1)}%`;
    lines.fps.textContent = String(Math.round(state.fps));
    const populations = state.series.population;
    const current = populations.at(-1) ?? state.agentCount;
    const low = populations.length ? Math.min(...populations) : current;
    const high = populations.length ? Math.max(...populations) : current;
    historyRange.value = `${compactCount(current)} now / ${compactCount(low)}–${compactCount(high)}`;
    drawChart(canvases[0], populations, { label: 'population', color: '#82e7ff', symmetric: false, minimumScale: 1000 });
    drawChart(canvases[1], state.series.growth, { label: 'growth / s', color: '#ffd066', symmetric: true, minimumScale: 25 });
    drawChart(canvases[2], state.series.acceleration, { label: 'acceleration / s²', color: '#ff956c', symmetric: true, minimumScale: 25 });
  }

  const unsubscribe = model.subscribe(render);
  render(model.getState());
  const view = document.defaultView;
  const handleResize = () => render(model.getState());
  view?.addEventListener('resize', handleResize);

  return Object.freeze({
    ...model,
    render: () => render(model.getState()),
    destroy() {
      unsubscribe();
      view?.removeEventListener('resize', handleResize);
      root.replaceChildren();
    },
  });
}

function makeStatLine(document, parent, id, label, initialValue) {
  const item = element(document, 'div', 'stat-line');
  const value = element(document, 'strong', '', { id });
  value.textContent = initialValue;
  const caption = element(document, 'span');
  caption.textContent = label;
  item.append(value, caption);
  parent.append(item);
  return value;
}

function makeCanvas(document, parent, id, label) {
  const canvas = element(document, 'canvas', 'history-chart', { id, 'aria-label': label });
  parent.append(canvas);
  return canvas;
}

function drawChart(canvas, values, { label, color, symmetric, minimumScale }) {
  const widthCssPx = Math.max(240, Math.floor(canvas.clientWidth || 360));
  const heightCssPx = Math.max(48, Math.floor(canvas.clientHeight || 68));
  const dpr = Math.min(canvas.ownerDocument.defaultView?.devicePixelRatio || 1, 2);
  const widthPx = Math.round(widthCssPx * dpr);
  const heightPx = Math.round(heightCssPx * dpr);
  if (canvas.width !== widthPx || canvas.height !== heightPx) {
    canvas.width = widthPx;
    canvas.height = heightPx;
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, widthCssPx, heightCssPx);
  context.fillStyle = 'rgba(2, 7, 8, 0.5)';
  context.fillRect(0, 0, widthCssPx, heightCssPx);
  const plot = { left: 8, right: widthCssPx - 8, top: 17, bottom: heightCssPx - 8 };
  const finite = values.filter(Number.isFinite);
  const maximum = symmetric
    ? Math.max(minimumScale, ...finite.map(Math.abs))
    : Math.max(minimumScale, ...finite);
  const minimum = symmetric ? -maximum : 0;
  const yFor = (value) => plot.bottom - ((value - minimum) / Math.max(0.001, maximum - minimum)) * (plot.bottom - plot.top);
  context.strokeStyle = 'rgba(220, 236, 233, 0.12)';
  context.beginPath();
  context.moveTo(plot.left, yFor(symmetric ? 0 : minimum));
  context.lineTo(plot.right, yFor(symmetric ? 0 : minimum));
  context.stroke();
  context.fillStyle = 'rgba(190, 205, 200, 0.78)';
  context.font = '10px system-ui, sans-serif';
  context.fillText(label, plot.left, 11);
  if (finite.length === 0) return;
  context.beginPath();
  finite.forEach((value, index) => {
    const x = finite.length === 1
      ? plot.right
      : plot.left + (index / (finite.length - 1)) * (plot.right - plot.left);
    const y = yFor(value);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.stroke();
}

function compactCount(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function element(document, tagName, className = '', attributes = {}) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

