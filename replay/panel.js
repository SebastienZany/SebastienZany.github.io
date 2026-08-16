// In-game recording UI.
//
// Press R to pause and open the render panel. Recording itself is always on
// from the moment the world starts, so there is nothing to arm — R is purely
// "pause and open the panel", with no special recording semantics.
//
// The panel's Render button hands off by RELOADING into ?render&replay=<file>.
// That is deliberate: the WebGL context attributes are fixed at construction,
// the canvas pointer listeners must not be attached during a render, and the
// virtual clock has to be installed before main.js captures any timestamp.
// Switching modes in place cannot satisfy any of those.
//
// Loaded only when ?rec is present, so the normal play path is untouched.

const STYLE = `
.replay-panel {
  position: fixed; inset: 0; z-index: 99999;
  display: flex; align-items: center; justify-content: center;
  background: rgba(4,6,7,0.82); backdrop-filter: blur(6px);
  font: 13px/1.5 ui-monospace, Menlo, monospace; color: #eef5f2;
}
.replay-panel__card {
  width: min(520px, calc(100vw - 40px));
  background: rgba(17,21,23,0.96); border: 1px solid rgba(223,234,232,0.16);
  border-radius: 14px; padding: 20px 22px;
  box-shadow: 0 24px 80px rgba(0,0,0,0.6);
}
.replay-panel h2 { margin: 0 0 4px; font-size: 14px; color: #8ce8ff; font-weight: 600; }
.replay-panel .sub { margin: 0 0 16px; color: #a8b6b1; font-size: 12px; }
.replay-panel label { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 5px 0; }
.replay-panel select, .replay-panel input {
  background: rgba(30,36,39,0.9); color: #eef5f2;
  border: 1px solid rgba(223,234,232,0.18); border-radius: 7px;
  padding: 5px 8px; font: inherit; min-width: 150px;
}
.replay-panel__row { display: flex; gap: 8px; margin-top: 16px; }
.replay-panel button {
  flex: 1; padding: 9px 12px; border-radius: 8px; font: inherit; cursor: pointer;
  background: #6ddf81; color: #08110b; border: 0; font-weight: 600;
}
.replay-panel button.secondary { background: rgba(223,234,232,0.1); color: #eef5f2; }
.replay-panel__note { margin-top: 14px; color: #7f8c89; font-size: 11px; line-height: 1.45; }
.replay-panel__stat { color: #ffcd58; }
`;

