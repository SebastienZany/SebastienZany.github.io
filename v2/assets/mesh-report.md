# MESH1 analysis report

Deterministic output of `npm run bake:mesh`. MESH1 contains the normalized input geometry and
original UVs; it does not contain M2's repacked or slit-split runtime topology.

## Mesh

| Quantity | Value |
|---|---:|
| Vertices | 281,981 |
| Triangles | 501,428 |
| Charts | 1,233 |
| Indexed UV-boundary sides | 60,068 |
| Non-manifold indexed edges | 0 |
| Summed chart UV area | 0.523679082 |
| MESH1 bytes | 18,782,968 |

All POSITION, NORMAL, and TEXCOORD_0 scalars are finite. UVs have zero scalars outside [0, 1].
The source uses indexed triangles with no GLB extensions; its one embedded image and material are
intentionally absent because the game replaces that material (legacy anchor `main.js:15379`).

## Legacy normalization frame

Legacy anchor: `main.js:15294`. Source bbox center is translated to the origin, then uniformly
scaled by 9.599826052957 so its longest extent is 9.6 world units.

| Frame | Min xyz | Max xyz | Extents xyz |
|---|---|---|---|
| Source | -0.500018120, -0.221972018, -0.456337959 | 0.500000000, 0.221976086, 0.456334651 | 1.000018120, 0.443948105, 0.912672609 |
| Normalized | -4.800000191, -2.130912304, -4.380749226 | 4.800000191, 2.130912304, 4.380749226 | 9.600000381, 4.261824608, 8.761498451 |

Source bbox center: -0.000009060, 0.000002034, -0.000001654.

## Chart histograms

Triangle count per chart:

| Band | Charts |
|---|---:|
| ≤ 1 | 12 |
| > 1 to ≤ 4 | 31 |
| > 4 to ≤ 16 | 98 |
| > 16 to ≤ 64 | 313 |
| > 64 to ≤ 256 | 394 |
| > 256 to ≤ 1024 | 265 |
| > 1024 | 120 |

UV area, expressed as equivalent texel area at each target field size (thin charts may still miss
every texel center, so this is deliberately separate from the exact sub-texel census):

### At 1536

| Band | Charts |
|---|---:|
| ≤ 1 | 16 |
| > 1 to ≤ 4 | 28 |
| > 4 to ≤ 16 | 94 |
| > 16 to ≤ 64 | 218 |
| > 64 to ≤ 256 | 318 |
| > 256 to ≤ 1024 | 338 |
| > 1024 | 221 |

### At 1024

| Band | Charts |
|---|---:|
| ≤ 1 | 28 |
| > 1 to ≤ 4 | 58 |
| > 4 to ≤ 16 | 149 |
| > 16 to ≤ 64 | 315 |
| > 64 to ≤ 256 | 343 |
| > 256 to ≤ 1024 | 211 |
| > 1024 | 129 |

Exact texel-center census:

| Field size | Charts containing zero texel centers | Chart ids |
|---:|---:|---|
| 1536 | 12 | 142, 166, 168, 338, 349, 350, 351, 518, 652, 653, 1015, 1016 |
| 1024 | 14 | 142, 166, 168, 248, 257, 338, 351, 653, 710, 715, 790, 816, 1015, 1016 |

## Seams

| Quantity | Value |
|---|---:|
| Undirected seam pairs | 30,034 |
| Directional sides | 60,068 |
| Cross-chart pairs | 26,442 |
| Same-chart slit pairs | 3,592 |
| Chart-local slit components | 630 |
| Largest chart-local component | 87 edges |
| Endpoint-only slit groups (diagnostic) | 570 |
| Fold >60° / >80° / >89° | 3,718 / 1,318 / 147 |
| Median adjacent-triangle altitude at 1536 | 1.4903 texels |
| Directional sides below 4 texels altitude | 59,215 |

Corner census: 3-chart 2,167,
4-chart 164, and
5-chart 12. Angle defects at the multi-chart
corners: +181 positive,
−1,358 negative, and
804 approximately flat (±0.05 rad).

### Slit graph scope blocker

The audited 19 branching components and 5 closed loops occur in the 570 endpoint-only groups,
not in the required 630 chart-local work units. The chart-local graph measures 18 branching
components with 19 branch vertices and zero closed loops. `../BLOCKERS.md` records the exact
contradiction and its M2 impact; both graph scopes are retained below instead of relabeling one.

| Graph | Components | Multi-chart groups | Branching components | Branch vertices | Closed loops |
|---|---:|---:|---:|---:|---:|
| Endpoint-only diagnostic | 570 | 53 | 19 | 21 | 5 |
| Chart-local work units | 630 | 0 | 18 | 19 | 0 |

## Provenance hashes (SHA-256)

| Input/output | Hash |
|---|---|
| luyvwj-fwgyww.glb | `e34b0df84f4dc7face756a9b287cfc6911c8079189f71e0d4d608df3b315c7d4` |
| mesh-1.bin | `dbf3f43570ffb3de9f71cbf3dd28d3f33a62768b431c3127db9cae1c90b8bde3` |
| Combined tool chain | `dae78577d60e7de58aa65b6a2a1ec6d8c8df1311d6bb461dd0297778342b1de4` |

| Tool file | SHA-256 |
|---|---|
| src/atlas/asset.js | `d4325c5ab257053e8967cf73ce6f0fbabac7bd406770c40df3e0311a6287233d` |
| tools/bake-mesh.mjs | `598b45d155c96250429a4d1c68d2223f46ca5b57c2dacc26933428730bad323f` |
| tools/glb.mjs | `48b1503e8738235dce40f02c1991b5505172b6efbc374721fc30054cba5e062e` |
| tools/mesh-components.mjs | `45c70f043fd6f1562bc87e9834645083993a8bd5ca901b973e6358024b88debb` |
| tools/mesh-topology.mjs | `b1b9de9f2d123067ec7685e94f8f214b4e97167b07c36f606156f535408cee70` |
| tools/mesh.mjs | `398e895059b6ff58b87e3f729a549f76784a2277f22d111ea1ab15a54cd2b522` |
| tools/pack.mjs | `7d54e51a26e84acfdb8e5873b7ec6f74a36cb643d1e7ae194d5f3ac7a2a0ed2d` |
| tools/union-find.mjs | `8fb2c5144d3a64036f6fb9a27d7ab5fd66132a765161f571fff23647cff21e4b` |
