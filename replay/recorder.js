// Session recorder.
//
// Records RESOLVED INTENTS, not raw DOM events: the camera pose the renderer
// actually used, the mouse-repel tuple the shader actually read, and oat
// placements with the raycast's resolved worldPos/worldNormal. Raw pointer
// events cannot be replayed faithfully — coalescing rate varies run to run,
// OrbitControls carries hidden damping state, and the pick raycast depends on
// camera and aspect.
//
// FIDELITY NOTE — read this before trusting a replay.
//
// Replay is visually faithful, NOT bit-exact. Measured on this machine: from
// bit-identical restored state, with the clock held offline and the allocation
// counter pinned, 200 ticks of simulation still produce field sums varying by
// ~1-2%. The cause is the additive float blending of ~590k point splats into
// the density/deposit targets: float addition is not associative and the driver
// does not guarantee a stable fragment order at that overdraw. Eliminating it
// means replacing the splat with deterministic integer accumulation or a gather
// pass — a shader rewrite, deliberately out of scope here.
//
// What that means in practice: a replay reproduces the session's *structure* —
// same oats at the same ticks in the same places, same camera move, same
// timing, same growth arc — but the fine tendril detail will differ. For a
// 60fps render of a session that is the honest and useful guarantee.

const FORMAT_VERSION = 3;

/** Quantise a float to a fixed number of decimals for compact storage. */
const q = (v, dp = 4) => +Number(v).toFixed(dp);

export function createRecorder({ api, clock, buildStamp = null }) {
  const state = {
    recording: false,
    header: null,
    camera: [],        // [tick, x, y, z, tx, ty, tz, fov] — change-gated
    repel: [],         // [tick, active, u, v, chartId] — change-gated
    events: [],        // [{ tick, phase, type, ...payload }]
    lastCamKey: '',
    lastRepelKey: '',
    tick: 0,
    unhooks: [],
  };

  const c = () => api();

  function captureHeader() {
    const a = c();
    const p = a.params;
    const pose = a.getCameraPose();
    return {
      formatVersion: FORMAT_VERSION,
      buildStamp,
      createdAt: new Date().toISOString(),
      simHz: 60,
      dt: 1.0,                       // main.js normalises rawDt to 60fps frames
      // environment/profile — a replay must boot into the same one
      env: {
        fieldSize: a.FIELD_SIZE ?? null,
        renderer: a.rendererInfo ?? null,
        viewport: pose.viewport,
      },
      // simulation identity
      rngSeed: state.seed,
      allocFrame: a.getAgentAllocationFrame ? a.getAgentAllocationFrame() : null,
      params: JSON.parse(JSON.stringify(p)),
      initialOats: (a.oats ?? []).map((o) => ({
        uv: o.uv ? [q(o.uv.x, 6), q(o.uv.y, 6)] : null,
        power: o.power,
        initial: !!o.initial,
        suppressObservation: !!o.suppressObservation,
      })),
      startPose: {
        position: [q(pose.position.x, 6), q(pose.position.y, 6), q(pose.position.z, 6)],
        target: [q(pose.target.x, 6), q(pose.target.y, 6), q(pose.target.z, 6)],
        fovDeg: pose.fovDeg,
      },
    };
  }

  /** Sample per-tick continuous state. Change-gated: identical frames cost 0 bytes. */
  function sample() {
    if (!state.recording) return;
    const a = c();

    const pose = a.getCameraPose();
    const cam = [
      q(pose.position.x), q(pose.position.y), q(pose.position.z),
      q(pose.target.x), q(pose.target.y), q(pose.target.z),
      q(pose.fovDeg, 3),
    ];
    const camKey = cam.join(',');
    if (camKey !== state.lastCamKey) {
      state.camera.push([state.tick, ...cam]);
      state.lastCamKey = camKey;
    }

    const m = a.getMouseRepelState ? a.getMouseRepelState() : null;
    if (m) {
      // Exact float32 for the UV: it feeds a continuous penalty and strict
      // comparison branches in the agent shader, so sub-texel rounding can flip
      // a branch. Quantising here was a real bug in an earlier draft.
      const rep = [m.active ? 1 : 0, m.uv?.x ?? 0, m.uv?.y ?? 0, m.chartId ?? 0];
      const repKey = rep.join(',');
      if (repKey !== state.lastRepelKey) {
        state.repel.push([state.tick, ...rep]);
        state.lastRepelKey = repKey;
      }
    }

    state.tick++;
  }

  function logEvent(type, payload, phase = 'preSim') {
    if (!state.recording) return;
    state.events.push({ tick: state.tick, phase, type, ...payload });
  }

  /** Wrap the mutators that reach simulation state so their intents are recorded. */
  function hook() {
    const a = c();

    const origAddOat = a.addOat;
    a.addOat = function wrappedAddOat(u, v, opts) {
      const before = a.oats.length;
      const result = origAddOat.call(this, u, v, opts);
      logEvent('addOat', {
        uv: [u, v],
        worldPos: opts?.worldPos ? [q(opts.worldPos.x, 6), q(opts.worldPos.y, 6), q(opts.worldPos.z, 6)] : null,
        worldNormal: opts?.worldNormal ? [q(opts.worldNormal.x, 6), q(opts.worldNormal.y, 6), q(opts.worldNormal.z, 6)] : null,
        // Outcome, so a divergent replay fails loudly instead of silently:
        // addOat can reject (bounds, chart, proximity) or evict at MAX_OATS.
        accepted: a.oats.length > before,
        oatsLength: a.oats.length,
      });
      return result;
    };
    state.unhooks.push(() => { a.addOat = origAddOat; });

    const origClear = a.clearAllOats;
    if (origClear) {
      a.clearAllOats = function wrappedClear(...args) {
        logEvent('clearOats', { oatsBefore: a.oats.length });
        return origClear.apply(this, args);
      };
      state.unhooks.push(() => { a.clearAllOats = origClear; });
    }

    const origReset = a.resetSimulation;
    a.resetSimulation = function wrappedReset(opts = {}) {
      // Composite: resetSimulation nests clearAllOats/addInitialOat/initAgents.
      // Recording those children as independent events would double-apply them
      // on replay, so the composite carries what the children resolved to.
      const r = origReset.call(this, opts);
      logEvent('resetSimulation', {
        resetOats: !!opts.resetOats,
        spawnAgents: opts.spawnAgents !== false,
        resolvedOats: (a.oats ?? []).map((o) => (o.uv ? [q(o.uv.x, 6), q(o.uv.y, 6)] : null)),
        allocFrame: a.getAgentAllocationFrame ? a.getAgentAllocationFrame() : null,
      });
      return r;
    };
    state.unhooks.push(() => { a.resetSimulation = origReset; });
  }

  return {
    get recording() { return state.recording; },
    get tick() { return state.tick; },
    sample,
    logEvent,

    start({ seed = (Math.random() * 2 ** 32) >>> 0 } = {}) {
      const a = c();
      state.seed = seed >>> 0;
      a.seedSimRng(state.seed);
      a.resetSimulation({ resetOats: true, spawnAgents: true });

      state.recording = true;
      state.tick = 0;
      state.camera = [];
      state.repel = [];
      state.events = [];
      state.lastCamKey = '';
      state.lastRepelKey = '';
      state.header = captureHeader();
      hook();
      return state.header;
    },

    stop() {
      state.recording = false;
      for (const u of state.unhooks.splice(0)) u();
      return this.toJSON();
    },

    toJSON() {
      return {
        ...state.header,
        totalTicks: state.tick,
        camera: state.camera,
        repel: state.repel,
        events: state.events,
      };
    },

    stats() {
      return {
        tick: state.tick,
        cameraKeys: state.camera.length,
        repelKeys: state.repel.length,
        events: state.events.length,
      };
    },
  };
}

