import { acquireDevice } from '../device.js';
import { GpuRegistry } from '../registry.js';
import {
  checkR16RenderAndFilter,
  checkReadWriteStorageExtension,
  checkStorageFormat,
  computeSumSmoke,
  renderSmoke,
} from './smoke.js';
import { runWorkloadRehearsal } from './workload.js';

const report = {
  schema: 'v2-capability-probe@1',
  generatedAt: new Date().toISOString(),
  environment: environmentReport(),
  adapter: {},
  limits: {},
  features: [],
  wgslLanguageFeatures: [],
  checks: {},
  workloadRehearsals: [],
  pageFailures: [],
};

let device;
let registry;
let supportsReadWriteStorage = false;
const formatCapabilities = { r16RenderAndFilter: false, rgba16Storage: false };
const ready = initialize();

window.__probe = {
  report,
  ready,
  runWorkload: (options) => runWorkload(options),
  copyReport,
};

window.addEventListener('error', (event) => renderPageFailure(event.error?.message || event.message));
window.addEventListener('unhandledrejection', (event) => renderPageFailure(event.reason?.message || String(event.reason)));
document.querySelector('#copy-json').addEventListener('click', copyReport);
document.querySelector('#run-workload').addEventListener('click', () => runWorkload());

async function initialize() {
  renderReport();
  const acquisition = await acquireDevice({
    onDeviceLost: (info) => setCheck('device-lost', 'FAIL', `${info.reason}: ${info.message}`),
  });
  if (!acquisition.ok) {
    setCheck('device-acquisition', 'FAIL', `${acquisition.stage}: ${acquisition.message}`);
    for (const name of basicGpuCheckNames()) setCheck(name, 'FAIL', 'Device acquisition did not complete.');
    return report;
  }

  device = acquisition.device;
  registry = new GpuRegistry(device);
  report.adapter = acquisition.adapterInfo;
  report.limits = plainLimits(acquisition.adapter.limits);
  report.features = acquisition.adapterFeatures;
  report.wgslLanguageFeatures = [...(navigator.gpu.wgslLanguageFeatures || [])].sort();
  report.enabledDeviceFeatures = acquisition.enabledFeatures;
  setCheck('device-acquisition', 'PASS', acquisition.message);

  device.addEventListener('uncapturederror', (event) => {
    event.preventDefault();
    setCheck('uncaptured-gpu-errors', 'FAIL', event.error?.message || 'Unknown WebGPU error');
  });
  setCheck('shader-f16', featureStatus('shader-f16'), featureDetail('shader-f16'));
  setCheck('float32-filterable', featureStatus('float32-filterable'), featureDetail('float32-filterable'));
  setCheck('texture-formats-tier1', featureStatus('texture-formats-tier1'), featureDetail('texture-formats-tier1'));

  const languageFeature = 'readonly_and_readwrite_storage_textures';
  const languageAdvertised = report.wgslLanguageFeatures.includes(languageFeature);
  await runCheck('read-write-storage-textures', async () => {
    if (!languageAdvertised) throw new Error(`${languageFeature} is not advertised by navigator.gpu.wgslLanguageFeatures`);
    const detail = await checkReadWriteStorageExtension(device, registry);
    supportsReadWriteStorage = true;
    return { languageAdvertised, ...detail };
  });
  await runCheck('r32float-storage', () => checkStorageFormat(device, registry, 'r32float'));
  await runCheck('r16float-render-filter', async () => {
    const detail = await checkR16RenderAndFilter(device, registry);
    formatCapabilities.r16RenderAndFilter = true;
    return detail;
  });
  await runCheck('rgba16float-storage', async () => {
    const detail = await checkStorageFormat(device, registry, 'rgba16float');
    formatCapabilities.rgba16Storage = true;
    return detail;
  });
  await runCheck('compute-sum', () => computeSumSmoke(device, registry));
  await runCheck('render-smoke', () => renderSmoke(device, registry));
  setCheck('uncaptured-gpu-errors', report.checks['uncaptured-gpu-errors']?.status || 'PASS',
    report.checks['uncaptured-gpu-errors']?.detail || 'No uncaptured GPU errors.');

  const automaticSeconds = Number(new URLSearchParams(location.search).get('workload'));
  if (Number.isFinite(automaticSeconds) && automaticSeconds > 0) {
    setTimeout(() => runWorkload({ durationMs: automaticSeconds * 1000 }), 0);
  }
  return report;
}

