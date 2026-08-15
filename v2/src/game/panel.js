import { RENDER_PRESETS, SIMULATION_PRESETS } from '../shared/params.js';
import { createTripleTapStateMachine, routeHotkey } from './hotkeys.js';
import { PANEL_GROUPS } from './panel-controls.js';
import { createPanelModel } from './panel-model.js';

const CAMERA_READOUT_INTERVAL_MS = 150; // main.js:1229
const DEBUG_VIEW_LABELS = Object.freeze({
  slime: 'Slime',
  food: 'Food',
  'chart-id': 'Chart ID',
  seam: 'Seam frames',
  domain: 'Simulation domain',
  gutter: 'Gutter',
});

/**
 * State provider contract: getParams() returns the shared parameter object and
 * setParams(patch, context) accepts changes. Optional getCameraPose() supplies
 * the 150 ms readout. Commands are zero-argument hooks except copyCameraPose.
 */
export function mountPanel(root, {
  stateProvider,
  commands = {},
  clock,
  eventTarget = root?.ownerDocument?.defaultView,
  hotspotRoot = root?.parentElement,
} = {}) {
  if (!root?.ownerDocument) throw new TypeError('Panel root must be a DOM element');
  if (!stateProvider || typeof stateProvider.getParams !== 'function') {
    throw new TypeError('Panel state provider requires getParams()');
  }
  if (!clock || typeof clock.now !== 'function') throw new TypeError('Panel requires a clock');
  const document = root.ownerDocument;
  const controls = new Map();
  let collapsed = false;
  let paused = false;
  let visible = true;
  let lastCameraReadoutMs = -Infinity;
  let latestCameraPose = null;

  const model = createPanelModel({
    values: stateProvider.getParams(),
    onPatch(patch, context) {
      if (typeof stateProvider.setParams === 'function') stateProvider.setParams(patch, context);
      else if (typeof stateProvider.setParam === 'function') {
        for (const [name, value] of Object.entries(patch)) stateProvider.setParam(name, value, context);
      } else {
        throw new TypeError('Panel state provider requires setParams() or setParam()');
      }
    },
  });

  const panel = element(document, 'section', 'control-panel', {
    'aria-label': 'Simulation controls',
    'aria-hidden': 'false',
  });
  const header = element(document, 'header', 'panel-header');
  const heading = element(document, 'div', 'panel-heading');
  const title = element(document, 'h1');
  title.textContent = 'A Bestiary of Vanishings';
  const status = element(document, 'p', 'panel-status', { role: 'status' });
  status.textContent = 'DOM control-surface harness';
  heading.append(title, status);
  const tools = element(document, 'div', 'panel-tools');
  const collapseButton = button(document, 'Hide parameters', 'collapsePanel');
  const pauseButton = button(document, 'Pause', 'pause');
  tools.append(collapseButton, pauseButton);
  header.append(heading, tools);
  panel.append(header);

  const body = element(document, 'div', 'panel-body', { id: 'panelBody', 'aria-hidden': 'false' });
  const statsRoot = element(document, 'div', 'panel-stats-mount');
  body.append(statsRoot, makePresetControls(document, model));
  const controlStack = element(document, 'div', 'control-stack');
  for (const group of PANEL_GROUPS) {
    const section = makeControlGroup(document, group, model, controls);
    if (group.id === 'debug') section.append(makeCameraReadout(document));
    controlStack.append(section);
  }
  body.append(controlStack, makeActions(document, commands));
  panel.append(body);
  root.replaceChildren(panel);

  const cameraElements = Object.freeze({
    azimuthDeg: panel.querySelector('[data-camera="azimuthDeg"]'),
    elevationDeg: panel.querySelector('[data-camera="elevationDeg"]'),
    polarDeg: panel.querySelector('[data-camera="polarDeg"]'),
    distance: panel.querySelector('[data-camera="distance"]'),
    fovDeg: panel.querySelector('[data-camera="fovDeg"]'),
    target: panel.querySelector('[data-camera="target"]'),
    command: panel.querySelector('[data-camera-command]'),
  });

  const copyCameraButton = panel.querySelector('[data-copy-camera]');
  copyCameraButton.addEventListener('click', () => {
    const command = latestCameraPose?.command ?? cameraElements.command.textContent;
    commands.copyCameraPose?.(command, latestCameraPose);
  });
  collapseButton.addEventListener('click', () => setCollapsed(!collapsed));
  pauseButton.addEventListener('click', () => {
    const result = commands.togglePause?.();
    setPaused(typeof result === 'boolean' ? result : !paused);
  });

  const unsubscribe = model.subscribe(syncFromModel);
  syncFromModel(model.getState());

  const handleKeydown = (event) => routeHotkey(event, commands);
  eventTarget?.addEventListener?.('keydown', handleKeydown);
  const hotspot = mountTouchHotspot(document, hotspotRoot, clock, commands);

  function syncFromModel(state) {
    for (const [parameterName, binding] of controls) binding.write(state.params[parameterName]);
    panel.querySelector('[data-preset="simulation"]').value = state.simulationPresetId;
    panel.querySelector('[data-preset="render"]').value = state.renderPresetId;
    syncObservationStyles(document.documentElement.style, state.params);
  }

  function setCollapsed(nextCollapsed) {
    collapsed = Boolean(nextCollapsed);
    panel.classList.toggle('is-collapsed', collapsed);
    body.setAttribute('aria-hidden', String(collapsed));
    collapseButton.setAttribute('aria-expanded', String(!collapsed));
    collapseButton.textContent = collapsed ? 'Show parameters' : 'Hide parameters';
  }

  function setPaused(nextPaused) {
    paused = Boolean(nextPaused);
    pauseButton.textContent = paused ? 'Resume' : 'Pause';
    pauseButton.setAttribute('aria-pressed', String(paused));
  }

  function setVisible(nextVisible) {
    visible = Boolean(nextVisible);
    panel.setAttribute('aria-hidden', String(!visible));
  }

  function update(nowMs = clock.now()) {
    if (nowMs - lastCameraReadoutMs < CAMERA_READOUT_INTERVAL_MS) return;
    lastCameraReadoutMs = nowMs;
    const pose = stateProvider.getCameraPose?.();
    if (!pose) return;
    latestCameraPose = pose;
    cameraElements.azimuthDeg.textContent = degrees(pose.azimuthDeg);
    cameraElements.elevationDeg.textContent = degrees(pose.elevationDeg);
    cameraElements.polarDeg.textContent = degrees(pose.polarDeg);
    cameraElements.distance.textContent = fixed(pose.distance, 3);
    cameraElements.fovDeg.textContent = degrees(pose.fovDeg);
    cameraElements.target.textContent = formatTarget(pose.target);
    cameraElements.command.textContent = pose.command ?? 'Camera provider did not supply a replay command.';
  }

  return Object.freeze({
    model,
    statsRoot,
    update,
    setCollapsed,
    setPaused,
    setVisible,
    refresh: () => model.replaceValues(stateProvider.getParams()),
    getState: () => Object.freeze({ ...model.getState(), collapsed, paused, visible, cameraPose: latestCameraPose }),
    destroy() {
      unsubscribe();
      eventTarget?.removeEventListener?.('keydown', handleKeydown);
      hotspot?.remove();
      root.replaceChildren();
    },
  });
}

