// Independent verification of the adversarial review's mesh-audit claims.
// Reads luyvwj-fwgyww.glb directly. No repo files touched.
import { readFileSync } from 'node:fs';

const GLB = '/Users/work/Projects/physarum-17/.claude/worktrees/art-game-webgpu-d697c0/luyvwj-fwgyww.glb';

// ---- GLB parse -------------------------------------------------------------
const buf = readFileSync(GLB);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
const jsonLen = dv.getUint32(12, true);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
let off = 20 + jsonLen;
const binLen = dv.getUint32(off, true);
const bin = buf.subarray(off + 8, off + 8 + binLen);

function accessor(idx) {
  const a = json.accessors[idx];
  const bv = json.bufferViews[a.bufferView];
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const compCount = { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type];
  const n = a.count * compCount;
  if (a.componentType === 5126) return new Float32Array(bin.buffer, bin.byteOffset + start, n);
  if (a.componentType === 5125) return new Uint32Array(bin.buffer, bin.byteOffset + start, n);
  if (a.componentType === 5123) return Uint32Array.from(new Uint16Array(bin.buffer, bin.byteOffset + start, n));
  throw new Error('componentType ' + a.componentType);
}
const prim = json.meshes[0].primitives[0];
const pos = accessor(prim.attributes.POSITION);
const uv = accessor(prim.attributes.TEXCOORD_0);
const idx = accessor(prim.indices);
const triCount = idx.length / 3;
const vertCount = pos.length / 3;
console.log(`verts ${vertCount}  tris ${triCount}`);

// ---- edge maps -------------------------------------------------------------
// interior edge: index-pair shared by 2 tris. boundary edge: used once.
const edgeMap = new Map(); // key "a_b" (a<b indices) -> [{tri, i0, i1}...]
for (let t = 0; t < triCount; t++) {
  for (let e = 0; e < 3; e++) {
    const i0 = idx[3 * t + e], i1 = idx[3 * t + ((e + 1) % 3)];
    const key = i0 < i1 ? i0 + '_' + i1 : i1 + '_' + i0;
    let arr = edgeMap.get(key);
    if (!arr) edgeMap.set(key, arr = []);
    arr.push({ t, i0, i1 });
  }
}

// ---- chart segmentation (union-find over index-shared edges) ---------------
const parent = new Int32Array(triCount).map((_, i) => i);
function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[a] = b; }
let boundaryEdges = [];
for (const arr of edgeMap.values()) {
  if (arr.length === 2) union(arr[0].t, arr[1].t);
  else if (arr.length === 1) boundaryEdges.push(arr[0]);
  // non-manifold (>2) edges: treat all as connected pairwise
  else for (let i = 1; i < arr.length; i++) union(arr[0].t, arr[i].t);
}
const chartOf = new Int32Array(triCount);
const chartIds = new Map();
for (let t = 0; t < triCount; t++) {
  const r = find(t);
  if (!chartIds.has(r)) chartIds.set(r, chartIds.size);
  chartOf[t] = chartIds.get(r);
}
const chartCount = chartIds.size;
console.log(`charts ${chartCount}  boundary(unpaired index) edges ${boundaryEdges.length}`);

// ---- seam pairing by quantized 3D endpoints --------------------------------
const Q = 1e-5; // quantize positions (raw GLB units)
const pkey = (i) => `${Math.round(pos[3 * i] / Q)}_${Math.round(pos[3 * i + 1] / Q)}_${Math.round(pos[3 * i + 2] / Q)}`;
const posEdgeMap = new Map(); // "pA|pB" sorted -> [boundary edge records]
for (const e of boundaryEdges) {
  const a = pkey(e.i0), b = pkey(e.i1);
  const key = a < b ? a + '|' + b : b + '|' + a;
  let arr = posEdgeMap.get(key);
  if (!arr) posEdgeMap.set(key, arr = []);
  arr.push(e);
}
let pairs = 0, unmatched = 0, multi = 0, slitPairs = 0;
const foldHist = new Map(); // 10-degree buckets
const foldOver = { 60: 0, 80: 0, 89: 0 };
function normal(t) {
  const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
  const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
  const ux = pos[3 * b] - ax, uy = pos[3 * b + 1] - ay, uz = pos[3 * b + 2] - az;
  const vx = pos[3 * c] - ax, vy = pos[3 * c + 1] - ay, vz = pos[3 * c + 2] - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}
