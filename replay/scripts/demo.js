// Hand-authored input script — the stand-in for a recorded intent stream.
//
// Shape is deliberately the same as what a real recording replays: a sparse map
// of tickIndex -> fn, applied at the top of that tick, before simulate(). The
// values are *resolved intents* (a camera pose, an oat UV), not raw DOM events,
// which is the recording principle the plan settled on.
//
// tickIndex is 0-based from the start of capture. Each fn receives the
// resolved __cuttle object (renderVideo calls fn(api())).

const TAU = Math.PI * 2;

export default function demo(api, { W = 1280, H = 720 } = {}) {
  const c = api();
  const script = {};

  // --- camera: slow orbit, sampled every tick ------------------------------
  const start = c.getCameraPose();
  const target = { x: start.target.x, y: start.target.y, z: start.target.z };
  const radius = start.distance;
  const elevRad = (start.elevationDeg * Math.PI) / 180;
  const startAz = (start.azimuthDeg * Math.PI) / 180;

  const ORBIT_TICKS = 900;          // one full sweep budget
  const SWEEP = TAU * 0.16;         // don't go all the way round; keep the good side

  for (let t = 0; t < ORBIT_TICKS; t++) {
    const p = t / ORBIT_TICKS;
    // ease-in-out so the move starts and ends calmly
    const eased = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;
    const az = startAz + SWEEP * eased;
    const y = target.y + radius * Math.sin(elevRad);
    const horiz = radius * Math.cos(elevRad);
    script[t] = (c) => {
      c.setCameraPose({
        position: { x: target.x + horiz * Math.sin(az), y, z: target.z + horiz * Math.cos(az) },
        target,
        fovDeg: start.fovDeg,
      });
    };
  }

  // --- oats: a few placements partway through ------------------------------
  // Offsets around the initial oat's UV, which is known to be on valid chart.
  const base = c.oats?.[0]?.uv ? { x: c.oats[0].uv.x, y: c.oats[0].uv.y } : { x: 0.912, y: 0.503 };
  const drops = [
    { at: 120, du: -0.05, dv: 0.04 },
    { at: 300, du: 0.04, dv: -0.05 },
    { at: 520, du: -0.08, dv: -0.03 },
    { at: 700, du: 0.06, dv: 0.06 },
  ];

  const placed = [];
  for (const d of drops) {
    const prev = script[d.at];
    script[d.at] = (c) => {
      if (prev) prev(c);
      const u = Math.min(0.999, Math.max(0.001, base.x + d.du));
      const v = Math.min(0.999, Math.max(0.001, base.y + d.dv));
      const before = c.oats.length;
      try { c.addOat(u, v); } catch (e) { /* rejected uv — recorded either way */ }
      placed.push({ tick: d.at, u: +u.toFixed(4), v: +v.toFixed(4), accepted: c.oats.length > before });
    };
  }

  script.__meta = { orbitTicks: ORBIT_TICKS, drops: drops.length, placed };
  return script;
}
