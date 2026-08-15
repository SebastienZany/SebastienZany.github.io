# Rendering

F2 establishes the raw-WebGPU material lane on the synthetic `two-chart-sphere` fixture:

- `display-chain.js` advances an r32float EMA history, the running food maximum, and an r16float
  filterable sample view;
- `renderer.js` draws opaque gold followed by the alpha-revealed slime film into one
  depth24plus pass;
- `camera.js` uses vendored three only for `PerspectiveCamera`, matrices, and `OrbitControls`;
- `light-rig.js` and `surface-params.js` keep anchored material data explicit and testable.

This lane has deliberately no atlas, seam, or simulation input. F4 owns every seam conclusion.