function makePresetControls(document, model) {
  const stack = element(document, 'div', 'preset-stack');
  stack.append(
    makePresetSelect(document, 'Simulation', 'simulation', SIMULATION_PRESETS, (id) => model.applySimulationPreset(id)),
    makePresetSelect(document, 'Render', 'render', RENDER_PRESETS, (id) => model.applyRenderPreset(id)),
  );
  return stack;
}

function makePresetSelect(document, label, kind, presets, apply) {
  const row = element(document, 'label', 'preset-row');
  const copy = element(document, 'span');
  copy.textContent = label;
  const select = element(document, 'select', '', { 'data-preset': kind, 'aria-label': `${label} parameter preset` });
  select.append(makeOption(document, 'custom', 'Custom'));
  for (const preset of presets) select.append(makeOption(document, preset.id, preset.label, preset.note));
  select.addEventListener('change', () => {
    if (select.value !== 'custom') apply(select.value);
  });
  row.append(copy, select);
  return row;
}

function makeControlGroup(document, group, model, controls) {
  const section = element(document, 'section', 'control-group', { 'aria-labelledby': `group-${group.id}` });
  const heading = element(document, 'h2', '', { id: `group-${group.id}` });
  heading.textContent = group.label;
  section.append(heading);
  for (const control of group.controls) section.append(makeControlRow(document, control, model, controls));
  return section;
}

