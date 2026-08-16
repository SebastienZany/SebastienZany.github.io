// A player whose job is to make the STORY CALLOUTS appear.
//
// A text box is not scripted — it is earned. updateObservationSlimeTriggers
// scores each oat from renderSampleViewRT and fires triggerOatObservation only
// once that score clears params.observationSlimeTriggerThreshold (0.05). So a
// callout appears only when the colony has actually grown over that oat.
//
// Getting this reliable took three corrections, each measured:
//
//  1. A geometric ring does not work. The colony does not spread symmetrically
//     across the mesh, so most ring positions never get slime at all: on a ring
//     of 7, two triggered and five sat at exactly 0.0 for the whole session.
//     Place food where the slime already is instead — which is what a player
//     does anyway.
//
//  2. fieldRT is the wrong thing to rank by. The trigger scores from
//     renderSampleViewRT, the SMOOTHED DISPLAY field (main.js:7366), which
//     carries a temporal blend and its own scaling. Ranking raw-field brightness
//     gave 4/6, then 3/6, then 2/6 callouts from identical inputs.
//
//  3. renderSampleViewRT is HalfFloatType (main.js:1729), so
//     readRenderTargetPixels into a Float32Array THROWS — the same defect that
//     makes slimeCoveragePercent permanently 0. Read Uint16Array and decode.
//     Swallowing that error silently placed zero oats.
//
// Placement must also survive isOatTooClose, which requires BOTH
//     uv distance    >= max(OAT_MIN_PLACEMENT_UV_DISTANCE, r + r) = 0.05
//     world distance >= OAT_MIN_PLACEMENT_WORLD_DISTANCE = 0.48
// (DEFAULT_OAT_RADIUS = 0.08 / WORLD_LINEAR_SCALE = 0.02), so candidates are
// tried strongest-first and a rejection costs a retry, not a missing callout.
//
// The initial oat is {initial: true, suppressObservation: true} and can never
// produce a callout. Every box in the footage comes from these.

// Wide enough to see past the colony core. At 320 (0.21 uv of a 1536 field)
// the searchable area was exhausted after three oats and every later placement
// found nothing.
const WINDOW_TEXELS = 640;
const STRIDE = 3;            // texel stride when scanning candidates
// Just above the 0.05 floor rather than comfortably above it: the colony is
// compact, and a generous gap spends the available surface on three oats.
// Candidates are tried strongest-first, so a world-distance rejection at this
// spacing costs a retry rather than a lost callout.
const MIN_UV_GAP = 0.053;
// Deliberately just "any real slime", NOT the trigger threshold.
//
// Requiring a candidate to already clear 0.05 finds nothing: the display field
// peaks at 0.09-0.11 but only within ~0.06 uv of the initial oat, which is
// exactly where MIN_UV_GAP forbids placing. Every above-threshold texel is
// unreachable, so a 0.055 cut placed zero oats across seven attempts while
// reporting windowMax 0.09-0.11.
//
// Placing on the frontier instead works with the mechanism rather than against
// it: the oat draws agents to itself, the slime thickens over it, and the score
// crosses 0.05 shortly after. That is also what a player does.
const MIN_SCORE = 0.004;
const CANDIDATES = 32;       // strongest-first retries per placement

// Keep the food on the UPPER CENTRAL BODY — the mantle — rather than out on the
// arms. Two reasons, both about legibility: a tentacle crossing in front hides
// the oat's own glow marker, and the callout is anchored to the oat's projected
// position, so an oat on a low or outlying arm drags its text box down into the
// busiest part of the silhouette.
//
// Expressed in world space against the mesh bounds, so it survives camera
// motion: HEIGHT_MIN is a fraction of the mesh's vertical extent measured from
// the bottom, RADIUS_MAX a fraction of its horizontal half-extent from the
// centre axis. Both relax if nothing qualifies, so a placement is never lost
// outright — it just prefers the mantle.
const HEIGHT_MIN = 0.58;
const RADIUS_MAX = 0.42;
const RELAX_STEPS = [0, 0.12, 0.26, 0.45];

