// Give the canvas a real CSS box BEFORE main.js evaluates.
//
// Why this has to happen pre-boot, not at render time:
//
// main.js sizes the camera from the element, not from the window —
//   camera.aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1)
// (resizeIfNeeded, main.js:20165) — and #sim is styled 100vw x 100vh. In a
// hidden or backgrounded tab that box collapses to 0, so aspect becomes 0, the
// projection matrix is degenerate, and its inverse is singular.
//
// Boot then calls resetSimulation({resetOats: true}) -> addInitialOat(), which
// places the first food by raycasting the camera through
// INITIAL_OAT_VIEWPORT_CENTER_NDC = (0,0). Through a singular inverse that ray
// is garbage, so it misses the mesh and main.js silently falls back to
// updateInitialOatFromCameraRotationCenter — a different placement algorithm
// that puts the food somewhere else entirely, on a different chart, varying from
// boot to boot ([0.912, 0.503] and [0.638, 0.557] were both observed).
//
// Since the initial agents are Gaussian-sampled around oats[0], that decides
// where the whole colony starts life. A headless render was therefore not
// reproducing the piece: it was simulating a different world whose food had been
// moved. The tell in the boot log is
//   "Viewport-center ray missed mesh for initial oat; using camera-target fallback."
//
// Pinning the box up front is enough — resizeIfNeeded reads clientWidth/Height
// and independently arrives at the size we want, so nothing has to be patched.
export function pinViewportBeforeBoot(width = 1280, height = 720) {
  const apply = () => {
    for (const id of ['sim', 'annotationLayer']) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
      el.style.maxWidth = 'none';
      el.style.maxHeight = 'none';
    }
    return !!document.getElementById('sim');
  };

  if (apply()) return Promise.resolve({ width, height, pinned: true });

  // Module scripts are deferred, so the element is normally already parsed. If
  // it is not, wait rather than booting into a degenerate camera.
  return new Promise((resolve) => {
    const onReady = () => resolve({ width, height, pinned: apply() });
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onReady, { once: true });
    } else {
      queueMicrotask(onReady);
    }
  });
}