for (const arr of posEdgeMap.values()) {
  if (arr.length === 1) { unmatched++; continue; }
  if (arr.length > 2) { multi++; continue; }
  pairs++;
  const [e0, e1] = arr;
  if (chartOf[e0.t] === chartOf[e1.t]) slitPairs++;
  const n0 = normal(e0.t), n1 = normal(e1.t);
  let dot = n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2];
  dot = Math.max(-1, Math.min(1, Math.abs(dot))); // fold angle from |dot| (orientation-agnostic)
  const ang = Math.acos(dot) * 180 / Math.PI; // 0 = coplanar
  const bucket = Math.min(90, Math.floor(ang / 10) * 10);
  foldHist.set(bucket, (foldHist.get(bucket) || 0) + 1);
  if (ang > 60) foldOver[60]++;
  if (ang > 80) foldOver[80]++;
  if (ang > 89) foldOver[89]++;
}
console.log(`seam pairs (undirected) ${pairs}  -> directional ${pairs * 2}`);
console.log(`same-chart slit pairs ${slitPairs}`);
console.log(`unmatched boundary edges ${unmatched}  multi-matched(>2) ${multi}`);
console.log('fold histogram (deg bucket: count):',
  [...foldHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}-${k + 10}:${v}`).join(' '));
console.log(`folds >60deg ${foldOver[60]}  >80deg ${foldOver[80]}  >89deg ${foldOver[89]}`);

// ---- corner census ---------------------------------------------------------
const vertCharts = new Map(); // pkey -> Set(chartId)
for (let t = 0; t < triCount; t++) {
  for (let e = 0; e < 3; e++) {
    const k = pkey(idx[3 * t + e]);
    let s = vertCharts.get(k);
    if (!s) vertCharts.set(k, s = new Set());
    s.add(chartOf[t]);
  }
}
const census = new Map();
for (const s of vertCharts.values()) census.set(s.size, (census.get(s.size) || 0) + 1);
console.log('corner census (charts@vertex: count):',
  [...census.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' '));

// ---- packing arithmetic: sum of per-chart dilated masks --------------------
function packingDemand(N, GUTTER) {
  // per-chart texel-center raster over local bbox, chebyshev-dilate by GUTTER, sum areas
  const perChartTexels = new Map();
  // group tris by chart, then rasterize
  const trisByChart = Array.from({ length: chartCount }, () => []);
  for (let t = 0; t < triCount; t++) trisByChart[chartOf[t]].push(t);
  let total = 0, rawTotal = 0, subTexelCharts = 0, maxChartTexels = 0;
  for (let c = 0; c < chartCount; c++) {
    const set = new Set();
    for (const t of trisByChart[c]) {
      const a = idx[3 * t], b = idx[3 * t + 1], d = idx[3 * t + 2];
      const xs = [uv[2 * a] * N, uv[2 * b] * N, uv[2 * d] * N];
      const ys = [uv[2 * a + 1] * N, uv[2 * b + 1] * N, uv[2 * d + 1] * N];
      const minx = Math.max(0, Math.floor(Math.min(...xs))), maxx = Math.min(N - 1, Math.ceil(Math.max(...xs)));
      const miny = Math.max(0, Math.floor(Math.min(...ys))), maxy = Math.min(N - 1, Math.ceil(Math.max(...ys)));
      // point-in-triangle at texel centers (matches the review's method)
      const x0 = xs[0], y0 = ys[0], x1 = xs[1], y1 = ys[1], x2 = xs[2], y2 = ys[2];
      const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
      if (den === 0) continue;
      for (let y = miny; y <= maxy; y++) {
        for (let x = minx; x <= maxx; x++) {
          const px = x + 0.5, py = y + 0.5;
          const l0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / den;
          const l1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / den;
          const l2 = 1 - l0 - l1;
          if (l0 >= 0 && l1 >= 0 && l2 >= 0) set.add(y * N + x);
        }
      }
    }
    rawTotal += set.size;
    if (set.size === 0) subTexelCharts++;
    // dilate by GUTTER (chebyshev)
    const dil = new Set();
    for (const s of set) {
      const x = s % N, y = (s / N) | 0;
      for (let dy = -GUTTER; dy <= GUTTER; dy++) {
        for (let dx = -GUTTER; dx <= GUTTER; dx++) {
          dil.add((y + dy) * N + (x + dx)); // allow off-atlas: demand counts anyway
        }
      }
    }
    // empty charts still need MIN_CHART (4x4) + gutter
    const demand = set.size === 0 ? (4 + 2 * GUTTER) ** 2 : dil.size;
    total += demand;
    maxChartTexels = Math.max(maxChartTexels, demand);
  }
  console.log(`N=${N} G=${GUTTER}: raw occupancy ${rawTotal} (${(100 * rawTotal / (N * N)).toFixed(1)}%), ` +
    `dilated demand ${total} (${(100 * total / (N * N)).toFixed(1)}% of atlas), ` +
    `sub-texel charts ${subTexelCharts}, largest chart demand ${maxChartTexels}`);
}
packingDemand(768, 4);
packingDemand(1024, 4);
packingDemand(1536, 4);
