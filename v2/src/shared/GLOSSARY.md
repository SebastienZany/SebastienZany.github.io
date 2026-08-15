# Project glossary

- **atlas** — the packed 2D UV domain used by the surface field.
- **authoritative** — a texel owned by a chart and written by simulation kernels; gutter values are derived, never authoritative.
- **chart** — a connected UV parameterization of part of the mesh surface.
- **donor stencil** — up to four authoritative texels plus weights gathered to derive one gutter texel.
- **exposure** — food deposited or removed by the final live agent population during one simulation step.
- **field** — a scalar texture over the atlas, such as food, oat influence, or crowd density.
- **gutter** — reserved texels surrounding a chart, filled from walk-derived donor stencils so local sampling remains on the same surface.
- **hop** — one runtime crossing through a directional seam frame; the resolver is intentionally single-hop.
- **slit** — a same-chart seam whose two UV sides enclose unrelated surface content and therefore requires a chart split.
- **surface-space** — distance measured on the mesh, independent of its atlas scale.
- **texel-space** — distance measured in field texture cells.
- **UV-space** — normalized coordinates in the packed atlas.
- **walk** — the bake-time geodesic traversal across mesh triangles used to locate a gutter donor.

Code uses these terms literally. In particular, a random source index is not called a donor unless it is guaranteed authoritative.