/** IEEE 754 half -> Number. renderSampleViewRT is RGBA16F. */
function halfToFloat(h) {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  if (exp === 0) return sign * 6.103515625e-5 * (frac / 1024);
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

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

  let halfBuf = null;
  let floatBuf = null;
  let bounds = null;
  const diag = [];

  function candidatesOnSlime(a) {
    const rt = a.renderSampleViewRT?.read ?? a.renderSampleViewRT ?? a.fieldRT.read;
    const size = rt.width;
    const win = Math.min(WINDOW_TEXELS, size);
    const b = anchor(a);
    const x0 = Math.max(0, Math.min(size - win, Math.round(b.x * size) - win / 2));
    const y0 = Math.max(0, Math.min(size - win, Math.round(b.y * size) - win / 2));

    let read = null;
    if (!halfBuf || halfBuf.length !== win * win * 4) halfBuf = new Uint16Array(win * win * 4);
    try {
      a.renderer.readRenderTargetPixels(rt, x0, y0, win, win, halfBuf);
      read = (k) => halfToFloat(halfBuf[k]);
    } catch {
      // Not half-float after all (or the driver refused): fall back to float.
      if (!floatBuf || floatBuf.length !== win * win * 4) floatBuf = new Float32Array(win * win * 4);
      try {
        a.renderer.readRenderTargetPixels(rt, x0, y0, win, win, floatBuf);
        read = (k) => floatBuf[k];
      } catch (e2) {
        diag.push({ err: String(e2).slice(0, 140) });
        return [];
      }
    }

    // Mesh bounds, for the mantle test below. Computed once — the mesh does not
    // move, only the camera does.
    if (!bounds && a.mesh && a.THREE) {
      const box = new a.THREE.Box3().setFromObject(a.mesh);
      const centre = box.getCenter(new a.THREE.Vector3());
      const sizeV = box.getSize(new a.THREE.Vector3());
      bounds = {
        minY: box.min.y,
        spanY: Math.max(1e-6, sizeV.y),
        cx: centre.x,
        cz: centre.z,
        halfSpan: Math.max(1e-6, Math.max(sizeV.x, sizeV.z) * 0.5),
      };
    }

    const raw = [];
    let windowMax = 0;
    for (let j = 0; j < win; j += STRIDE) {
      for (let i = 0; i < win; i += STRIDE) {
        const val = read((j * win + i) * 4);
        if (val > windowMax) windowMax = val;
        if (!(val >= MIN_SCORE)) continue;
        const u = (x0 + i) / size;
        const v = (y0 + j) / size;
        let ok = true;
        for (const o of a.oats) {
          if (!o.uv) continue;
          const du = u - o.uv.x;
          const dv = v - o.uv.y;
          if (du * du + dv * dv < MIN_UV_GAP * MIN_UV_GAP) { ok = false; break; }
        }
        if (!ok) continue;

        // Where on the animal is this? height 0 = bottom of the mesh, 1 = top;
        // radius 0 = on the centre axis, 1 = out at the widest arm.
        let height = null;
        let radius = null;
        if (bounds && a.uvToWorld) {
          try {
            const w = a.uvToWorld({ x: u, y: v });
            height = (w.y - bounds.minY) / bounds.spanY;
            radius = Math.hypot(w.x - bounds.cx, w.z - bounds.cz) / bounds.halfSpan;
          } catch { height = null; radius = null; }
        }
        raw.push({ u, v, val, height, radius });
      }
    }

    // Prefer the mantle, relaxing only as far as needed to find anything.
    let out = [];
    let usedRelax = null;
    for (const relax of RELAX_STEPS) {
      out = raw.filter((cand) => cand.height == null || cand.radius == null
        || (cand.height >= HEIGHT_MIN - relax && cand.radius <= RADIUS_MAX + relax));
      if (out.length) { usedRelax = relax; break; }
    }
    if (!out.length) { out = raw; usedRelax = 'none'; }

    // Among qualifying spots, highest on the body wins — that is the clearest
    // sky for the text box — with slime strength as the tie-break.
    out.sort((p, q) => ((q.height ?? 0) - (p.height ?? 0)) || (q.val - p.val));
    diag.push({
      raw: raw.length, kept: out.length, relax: usedRelax,
      best: out[0] ? { val: +out[0].val.toFixed(4), h: out[0].height == null ? null : +out[0].height.toFixed(2), r: out[0].radius == null ? null : +out[0].radius.toFixed(2) } : null,
      windowMax: +windowMax.toFixed(4),
    });
    return out.slice(0, CANDIDATES);
  }

  // The intro runs ~10s and the initial seeding ~3.46s, so the colony does not
  // exist before ~tick 850. Spread the placements so callouts arrive one at a
  // time, each with room to reveal and be read before the next, and so the last
  // still has ~17s of session left to be observed in.
  const PLACE_AT = [1200, 1450, 1700, 1950, 2200, 2450, 2700];
  const placed = [];

  const fn = function tick(t, a) {
    // Slow drift, not a full orbit: callouts are DOM elements projected to
    // screen space, and a fast orbit whips them across frame faster than their
    // own reveal animation. This is a legibility test.
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
        placed.push({ t, u: +cand.u.toFixed(4), v: +cand.v.toFixed(4), score: +cand.val.toFixed(4) });
        return;
      }
    }
    placed.push({ t, failed: true });
  };
  fn.placed = placed;
  fn.diag = diag;
  window.__storyPlayer = fn;
  return fn;
}
