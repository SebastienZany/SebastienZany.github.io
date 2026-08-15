# Rendering

F2 establishes the raw-WebGPU material lane on the synthetic `two-chart-sphere` fixture:

- `display-chain.js` advances an r32float EMA history, the running food maximum, and an r16float
  filterable sample view;
- `renderer.js` draws opaque gold followed by the alpha-revealed slime film into one
  depth24plus pass;
- `camera.js` uses vendored three only for `PerspectiveCamera`, matrices, and `OrbitControls`;
- `light-rig.js` and `surface-params.js` keep anchored material data explicit and testable.

F3 extends the same pass without forking it:

- `mesh-geometry.js` uploads MESH1 positions, normals, original uv0, and uint32 indices directly
  from the audited section table;
- `surface-field.js` rasterizes a continuous function of reconstructed world position into uv0
  texel centers for organic material development on the cuttlefish;
- `look.html?mesh=1` selects this real-mesh mode and states that its original-UV seams are
  expected.

This lane has deliberately no repacked atlas, seam machinery, or simulation input. F4 owns every
seam conclusion.
