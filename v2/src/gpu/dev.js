import { acquireDevice } from './device.js';
import { GpuRegistry } from './registry.js';

const CLEAR_COLOR = Object.freeze({ r: 0.004, g: 0.006, b: 0.005, a: 1 });
const state = {
  device: null,
  registry: null,
  uncapturedErrors: [],
  clearPixel: null,
  clearPixelReady: null,
  ready: null,
  async readClearPixel() {
    await state.ready;
    return state.clearPixelReady;
  },
};
window.__v2 = state;
state.ready = initialize();

async function initialize() {
  const errors = document.querySelector('#errors');
  const acquisition = await acquireDevice({
    onDeviceLost: ({ reason, message }) => showError(`Device lost (${reason}): ${message}`),
  });
  if (!acquisition.ok) {
    showError(`${acquisition.stage}: ${acquisition.message}`);
    document.querySelector('#status').textContent = 'WebGPU unavailable';
    return state;
  }

  const device = acquisition.device;
  const registry = new GpuRegistry(device);
  state.device = device;
  state.registry = registry;
  device.addEventListener('uncapturederror', (event) => {
    event.preventDefault();
    const message = event.error?.message || 'Unknown WebGPU error';
    state.uncapturedErrors.push(message);
    showError(message);
  });

  const canvas = document.querySelector('#surface');
  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: 'opaque',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = registry.createBuffer({
    label: 'dev-clear-pixel-readback',
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  let resolveClearPixel;
  state.clearPixelReady = new Promise((resolve) => { resolveClearPixel = resolve; });
  let pixelReadScheduled = false;
  let previousFrameTime = null;
  let smoothedFps = 0;

  function frame(frameTime) {
    resizeCanvas(canvas);
    const currentTexture = context.getCurrentTexture();
    const encoder = device.createCommandEncoder({ label: 'dev-clear-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'dev-clear-pass',
      colorAttachments: [{
        view: currentTexture.createView(),
        clearValue: CLEAR_COLOR,
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.end();
    if (!pixelReadScheduled) {
      encoder.copyTextureToBuffer(
        { texture: currentTexture, origin: [Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)] },
        { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
        [1, 1],
      );
      pixelReadScheduled = true;
    }
    device.queue.submit([encoder.finish()]);

    if (state.clearPixel === null && pixelReadScheduled && readback.mapState === 'unmapped') {
      readback.mapAsync(GPUMapMode.READ).then(() => {
        const storageOrder = [...new Uint8Array(readback.getMappedRange()).slice(0, 4)];
        state.clearPixel = format.startsWith('bgra')
          ? [storageOrder[2], storageOrder[1], storageOrder[0], storageOrder[3]]
          : storageOrder;
        readback.unmap();
        resolveClearPixel(state.clearPixel);
      }).catch((error) => showError(`Clear-pixel readback failed: ${error.message}`));
    }

    if (previousFrameTime !== null) {
      const instantaneousFps = 1000 / Math.max(0.01, frameTime - previousFrameTime);
      smoothedFps = smoothedFps === 0 ? instantaneousFps : smoothedFps * 0.92 + instantaneousFps * 0.08;
      document.querySelector('#fps').textContent = smoothedFps.toFixed(1);
    }
    previousFrameTime = frameTime;
    requestAnimationFrame(frame);
  }

  errors.hidden = true;
  document.querySelector('#status').textContent = 'WebGPU ready';
  requestAnimationFrame(frame);
  return state;
}

function resizeCanvas(canvas) {
  const width = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
  const height = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function showError(message) {
  const errors = document.querySelector('#errors');
  errors.hidden = false;
  const row = document.createElement('li');
  row.textContent = message;
  errors.querySelector('ul').append(row);
}

window.addEventListener('error', (event) => showError(event.error?.message || event.message));
window.addEventListener('unhandledrejection', (event) => showError(event.reason?.message || String(event.reason)));
