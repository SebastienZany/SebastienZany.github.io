// Boot: load the assets, build the parts, run the frame loop.

import * as THREE from 'three';
import { WORLD_SIZE, SLIME_SIZE, ASSETS, readFlags, deviceProfile } from './config.js';
import { createGpu } from './util/gpu.js';
import { loadBodyGeometry } from './surface/load-mesh.js';
import { createSurface } from './surface/surface.js';
import { createSlimeModel, DEFAULT_SLIME_MODEL } from './slime/model.js';
import { createCameraRig } from './render/camera-rig.js';
import { createBodyView } from './render/body-view.js';
import { createAudio } from './audio/index.js';
import { createGame } from './game/game.js';
import { createPanel } from './ui/panel.js';

const diag = window.__diag ?? { log: (tag, detail) => console.info(`[${tag}]`, detail ?? ''), markLoaded() {}, show() {} };
const stamped = (url) => `${url}?v=${encodeURIComponent(window.__BUILD_VERSION ?? 'dev')}`;

async function boot() {
  const flags = readFlags();
  const profile = deviceProfile(flags);
  const dom = {
    app: document.getElementById('app'),
    canvas: document.getElementById('sim'),
    overlay: document.getElementById('overlay'),
  };

  const renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  // Colours are authored as displayed; no tone mapping, no conversion on output.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const gpu = createGpu(renderer, { pretendMissing: flags.likePhone ? ['floatBlend', 'linearFloat'] : [] });
  diag.log('gpu', JSON.stringify({ ...gpu.caps, ...profile }));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.004, 0.006, 0.005);
  const cameraRig = createCameraRig({ canvas: dom.canvas });
  const camera = cameraRig.camera;

  let resizePending = true;
  function resize() {
    resizePending = false;
    const width = dom.canvas.clientWidth, height = Math.max(dom.canvas.clientHeight, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, profile.maxPixelRatio));
    renderer.setSize(width, height, false);
    cameraRig.setAspect(width / height);
  }
  window.addEventListener('resize', () => { resizePending = true; });
  resize();

  // Until the game is ready, keep the canvas painted so the start screen sits on the scene's dark.
  let game = null;
  let failed = false;
  renderer.setAnimationLoop(() => {
    if (game || failed) return;
    if (resizePending) resize();
    renderer.render(scene, camera);
  });

  dom.canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    failed = true;
    diag.log('gpu', 'context lost');
    game?.fail('The graphics context was lost (usually memory pressure). Reload the page to continue.');
  });

  diag.log('load', 'fetching assets');
  const [geometry, goldTensor, sculptNormals] = await Promise.all([
    loadBodyGeometry(stamped(ASSETS.body), { worldSize: WORLD_SIZE }),
    fetch(stamped(ASSETS.goldFilm)).then((response) => (response.ok ? response.json() : null)).catch(() => null),
    new THREE.TextureLoader().loadAsync(stamped(ASSETS.sculptNormals)).catch(() => null),
  ]);
  if (!goldTensor) diag.log('load', 'gold film data missing; the gold body is off');
  if (sculptNormals) {
    sculptNormals.flipY = false;
    sculptNormals.colorSpace = THREE.NoColorSpace;
    sculptNormals.anisotropy = 8;
    sculptNormals.needsUpdate = true;
  } else {
    diag.log('load', 'sculpt normal map missing; drawing without sculpt detail');
  }

  diag.log('load', 'mapping the body');
  const surface = createSurface({ gpu, geometry, fieldSize: profile.fieldSize, worldSize: WORLD_SIZE });
  diag.log('surface', JSON.stringify({ ...surface.stats, worldPerUv: +surface.worldPerUv.toFixed(3) }));

  const model = createSlimeModel(flags.slime ?? DEFAULT_SLIME_MODEL, { gpu, surface, diag, sizeScale: SLIME_SIZE });
  const bodyView = createBodyView({ gpu, scene, surface, profile, goldTensor, sculptNormals, diag });

  const ctx = { diag, flags, profile, dom, renderer, scene, camera, cameraRig, surface, slimeSize: SLIME_SIZE };
  ctx.audio = createAudio(ctx);
  game = createGame(ctx, { model, bodyView });
  const panel = createPanel(ctx, { model, bodyView, game });

  // One throwaway frame so shader compilation stalls happen before the Begin button appears.
  bodyView.update(model, camera, true);
  renderer.render(scene, camera);

  await game.start();
  diag.markLoaded();

  renderer.setAnimationLoop((now) => {
    if (failed) return;
    if (resizePending) resize();
    game.update(now);
    panel.update(now);
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  });

  // Dev hooks, for the console and for automated checks.
  window.__game = {
    THREE, ctx, gpu, surface, model, bodyView, game, cameraRig,
    /** Run the organism `steps` steps at once, without waiting for frames. */
    growFast(steps = 1000) {
      const now = performance.now();
      for (let i = 0; i < steps; i++) model.step(now + i * 16.6667, 1);
      bodyView.display.markChanged();
    },
  };
}

boot().catch((error) => {
  console.error(error);
  diag.log('fatal', String(error?.stack ?? error).slice(0, 800));
  const status = document.getElementById('startScreenStatus');
  if (status) {
    status.textContent = `could not start: ${error.message}`;
    status.style.color = '#ff8a8a';
  }
  diag.show();
});
