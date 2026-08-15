// A player that actually exercises the spatial audio path.
//
// The default `player.js` sweeps ~58 degrees at a fixed distance, which sits
// right at slimeTumbleLoopState.referenceDistance — so the camera-space azimuth
// of the slime anchor barely changes and the distance falloff never bites.
// Measured on that session: pan range [-0.036, +0.063], lowpass 17775-18000 Hz.
// Nothing to hear, whether or not the automation works.
//
// This one does a full orbit and dollies from close to far and back, so the
// bed should swing right across the stereo field and audibly muffle at range.

const TAU = Math.PI * 2;

export default function wide(api, { W = 1280, H = 720 } = {}) {
  const c = api();
  const start = c.getCameraPose();
  const target = { x: start.target.x, y: start.target.y, z: start.target.z };
  const r0 = start.distance;
  const elev = (start.elevationDeg * Math.PI) / 180;
  const az0 = (start.azimuthDeg * Math.PI) / 180;

  const base = c.oats?.[0]?.uv ? { x: c.oats[0].uv.x, y: c.oats[0].uv.y } : { x: 0.912, y: 0.503 };
  const drops = [
    { at: 80, du: -0.05, dv: 0.04 },
    { at: 240, du: 0.045, dv: -0.05 },
    { at: 420, du: -0.08, dv: -0.025 },
    { at: 640, du: 0.06, dv: 0.055 },
  ];

  const TOTAL = 900;

  return function tick(t, a) {
    const p = Math.min(1, t / TOTAL);

    // full orbit, so the anchor passes through hard left and hard right
    const az = az0 + TAU * p;

    // dolly out to 2.4x reference and back in. maxDistance is 22.4 and the
    // falloff is inverse with rolloff 4.8, so this range is where lowpass and
    // reverb-wet actually move.
    const radius = r0 * (1 + 1.4 * Math.sin(p * Math.PI));

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

    for (const d of drops) {
      if (t === d.at) {
        a.addOat(
          Math.min(0.999, Math.max(0.001, base.x + d.du)),
          Math.min(0.999, Math.max(0.001, base.y + d.dv)),
        );
      }
    }
  };
}
