// Stand-in for a human player, used to drive a session while the recorder
// captures it. This is NOT part of replay — replay consumes the recording
// alone and never loads this file. It exists so a session can be produced
// unattended; a real player at a keyboard would generate the same intents.

export default function player(api, { W = 1280, H = 720 } = {}) {
  const c = api();
  const start = c.getCameraPose();
  const target = { x: start.target.x, y: start.target.y, z: start.target.z };
  const radius = start.distance;
  const elev = (start.elevationDeg * Math.PI) / 180;
  const az0 = (start.azimuthDeg * Math.PI) / 180;

  const base = c.oats?.[0]?.uv ? { x: c.oats[0].uv.x, y: c.oats[0].uv.y } : { x: 0.912, y: 0.503 };

  // where this "player" chooses to feed, and when
  const drops = [
    { at: 90, du: -0.05, dv: 0.04 },
    { at: 260, du: 0.045, dv: -0.05 },
    { at: 430, du: -0.08, dv: -0.025 },
    { at: 610, du: 0.06, dv: 0.055 },
    { at: 780, du: -0.02, dv: -0.07 },
  ];

  return function tick(t, a) {
    // camera: slow eased sweep, as a person would drag it
    const p = Math.min(1, t / 900);
    const eased = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;
    const az = az0 + Math.PI * 2 * 0.16 * eased;
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

    // hover the cursor over the surface for a stretch, so mouse-repel is
    // exercised and recorded rather than staying inert
    if (t > 300 && t < 520 && a.setMouseRepelState) {
      const k = (t - 300) / 220;
      a.setMouseRepelState({
        active: true,
        uv: { x: base.x - 0.06 + 0.12 * k, y: base.y + 0.03 * Math.sin(k * Math.PI * 2) },
        chartId: a.getMouseRepelState().chartId || 1,
      });
    } else if (t === 520 && a.setMouseRepelState) {
      a.setMouseRepelState({ active: false });
    }

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