/** Apply a recording's per-tick state and events. Mirrors the recorder exactly. */
export function createPlayer({ api, recording }) {
  const c = () => api();

  // index the sparse change-gated streams by tick
  const camAt = new Map();
  for (const row of recording.camera) camAt.set(row[0], row.slice(1));
  const repAt = new Map();
  for (const row of recording.repel) repAt.set(row[0], row.slice(1));
  const evAt = new Map();
  for (const e of recording.events) {
    if (!evAt.has(e.tick)) evAt.set(e.tick, []);
    evAt.get(e.tick).push(e);
  }

  let lastCam = null;
  const mismatches = [];

  return {
    get mismatches() { return mismatches; },

    /** Restore the world to the recording's opening state. */
    begin() {
      const a = c();
      a.seedSimRng(recording.rngSeed);
      if (recording.params) Object.assign(a.params, recording.params);
      a.resetSimulation({ resetOats: true, spawnAgents: true });
      if (recording.allocFrame != null && a.setAgentAllocationFrame) {
        a.setAgentAllocationFrame(recording.allocFrame);
      }
      const p = recording.startPose;
      a.setCameraPose({
        position: { x: p.position[0], y: p.position[1], z: p.position[2] },
        target: { x: p.target[0], y: p.target[1], z: p.target[2] },
        fovDeg: p.fovDeg,
      });
    },

    /** Apply everything scheduled for `tick`, before simulate() runs. */
    applyTick(tick) {
      const a = c();

      const cam = camAt.get(tick) ?? lastCam;
      if (cam) {
        a.setCameraPose({
          position: { x: cam[0], y: cam[1], z: cam[2] },
          target: { x: cam[3], y: cam[4], z: cam[5] },
          fovDeg: cam[6],
        });
        lastCam = cam;
      }

      const rep = repAt.get(tick);
      if (rep && a.setMouseRepelState) {
        a.setMouseRepelState({ active: !!rep[0], uv: { x: rep[1], y: rep[2] }, chartId: rep[3] });
      }

      for (const e of evAt.get(tick) ?? []) {
        if (e.type === 'addOat') {
          const before = a.oats.length;
          a.addOat(e.uv[0], e.uv[1], e.worldPos ? {
            worldPos: { x: e.worldPos[0], y: e.worldPos[1], z: e.worldPos[2] },
            worldNormal: e.worldNormal
              ? { x: e.worldNormal[0], y: e.worldNormal[1], z: e.worldNormal[2] }
              : undefined,
          } : undefined);
          const accepted = a.oats.length > before;
          if (accepted !== e.accepted) {
            mismatches.push({ tick, type: 'addOat', expected: e.accepted, got: accepted });
          }
        } else if (e.type === 'clearOats') {
          a.clearAllOats();
        }
        // resetSimulation is intentionally NOT replayed here: begin() already
        // established the opening state, and re-running it mid-replay would
        // re-seed agents and desync the whole run.
      }
    },
  };
}
