// A player whose job is to make the STORY CALLOUTS appear.
//
// A text box is not scripted — it is earned. updateObservationSlimeTriggers
// polls a GPU readback of the slime score over each oat and fires
// triggerOatObservation only once it clears
// params.observationSlimeTriggerThreshold (0.05). So a callout appears only when
// the colony has actually grown over that oat.
//
// A geometric ring does not work: the colony does not spread symmetrically
// across the mesh, so most ring positions never get any slime at all. Measured
// on a ring of 7: two triggered (scores 0.058, 0.059) and five sat at exactly
// 0.0 for the whole session.
//
// So place food where the slime already is — which is also what a player does.
// Each placement reads the field around the colony and picks the strongest texel
// that is far enough from every existing oat to survive isOatTooClose, which
// requires BOTH:
//     uv distance    >= max(OAT_MIN_PLACEMENT_UV_DISTANCE, r + r) = 0.05
//     world distance >= OAT_MIN_PLACEMENT_WORLD_DISTANCE = 0.48
// (DEFAULT_OAT_RADIUS = 0.08 / WORLD_LINEAR_SCALE = 0.02.)
//
// Candidates are tried strongest-first until one is accepted, so a world-space
// rejection costs a retry rather than a missing callout.
//
// The initial oat is {initial: true, suppressObservation: true} and is skipped by
// collectObservationTriggerCheckIndices, so it can never produce a callout.
// Every box in the footage comes from these.

const WINDOW_TEXELS = 320;      // field window sampled around the colony
const STRIDE = 3;               // texel stride when scanning candidates
const MIN_UV_GAP = 0.062;       // > the 0.05 floor, with margin
const CANDIDATES = 24;          // strongest-first retries per placement

export default function story(api, { W = 1280, H = 720 } = {}) {
  const c = api();
  const start = c.getCameraPose();
  const target = { x: start.target.x, y: start.target.y, z: start.target.z };
  const r0 = start.distance;
  const elev = (start.elevationDeg * Math.PI) / 180;
  const az0 = (start.azimuthDeg * Math.PI) / 180;

  let base = null;
  const anchor = (a) => {
    if (!base) {
      const o = a.oats?.find((x) => x.initial) ?? a.oats?.[0];
      base = o?.uv ? { x: o.uv.x, y: o.uv.y } : { x: 0.6376, y: 0.5571 };
    }
    return base;
  };

  let buf = null;
  function candidatesOnSlime(a) {
    const size = a.fieldRT.read.width;
    const win = Math.min(WINDOW_TEXELS, size);
    const b = anchor(a);
    const x0 = Math.max(0, Math.min(size - win, Math.round(b.x * size) - win / 2));
    const y0 = Math.max(0, Math.min(size - win, Math.round(b.y * size) - win / 2));
    if (!buf || buf.length !== win * win * 4) buf = new Float32Array(win * win * 4);
    try {
      a.renderer.readRenderTargetPixels(a.fieldRT.read, x0, y0, win, win, buf);
    } catch { return []; }

    const out = [];
    for (let j = 0; j < win; j += STRIDE) {
      for (let i = 0; i < win; i += STRIDE) {
        const val = buf[(j * win + i) * 4];
        if (!(val > 0)) continue;
        const u = (x0 + i) / size;
        const v = (y0 + j) / size;
        let ok = true;
        for (const o of a.oats) {
          if (!o.uv) continue;
          const du = u - o.uv.x;
          const dv = v - o.uv.y;
          if (du * du + dv * dv < MIN_UV_GAP * MIN_UV_GAP) { ok = false; break; }
        }
        if (ok) out.push({ u, v, val });
      }
    }
    out.sort((p, q) => q.val - p.val);
    return out.slice(0, CANDIDATES);
  }

  // The intro runs ~10s and the initial seeding ~3.46s, so the colony does not
  // exist before ~tick 850. Placements are spread out so the callouts arrive one
  // at a time and each has room to reveal and be read before the next.
  const PLACE_AT = [1100, 1400, 1700, 2000, 2300, 2600];
  const placed = [];

  return function tick(t, a) {
    // Slow drift, not the full orbit of wide.js: callouts are DOM elements
    // projected to screen space, and a fast orbit whips them across frame faster
    // than their own reveal animation. This is a legibility test.
    const p = Math.min(1, t / 3600);
    const az = az0 + Math.PI * 0.5 * p;
    const radius = r0 * (1 + 0.16 * Math.sin(p * Math.PI));
    const horiz = radius * Math.cos(elev);
    a.setCameraPose({
      position: {
        x: target.x + horiz * Math.sin(az),
        y: target.y + radius * Math.sin(elev),
        z: target.z + horiz * Math.cos(az),
      },
      target,
      fovDeg: start.fovDeg,
    });

    if (!PLACE_AT.includes(t)) return;
    for (const cand of candidatesOnSlime(a)) {
      const before = a.oats.length;
      a.addOat(cand.u, cand.v);
      if (a.oats.length > before) {
        placed.push({ t, u: +cand.u.toFixed(4), v: +cand.v.toFixed(4), field: +cand.val.toFixed(4) });
        return;
      }
    }
    placed.push({ t, failed: true });
  };
}