export function installPanel({ recorder, api }) {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);

  let open = false;
  let root = null;

  // R freezes the WORLD, not just the sampler. Freezing only the sampler (the
  // old behaviour) let the game keep running under the panel while no ticks
  // were being recorded — the recording and the world silently desynced for as
  // long as the panel stayed open. simulateEnabled false + sampler paused stop
  // both together; oat food decay still runs on the wall clock while frozen,
  // which is a small, accepted infidelity of resuming after a panel visit.
  const freeze = () => { window.__replayPaused = true; api().setSimulateEnabled?.(false); };
  const resume = () => { window.__replayPaused = false; api().setSimulateEnabled?.(true); };

  // A recognizable, sortable name shared by the .cvr and any render made from
  // it: bestiary-2026-08-16-0432-1236t
  const recName = () => {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `bestiary-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
      + `-${p2(d.getHours())}${p2(d.getMinutes())}-${recorder.tick}t`;
  };

  // Opening the panel immediately banks the session so far: the .cvr downloads
  // AND lands in IndexedDB before the user chooses anything. A recording is
  // minutes of a player's attention; it must never depend on the next click
  // going well. Snapshot, not stop — recording continues if they go back.
  let lastBankedTick = -1;
  async function bankRecording() {
    if (!recorder.tick || recorder.tick === lastBankedTick) return null;
    lastBankedTick = recorder.tick;
    const name = `${recName()}.cvr`;
    const snapshot = JSON.stringify(recorder.toJSON());
    try {
      const { saveRecording, deliverFile } = await import('./store.js');
      await saveRecording(name, JSON.parse(snapshot));
      const save = await deliverFile(name, snapshot, 'application/json');
      console.log('[rec] session banked:', name, save);
      return name;
    } catch (err) {
      console.warn('[rec] failed to bank the session', err);
      return null;
    }
  }

  const est = (w, h, fps, speed) => {
    // ~130-160ms/frame measured at 720p; scale by pixel count
    const frames = Math.ceil((recorder.tick / (60 * speed)) * fps);
    const msPerFrame = 130 * ((w * h) / (1280 * 720));
    return { frames, minutes: +((frames * msPerFrame) / 60000).toFixed(1) };
  };

  function close() {
    open = false;
    root?.remove();
    root = null;
  }

  function render() {
    root = document.createElement('div');
    root.className = 'replay-panel';
    const s = recorder.stats();
    root.innerHTML = `
      <div class="replay-panel__card">
        <h2>Render replay</h2>
        <p class="sub">
          <span class="replay-panel__stat">${s.tick}</span> ticks over
          ${s.wallSeconds}s of play (${s.liveFps ?? '—'} fps) &middot;
          ${s.events} events &middot; ${s.cameraKeys} camera keys
        </p>
        <label>Resolution
          <select id="rp-res">
            <option value="854x480">854 × 480</option>
            <option value="1280x720" selected>1280 × 720</option>
            <option value="1920x1080">1920 × 1080</option>
            <option value="2560x1440">2560 × 1440</option>
          </select>
        </label>
        <label>Frame rate
          <select id="rp-fps">
            <option value="24">24 fps</option>
            <option value="30">30 fps</option>
            <option value="60" selected>60 fps</option>
          </select>
        </label>
        <label>Speed
          <select id="rp-speed">
            <option value="0.5">0.5× (slow motion)</option>
            <option value="1" selected>1× (realtime)</option>
            <option value="2">2× (time-lapse)</option>
          </select>
        </label>
        <label>Quality
          <select id="rp-bpp">
            <option value="0.08">Smaller file</option>
            <option value="0.12" selected>Default</option>
            <option value="0.20">Archival</option>
          </select>
        </label>
        <div class="replay-panel__row">
          <button id="rp-go">Render</button>
          <button id="rp-cancel" class="secondary">Back to session</button>
        </div>
        <p class="replay-panel__note" id="rp-note"></p>
      </div>`;
    document.body.append(root);

    const $ = (id) => root.querySelector(id);
    const note = $('#rp-note');

    const refresh = () => {
      const [w, h] = $('#rp-res').value.split('x').map(Number);
      const fps = Number($('#rp-fps').value);
      const speed = Number($('#rp-speed').value);
      const e = est(w, h, fps, speed);
      // Replay runs the recorded ticks at a FIXED 60Hz, so the movie's length is
      // totalTicks/60/speed regardless of how fast the session actually ran.
      const outSec = (recorder.tick / 60 / speed).toFixed(1);
      note.innerHTML =
        `~<span class="replay-panel__stat">${e.frames}</span> frames &rarr; ` +
        `<span class="replay-panel__stat">${outSec}s</span> of video, ` +
        `estimated <span class="replay-panel__stat">~${e.minutes} min</span> to render. ` +
        `Replay re-runs the recorded ticks at a fixed 60Hz, so output length is set by ` +
        `tick count, not by how fast the session ran. Rendering reloads the page and ` +
        `re-simulates — the live session ends here, and the result is visually faithful, ` +
        `not pixel-identical.`;
    };
    for (const id of ['#rp-res', '#rp-fps', '#rp-speed']) $(id).addEventListener('change', refresh);
    refresh();

    $('#rp-cancel').addEventListener('click', () => { close(); resume(); });
    $('#rp-go').addEventListener('click', async () => {
      const [w, h] = $('#rp-res').value.split('x').map(Number);
      const fps = $('#rp-fps').value;
      const speed = $('#rp-speed').value;
      const bpp = $('#rp-bpp').value;

      // Seal the recording synchronously, before any async work, so nothing
      // can be appended after the cutoff. The name matches the .cvr that was
      // banked when the panel opened — the world is frozen, so the tick count
      // (and therefore the name) cannot have moved since.
      const recording = recorder.stop();
      const name = `${recName()}.cvr`;
      // IndexedDB, not the dev server: on the real site there is nothing to POST
      // to, so the reload would fetch a file that does not exist and the harness
      // would die parsing the host's HTML 404 page as JSON.
      const { saveRecording } = await import('./store.js');
      await saveRecording(name, recording);

      const p = new URLSearchParams({
        render: '', dev: '', auto: '1', replay: name,
        w: String(w), h: String(h), fps, speed, bpp,
        name: name.replace('.cvr', '.mp4'),
      });
      location.search = `?${p.toString()}`;
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'r' && e.key !== 'R') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    if (open) { close(); resume(); return; }
    // Nothing to render before the Begin click — recording starts there.
    if (!recorder.recording && !recorder.tick) {
      console.log('[rec] no session yet — recording starts when Begin is clicked');
      return;
    }
    open = true;
    freeze();
    // Bank first, panel second — the download must not depend on anything the
    // panel does afterwards.
    bankRecording().catch(() => {});
    render();
  });

  return { close, get open() { return open; } };
}