function makeControlRow(document, control, model, controls) {
  const row = element(document, 'div', `control-row control-${control.widget}`, { 'data-param-row': control.parameterName });
  const copy = element(document, 'div', 'control-copy');
  const label = element(document, 'label', '', { for: `param-${control.parameterName}` });
  label.textContent = control.label;
  copy.append(label, makeHelpTip(document, control));
  const input = makeInput(document, control);
  const output = element(document, 'output', '', { for: input.id });
  const read = () => control.widget === 'checkbox'
    ? input.checked
    : control.widget === 'range' || control.widget === 'number' ? Number(input.value) : input.value;
  const eventName = control.widget === 'checkbox' || control.widget === 'select' ? 'change' : 'input';
  input.addEventListener(eventName, () => model.setParam(control.parameterName, read()));
  controls.set(control.parameterName, {
    write(value) {
      if (control.widget === 'checkbox') input.checked = Boolean(value);
      else input.value = String(value);
      output.value = formatValue(value, control);
      output.textContent = output.value;
    },
  });
  row.append(copy, input, output);
  return row;
}

function makeInput(document, control) {
  if (control.widget === 'select') {
    const select = element(document, 'select', '', { id: `param-${control.parameterName}`, 'data-param': control.parameterName });
    for (const choice of control.choices) select.append(makeOption(document, choice, DEBUG_VIEW_LABELS[choice] ?? choice));
    return select;
  }
  const input = element(document, 'input', '', { id: `param-${control.parameterName}`, 'data-param': control.parameterName });
  input.type = control.widget;
  if (control.min !== null) input.min = String(control.min);
  if (control.max !== null) input.max = String(control.max);
  if (control.step !== null) input.step = String(control.step);
  return input;
}

function makeHelpTip(document, control) {
  const tip = button(document, '?');
  tip.className = 'help-tip';
  tip.setAttribute('aria-label', `Help: ${control.help}`);
  const tooltip = element(document, 'span', 'help-text', { role: 'tooltip' });
  tooltip.textContent = control.help;
  tip.append(tooltip);
  for (const eventName of ['pointerdown', 'click']) {
    tip.addEventListener(eventName, (event) => event.stopPropagation());
  }
  return tip;
}

function makeCameraReadout(document) {
  const readout = element(document, 'section', 'camera-readout', { 'aria-label': 'Camera pose' });
  const grid = element(document, 'dl', 'camera-grid');
  const fields = [
    ['azimuthDeg', 'Azimuth'],
    ['elevationDeg', 'Elevation'],
    ['polarDeg', 'Polar'],
    ['distance', 'Distance'],
    ['fovDeg', 'FOV'],
    ['target', 'Target'],
  ];
  for (const [name, label] of fields) {
    const item = element(document, 'div');
    const term = element(document, 'dt');
    term.textContent = label;
    const value = element(document, 'dd', '', { 'data-camera': name });
    value.textContent = '—';
    item.append(term, value);
    grid.append(item);
  }
  const command = element(document, 'pre', 'camera-command', { 'data-camera-command': '' });
  command.textContent = 'Waiting for camera provider.';
  const copy = button(document, 'Copy camera pose');
  copy.setAttribute('data-copy-camera', '');
  readout.append(grid, command, copy);
  return readout;
}

