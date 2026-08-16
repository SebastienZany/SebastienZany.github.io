// Live play with recording on. Loaded instead of main.js when ?rec is present.
//
//   1. install the virtual clock (needed before main.js captures any timestamp,
//      and it also supplies the per-frame hook the recorder samples on)
//   2. boot main.js and let it run normally at real frame rate
//   3. ARM the recorder passively — recording begins at the Begin click
//   4. press R to pause and open the render panel
//
// PASSIVE is the load-bearing word. An earlier version called recorder.start()
// at boot, which ran resetSimulation({spawnAgents: true}) — spawning the colony
// before the start screen was even dismissed. Visitors got agents ahead of the
// intro, seeding at the wrong time, and story callouts that never fired. The
// recorder must never mutate the world; it only watches. Genesis is the Begin
// click: the RNG is seeded and the header captured in a capture-phase listener
// that runs before main.js's own click handler touches anything, so the header
// describes the exact pre-click world that replay's begin() reconstructs.

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

// Everything past this point is OBSERVATION. If any of it throws, the visitor
// must still get the stock game — a recorder bug may cost a recording, never
// the piece. (The previous default-boot regression is why this paranoia earns
// its keep.)
try {
  const qs = new URLSearchParams(location.search);
  const seed = qs.has('seed') ? Number(qs.get('seed')) : ((Math.random() * 2 ** 32) >>> 0);
  if (qs.get('preset')) api().applySimulationPreset(qs.get('preset'));

  const recorder = createRecorder({
    api, clock,
    buildStamp: document.querySelector('meta[name=build]')?.content ?? null,
  });

  // Genesis: the Begin click. Capture phase on window fires before the button's
  // own handler, so the seed lands before anything the click consumes and the
  // header is a snapshot of the world the click is about to change. Keyboard
  // activation of the button (Enter/Space) also dispatches a click, so one
  // listener covers every way the piece can start.
  window.addEventListener('click', (e) => {
    if (recorder.recording) return;
    const el = e.target instanceof Element ? e.target.closest('#startButton') : null;
    if (!el) return;
    try {
      recorder.startFromHere({ seed });
      log('recording from the Begin click, seed', seed);
    } catch (err) { console.warn('[rec] failed to start recording', err); }
  }, { capture: true });

  // S skips the intro, which changes when the colony is seeded — a sim-affecting
  // input, so it must be in the recording. Captured here (not in recorder.hook)
  // because it is a DOM gesture, not an api() mutator. Replay re-dispatches the
  // same keydown so main.js's own handler does the skipping.
  window.addEventListener('keydown', (e) => {
    if (!recorder.recording || window.__replayPaused) return;
    if (e.key !== 's' && e.key !== 'S') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    recorder.logEvent('skipIntro', {});
  }, { capture: true });

  // Sample once per rendered frame. The live loop runs at whatever rate the
  // machine manages; each frame is one recorded tick carrying the rawDt it ran
  // with, and replay re-runs that same tick sequence at a fixed output rate. So
  // a session recorded at 30fps becomes a 60fps-smooth render of the same steps.
  onFrame(() => {
    if (window.__replayPaused) return;
    try { recorder.sample(); } catch (err) {
      // One warning, then stand down — never spam or slow the frame loop.
      if (!window.__recSampleFailed) {
        window.__recSampleFailed = true;
        console.warn('[rec] sampling failed; recording disabled for this session', err);
      }
      window.__replayPaused = true;
    }
  });

  installPanel({ recorder, api });

  window.__rec = recorder;
  log('armed — recording starts at the Begin click; press R for the render panel');
} catch (err) {
  console.warn('[rec] recorder failed to arm; the game continues without it', err);
}
