import { acquireDevice } from './gpu/device.js';
import { GpuRegistry } from './gpu/registry.js';
import { createLookCamera } from './render/camera.js';
import { createSyntheticDisplayChain } from './render/display-chain.js';
import { loadTwoChartSphereFixture } from './render/fixture-mesh.js';
import { loadGoldLutTexture } from './render/gold-lut-texture.js';
import { createMaterialUniformWriter } from './render/material-uniforms.js';
import { createFixtureMeshRenderer } from './render/renderer.js';
import { SURFACE_PARAM_CONTROLS } from './render/surface-params.js';
import { createSyntheticFieldProvider } from './shared/field-provider.js';
import { createParams } from './shared/params.js';

const canvas = document.querySelector('#lookSurface');
const look = {
  device: null,
  registry: null,
  params: createParams(),
  uncapturedErrors: [],
  renderTestFrame: null,
  scanForNonFinite: null,
  ready: null,
};
window.__v2 = { look };
look.ready = initialize();
window.__v2.ready = look.ready;

async function initialize() {
  const acquisition = await acquireDevice({
    onDeviceLost: ({ reason, message }) => showError(`Device lost (${reason}): ${message}`),
  });
  if (!acquisition.ok) {
    document.querySelector('#status').textContent = 'WebGPU unavailable';
    showError(`${acquisition.stage}: ${acquisition.message}`);
    return look;
  }

  look.device = acquisition.device;
  look.registry = new GpuRegistry(look.device);
  look.device.addEventListener('uncapturederror', (event) => {
    event.preventDefault();
    const message = event.error?.message || 'Unknown WebGPU error';
    look.uncapturedErrors.push(message);
    showError(message);
  });
  const reportCompilationMessage = (message) => {
    if (message.type === 'error') showError(`[${message.shader}] ${message.message}`);
    else console.warn(`[${message.shader}] ${message.message}`);
  };

  const fieldProvider = createSyntheticFieldProvider(look.device, look.registry, { size: 256 });
  const [mesh, goldLut] = await Promise.all([
    loadTwoChartSphereFixture({ device: look.device, registry: look.registry }),
    loadGoldLutTexture({ device: look.device, registry: look.registry }),
  ]);
  const displayChain = await createSyntheticDisplayChain({
    device: look.device,
    registry: look.registry,
    fieldProvider,
    onCompilationMessage: reportCompilationMessage,
  });
  const cameraRig = createLookCamera({ device: look.device, registry: look.registry, canvas });
  const materialUniforms = createMaterialUniformWriter({
    device: look.device,
    registry: look.registry,
    fieldSize: fieldProvider.size,
    lut: goldLut,
  });
  materialUniforms.write(look.params);
  const renderer = await createFixtureMeshRenderer({
    device: look.device,
    registry: look.registry,
    canvas,
    cameraRig,
    materialUniforms,
    mesh,
    displayChain,
    goldLut,
    onCompilationMessage: reportCompilationMessage,
  });

  installSurfaceControls(materialUniforms);
  look.renderTestFrame = async () => {
    fieldProvider.frame({ timeMs: 0, force: true });
    const encoder = look.device.createCommandEncoder({ label: 'look-test-frame-encoder' });
    displayChain.encode(encoder, look.params);
    renderer.encodeTestFrame(encoder, look.params);
    look.device.queue.submit([encoder.finish()]);
    return renderer.readTestStats();
  };
  look.scanForNonFinite = () => displayChain.scanForNonFinite();
  document.querySelector('#status').textContent = `${mesh.name} · ${displayChain.displayFormat} display · orbit enabled`;
  startAnimation({ fieldProvider, displayChain, renderer });
  return look;
}

function startAnimation({ fieldProvider, displayChain, renderer }) {
  const frame = (timeMs) => {
    fieldProvider.frame({ timeMs });
    const encoder = look.device.createCommandEncoder({ label: 'look-frame-encoder' });
    displayChain.encode(encoder, look.params);
    renderer.encodeCanvas(encoder, look.params);
    look.device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function installSurfaceControls(materialUniforms) {
  const controls = document.querySelector('#controls');
  for (const description of SURFACE_PARAM_CONTROLS) {
    const { parameterName, parameter } = description;
    const label = document.createElement('label');
    const copy = document.createElement('span');
    const title = document.createElement('span');
    const help = document.createElement('span');
    const input = document.createElement('input');
    const output = document.createElement('output');
    copy.className = 'copy';
    title.textContent = description.label;
    help.className = 'help';
    help.tabIndex = 0;
    help.textContent = '?';
    help.title = description.help;
    copy.append(title, help);
    input.id = `look-${parameterName}`;

    if (parameter.type === 'number') {
      label.className = 'number-control';
      input.type = 'range';
      Object.assign(input, { min: parameter.min, max: parameter.max, step: parameter.step });
      input.value = look.params[parameterName];
      output.value = formatNumber(look.params[parameterName], parameter.step);
      input.addEventListener('input', () => {
        look.params[parameterName] = Number(input.value);
        output.value = formatNumber(look.params[parameterName], parameter.step);
        materialUniforms.write(look.params);
      });
      label.append(copy, input, output);
    } else if (parameter.type === 'boolean') {
      label.className = 'toggle-control';
      input.type = 'checkbox';
      input.checked = look.params[parameterName];
      input.addEventListener('input', () => {
        look.params[parameterName] = input.checked;
        materialUniforms.write(look.params);
      });
      label.append(copy, input);
    } else if (parameter.type === 'color') {
      label.className = 'colour-control';
      input.type = 'color';
      input.value = look.params[parameterName];
      input.addEventListener('input', () => {
        look.params[parameterName] = input.value;
        materialUniforms.write(look.params);
      });
      label.append(copy, input);
    }
    controls.append(label);
  }
}

function formatNumber(value, step) {
  const precision = Math.max(0, Math.min(4, String(step).split('.')[1]?.length ?? 0));
  return Number(value).toFixed(precision);
}

function showError(message) {
  const errors = document.querySelector('#errors');
  errors.hidden = false;
  errors.textContent += `${errors.textContent ? '\n' : ''}${message}`;
}

window.addEventListener('error', (event) => showError(event.error?.message || event.message));
window.addEventListener('unhandledrejection', (event) => showError(event.reason?.message || String(event.reason)));