function makeActions(document, commands) {
  const actions = element(document, 'div', 'panel-actions');
  for (const [label, commandName] of [['Reset', 'reset'], ['Reset camera', 'resetCamera'], ['Seed', 'seed'], ['Initial oat', 'initialOat']]) {
    const action = button(document, label);
    action.setAttribute('data-command', commandName);
    action.addEventListener('click', () => commands[commandName]?.());
    actions.append(action);
  }
  return actions;
}

function mountTouchHotspot(document, parent, clock, commands) {
  if (!parent?.append) return null;
  const hotspot = element(document, 'div', 'panel-touch-hotspot', { id: 'panelTouchToggle', 'aria-hidden': 'true' });
  const gesture = createTripleTapStateMachine({ clock, onTripleTap: () => commands.togglePanels?.() });
  hotspot.addEventListener('pointerdown', (event) => gesture.pointerDown(event));
  hotspot.addEventListener('pointerup', (event) => gesture.pointerUp(event));
  hotspot.addEventListener('pointercancel', () => gesture.pointerCancel());
  parent.append(hotspot);
  return hotspot;
}

function syncObservationStyles(style, params) {
  const featherPx = Math.max(0, params.observationEdgeFeather);
  style.setProperty('--observation-stroke-opacity', params.observationStrokeOpacity.toFixed(3));
  style.setProperty('--observation-corner-radius', `${params.observationCornerRadius.toFixed(1)}px`);
  style.setProperty('--observation-edge-feather', `${featherPx.toFixed(1)}px`);
  style.setProperty('--observation-edge-feather-outset', `${(featherPx * 1.75).toFixed(1)}px`);
  style.setProperty('--observation-edge-feather-mask', `${(featherPx * 2.6).toFixed(1)}px`);
  style.setProperty('--observation-edge-feather-opacity', Math.min(1, featherPx / 8).toFixed(3));
  style.setProperty('--observation-blur-radius', `${params.observationBlurRadius.toFixed(1)}px`);
  style.setProperty('--observation-tint-rgb', hexRgb(params.observationTintColor));
  style.setProperty('--observation-tint-opacity', params.observationTintOpacity.toFixed(3));
  style.setProperty('--observation-text-rgb', hexRgb(params.slimeBaseColor));
}

function formatValue(value, control) {
  if (control.widget === 'checkbox' || control.widget === 'select') return '';
  if (control.widget === 'color') return String(value).toUpperCase();
  const { scale = 1, suffix = '', digits = inferredDigits(control.step, scale) } = control.format;
  return `${(Number(value) * scale).toFixed(digits)}${suffix}`;
}

function inferredDigits(step, scale) {
  const text = String((step ?? 0.01) * scale);
  return Math.min(4, text.includes('.') ? text.length - text.indexOf('.') - 1 : 0);
}

function hexRgb(hex) {
  const value = Number.parseInt(String(hex).replace('#', ''), 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

function formatTarget(target) {
  const values = Array.isArray(target) ? target : [target?.x, target?.y, target?.z];
  return values.map((value) => fixed(value, 2)).join(', ');
}

function degrees(value) {
  return `${fixed(value, 2)}deg`;
}

function fixed(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function makeOption(document, value, label, title = '') {
  const option = element(document, 'option', '', { value });
  option.textContent = label;
  if (title) option.title = title;
  return option;
}

function button(document, label, id = '') {
  const node = element(document, 'button', '', id ? { id } : {});
  node.type = 'button';
  node.textContent = label;
  return node;
}

function element(document, tagName, className = '', attributes = {}) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}