async function runWorkload(options = {}) {
  await ready;
  if (!device) {
    setCheck('workload-rehearsal', 'FAIL', 'No WebGPU device is available.');
    return report.workloadRehearsals.at(-1);
  }
  const button = document.querySelector('#run-workload');
  const status = document.querySelector('#workload-status');
  const size = Number(options.size || document.querySelector('#target-size').value);
  const durationMs = Number(options.durationMs || document.querySelector('#duration').value);
  button.disabled = true;
  status.textContent = 'Starting…';
  const rehearsal = await runWorkloadRehearsal(device, registry, {
    size,
    durationMs,
    supportsReadWriteStorage,
    formatCapabilities,
    onProgress: ({ message }) => { status.textContent = message; },
  });
  report.workloadRehearsals.push(rehearsal);
  setCheck('workload-rehearsal', rehearsal.status, rehearsal.status === 'PASS'
    ? `${rehearsal.targetSize} complete; peak ${rehearsal.peakAllocation.formatted}; actual fill ${rehearsal.actualFillPath}.`
    : rehearsal.message);
  status.textContent = rehearsal.status === 'PASS' ? 'Complete.' : `Failed: ${rehearsal.message}`;
  button.disabled = false;
  renderReport();
  return rehearsal;
}

async function runCheck(name, operation) {
  try {
    const detail = await operation();
    setCheck(name, 'PASS', detail);
  } catch (error) {
    setCheck(name, 'FAIL', error instanceof Error ? error.message : String(error));
  }
}

function setCheck(name, status, detail) {
  report.checks[name] = { status, detail };
  let row = document.querySelector(`[data-check="${name}"]`);
  if (!row) {
    row = document.createElement('li');
    row.dataset.check = name;
    row.innerHTML = '<strong></strong><span></span><small></small>';
    document.querySelector('#checks').append(row);
  }
  row.dataset.status = status;
  row.querySelector('strong').textContent = status;
  row.querySelector('span').textContent = name;
  row.querySelector('small').textContent = typeof detail === 'string' ? detail : JSON.stringify(detail);
  renderReport();
}

function renderReport() {
  document.querySelector('#report-json').textContent = JSON.stringify(report, null, 2);
  document.querySelector('#environment').textContent = JSON.stringify(report.environment, null, 2);
  document.querySelector('#adapter').textContent = JSON.stringify({
    info: report.adapter,
    features: report.features,
    limits: report.limits,
    wgslLanguageFeatures: report.wgslLanguageFeatures,
  }, null, 2);
}

async function copyReport() {
  const json = JSON.stringify(report, null, 2);
  const status = document.querySelector('#copy-status');
  try {
    await navigator.clipboard.writeText(json);
    status.textContent = 'Copied.';
  } catch {
    const textArea = document.createElement('textarea');
    textArea.value = json;
    document.body.append(textArea);
    textArea.select();
    const copied = document.execCommand('copy');
    textArea.remove();
    status.textContent = copied ? 'Copied.' : 'Copy failed; select the JSON below manually.';
  }
  return json;
}

function renderPageFailure(message) {
  report.pageFailures.push({ at: new Date().toISOString(), message });
  const row = document.createElement('li');
  row.textContent = message;
  document.querySelector('#page-failures').append(row);
  document.querySelector('#failure-panel').hidden = false;
  renderReport();
}

function environmentReport() {
  const phoneDefault = navigator.userAgentData?.mobile
    || matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 900;
  queueMicrotask(() => { document.querySelector('#target-size').value = phoneDefault ? '1024' : '1536'; });
  return {
    userAgent: navigator.userAgent,
    devicePixelRatio,
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight },
    deviceMemoryGiB: navigator.deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    preferredCanvasFormat: navigator.gpu?.getPreferredCanvasFormat?.() ?? null,
    phoneDefault,
  };
}

function plainLimits(limits) {
  const names = new Set([...Object.keys(limits), ...Object.getOwnPropertyNames(Object.getPrototypeOf(limits))]);
  return Object.fromEntries([...names].filter((name) => typeof limits[name] === 'number').sort().map((name) => [name, limits[name]]));
}

function featureStatus(name) {
  return report.features.includes(name) ? 'PASS' : 'FAIL';
}

function featureDetail(name) {
  return report.features.includes(name) ? `${name} is advertised and enabled.` : `${name} is not advertised.`;
}

function basicGpuCheckNames() {
  return [
    'shader-f16', 'float32-filterable', 'texture-formats-tier1', 'read-write-storage-textures',
    'r32float-storage', 'r16float-render-filter', 'rgba16float-storage', 'compute-sum', 'render-smoke',
    'uncaptured-gpu-errors',
  ];
}
