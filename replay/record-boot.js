// Live play with recording on. Loaded instead of main.js when ?rec is present.
//
//   1. install the virtual clock (needed before main.js captures any timestamp,
//      and it also supplies the per-frame hook the recorder samples on)
//   2. boot main.js and let it run normally at real frame rate
//   3. record every frame as resolved intents
//   4. press R to pause and open the render panel
//
// Recording is always on from the moment the world starts. There is nothing to
// arm, so a good session is never lost to having forgotten to press record.

import { installClock, onFrame, clock } from './clock.js';
import { createRecorder } from './recorder.js';
import { installPanel } from './panel.js';
import { pinViewportBeforeBoot } from './viewport.js';

installClock();  // stock rAF semantics — a backgrounded tab stops, as it should
// Before main.js: boot raycasts through the camera to place the initial oat, and
// a collapsed CSS box gives aspect 0 and a singular projection inverse, so the
// ray misses and the food lands via a fallback. See viewport.js. Live play in a
// visible window already has a real box; this only rescues headless/hidden boots.
if (!document.getElementById('sim')?.clientWidth) await pinViewportBeforeBoot(1280, 720);
await import('../main.js');

const api = () => window.__cuttle;
const log = (...a) => console.log('[rec]', ...a);

// wait for the game to finish booting
await new Promise((resolve) => {
  const t = () => (window.__cuttle && document.getElementById('sim') ? resolve() : setTimeout(t, 100));
  t();
});

const qs = new URLSearchParams(location.search);
const seed = qs.has('seed') ? Number(qs.get('seed')) : ((Math.random() * 2 ** 32) >>> 0);
if (qs.get('preset')) api().applySimulationPreset(qs.get('preset'));

const recorder = createRecorder({ api, clock });
recorder.start({ seed });
log('recording from tick 0, seed', seed);

// Sample once per rendered frame. The live loop runs at whatever rate the
// machine manages; each frame is one recorded tick, and replay re-runs that
// same tick count at a fixed step. So a session recorded at 30fps becomes a
// 60fps-smooth render of the same number of simulation steps.
onFrame(() => {
  if (window.__replayPaused) return;
  recorder.sample();
});

installPanel({ recorder, api });

window.__rec = recorder;
log('ready — press R to render');
