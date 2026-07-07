// Physarum simulation core on WebGPU compute — DOM-free, renderer-agnostic.
//
// The WebGL build (main.js) grows/kills agents with a 21-pass Hillis-Steele prefix
// scan over a 768x2304 candidate texture plus a compaction shader that does a
// 21-iteration binary search PER pixel — because fragment shaders can't scatter.
// Here that entire machinery collapses into ONE compute dispatch: every live agent
// advances, then appends itself (and any children) to a dense output buffer via
// atomicAdd(&liveCount). Dead agents append nothing. O(n), one pass, no scan, no
// compaction, no binary search.
//
// This module owns ONLY the simulation (agents + food/density field). It produces a
// field texture that a renderer samples — either the standalone 2D renderer
// (webgpu/render2d.js) or, once bridged, main.js's WebGL surface shader via
// readFieldInto(). No canvas, no DOM, no <script> globals beyond the WebGPU API.

import { SEAM_WGSL, SEAM_TEXTURE_KEYS } from './seam.js?v=11';

export const WORLD_LINEAR_SCALE = 4.0;      // matches main.js

// Defaults mirror BASE_SIMULATION_PARAMS in main.js where meaningful.
export const DEFAULT_PARAMS = Object.freeze({
  sensorDistance: 0.032 / WORLD_LINEAR_SCALE,
  sensorAngle: 0.72,
  turnAngle: 0.34,
  wander: 0.092,
  stepSize: 0.0016 / WORLD_LINEAR_SCALE,
  minMoveScale: 0.18,
  reproThreshold: 3.0,
  reproAngle: 0.7,
  childStep: 0.0022 / WORLD_LINEAR_SCALE,
  maxReserve: 7.0,
  uptakeRate: 0.035,
  depositRate: 0.005,
  burnRate: 0.008,
  reproCrowdCap: 0.35,          // no reproduction where local crowd exceeds this
  foodWeight: 1.5,
  crowdWeight: 1.0,
  crowdExponent: 1.0,
  densityTarget: 0.02,
  fieldDiffusion: 0.13,
  fieldDecay: 0.991,
  deltaScale: 1.35,
  foodClamp: 0.5,
});

// Persistent food sources ("oats") so the economy doesn't starve to zero.
export const DEFAULT_OATS = Object.freeze([
  [0.5, 0.5, 0.020, 0.05],
  [0.25, 0.30, 0.014, 0.045],
  [0.75, 0.30, 0.014, 0.045],
  [0.28, 0.74, 0.014, 0.045],
  [0.72, 0.74, 0.014, 0.045],
]);

const WG = 64;             // agent workgroup size
const FIELD_WG = 8;        // field workgroup size (per axis)
const DEPOSIT_FP = 4096.0; // fixed-point scale for atomic deposits
const MAX_OATS = 8;

// Shared WGSL: exported so a renderer can reuse the Params layout without duplicating it.
export const WGSL_SHARED = /* wgsl */`
struct Agent { pos: vec2<f32>, heading: f32, reserve: f32 };
struct Params {
  v0: vec4<f32>,   // fieldSize, dt, frameSeed, capacity
  v1: vec4<f32>,   // sensorDistance, sensorAngle, turnAngle, wander
  v2: vec4<f32>,   // stepSize, minMoveScale, reproThreshold, reproAngle
  v3: vec4<f32>,   // childStep, maxReserve, uptakeRate, depositRate
  v4: vec4<f32>,   // burnRate, foodWeight, crowdWeight, densityTarget
  v5: vec4<f32>,   // fieldDiffusion, fieldDecay, foodClamp, depositScale
  v6: vec4<f32>,   // oatCount, crowdExponent, deltaScale, densityMass
  v7: vec4<f32>,   // reproCrowdCap, _, _, _
  oats: array<vec4<f32>, ${MAX_OATS}>,  // x, y, strength, radiusUV
};
struct Count { n: u32 };
fn hash(n: f32) -> f32 { return fract(sin(n) * 43758.5453123); }
`;

// Seam mode (opt-in) prepends the ported seam sampler and routes agent SENSING
// through resolveSampleUvSafe; group(1) carries the seam atlas textures. Flat
// mode is unchanged. WGSL allows forward references at module scope, so SEAM_WGSL
// (which reads P) can precede the P declaration.
const buildMoveWGSL = (seam) => WGSL_SHARED + (seam ? SEAM_WGSL : '') + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> agentsIn: array<Agent>;
@group(0) @binding(2) var<storage, read_write> agentsOut: array<Agent>;
@group(0) @binding(3) var<storage, read> countIn: Count;
@group(0) @binding(4) var<storage, read_write> countOut: atomic<u32>;
@group(0) @binding(5) var fieldRead: texture_2d<f32>;
@group(0) @binding(6) var densityRead: texture_2d<f32>;
@group(0) @binding(7) var<storage, read_write> depositBuf: array<atomic<i32>>;
@group(0) @binding(8) var<storage, read_write> densityBuf: array<atomic<i32>>;

fn fieldSize() -> f32 { return P.v0.x; }
fn texelOf(uv: vec2<f32>) -> vec2<i32> {
  return vec2<i32>(clamp(uv, vec2<f32>(0.0), vec2<f32>(0.99999)) * fieldSize());
}
fn sampleField(uv: vec2<f32>) -> f32 {
  return max(textureLoad(fieldRead, texelOf(uv), 0).r, 0.0);
}
fn sampleDensity(uv: vec2<f32>) -> f32 {
  return max(textureLoad(densityRead, texelOf(uv), 0).r, 0.0);
}
${seam ? `
// Seam-aware: resolve the desired sample UV to a safe in-chart (or across-seam)
// atlas UV; invalid samples score as unreachable.
fn resolvedField(baseUv: vec2<f32>, sampleUv: vec2<f32>) -> vec2<f32> {
  let s = resolveSampleUvSafe(baseUv, sampleUv);
  if (s.valid < 0.5) { return vec2<f32>(0.0, 0.0); }
  return vec2<f32>(sampleField(s.uv), 1.0);
}
fn resolvedDensity(baseUv: vec2<f32>, sampleUv: vec2<f32>) -> f32 {
  let s = resolveSampleUvSafe(baseUv, sampleUv);
  if (s.valid < 0.5) { return 0.0; }
  return sampleDensity(s.uv);
}` : `
// Flat: read directly; out-of-domain samples score as unreachable.
fn resolvedField(baseUv: vec2<f32>, sampleUv: vec2<f32>) -> vec2<f32> {
  if (any(sampleUv < vec2<f32>(0.0)) || any(sampleUv > vec2<f32>(1.0))) { return vec2<f32>(0.0, 0.0); }
  return vec2<f32>(sampleField(sampleUv), 1.0);
}
fn resolvedDensity(baseUv: vec2<f32>, sampleUv: vec2<f32>) -> f32 {
  return sampleDensity(sampleUv);
}`}
fn scoreAt(baseUv: vec2<f32>, sampleUv: vec2<f32>, reserve: f32) -> f32 {
  let ff = resolvedField(baseUv, sampleUv);
  if (ff.y < 0.5) { return -1e5; }
  let food = ff.x;
  let crowd = resolvedDensity(baseUv, sampleUv);
  let foodSignal = 1.0 - exp(-food * 1.2);
  let reproThreshold = P.v2.z;
  let appetite = 1.0 - smoothstep(reproThreshold * 0.55, reproThreshold * 1.05, reserve);
  let tgt = max(P.v4.w, 0.001);
  let densityRatio = max(crowd / tgt, 0.0);
  let occupiedEnough = smoothstep(0.0, 1.0, densityRatio);
  let crowdRangeMax = max(1.0001, min(3.0, 1.0 / tgt));
  let tooCrowded = smoothstep(1.0, crowdRangeMax, densityRatio);
  let crowdCurve = max(P.v6.y, 1.0);
  let superlinear = tooCrowded * pow(max(densityRatio, 1.0), crowdCurve - 1.0);
  let crowdPref = occupiedEnough - superlinear * 2.0;
  return P.v4.y * foodSignal * appetite + P.v4.z * crowdPref;
}
fn depositAt(uv: vec2<f32>, foodAmt: f32, massAmt: f32) {
  let t = texelOf(uv);
  let s = i32(fieldSize());
  let idx = t.y * s + t.x;
  atomicAdd(&depositBuf[idx], i32(foodAmt * P.v5.w));
  atomicAdd(&densityBuf[idx], i32(massAmt * P.v5.w));
}

@compute @workgroup_size(${WG})
fn moveMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u32(P.v0.w)) { return; }        // beyond capacity
  if (i >= countIn.n) { return; }          // not a live agent this frame
  var a = agentsIn[i];
  if (a.reserve <= 0.0) { return; }

  let dt = P.v0.y;
  let seed = f32(i) * 0.6180339 + P.v0.z;
  let sensorDistance = P.v1.x; let sensorAngle = P.v1.y;
  let turnAngle = P.v1.z; let wander = P.v1.w;
  let stepSize = P.v2.x; let minMoveScale = P.v2.y;
  let reproThreshold = P.v2.z; let reproAngle = P.v2.w;
  let childStep = P.v3.x; let maxReserve = P.v3.y;
  let uptakeRate = P.v3.z; let depositRate = P.v3.w;
  let burnRate = P.v4.x;

  var pos = a.pos;
  var angle = a.heading;

  let frontDir = vec2<f32>(cos(angle), sin(angle));
  let leftDir  = vec2<f32>(cos(angle + sensorAngle), sin(angle + sensorAngle));
  let rightDir = vec2<f32>(cos(angle - sensorAngle), sin(angle - sensorAngle));
  let front = scoreAt(pos, pos + frontDir * sensorDistance, a.reserve);
  let left  = scoreAt(pos, pos + leftDir  * sensorDistance, a.reserve);
  let right = scoreAt(pos, pos + rightDir * sensorDistance, a.reserve);
  let stay  = scoreAt(pos, pos, a.reserve);

  var moveScore = front;
  var angleDelta = (hash(seed + 11.0) - 0.5) * wander;
  if (left > front && left > right) { moveScore = left; angleDelta = turnAngle; }
  else if (right > front && right > left) { moveScore = right; angleDelta = -turnAngle; }

  let preference = moveScore - stay;
  let moveScale = max(minMoveScale, smoothstep(0.0, 0.08, preference));
  angle += angleDelta;
  angle += (hash(seed + 23.0) - 0.5) * wander * 0.5 * moveScale;

  let dir = vec2<f32>(cos(angle), sin(angle));
  let desiredNext = pos + dir * stepSize * dt * moveScale;
${seam ? `
  // Seam-aware move: resolve across chart seams; rotate heading on crossing; on an
  // invalid move (wall / unresolved) stay put and turn.
  let mv = resolveSampleUvSafe(pos, desiredNext);
  var nextPos = select(pos, mv.uv, mv.valid >= 0.5);
  if (mv.valid < 0.5) {
    angle += select(-turnAngle, turnAngle, hash(seed + 59.0) < 0.5);
  } else {
    angle = rotateHeading(angle, mv.rot);
  }` : `
  var nextPos = desiredNext;
  // Flat-domain boundary: reflect off the walls instead of leaking out.
  if (nextPos.x < 0.0 || nextPos.x > 1.0 || nextPos.y < 0.0 || nextPos.y > 1.0) {
    nextPos = clamp(nextPos, vec2<f32>(0.001), vec2<f32>(0.999));
    angle += select(-turnAngle, turnAngle, hash(seed + 59.0) < 0.5);
  }`}

  let food = sampleField(nextPos);
  var reserve = a.reserve + (uptakeRate * food - depositRate - burnRate) * dt;
  if (reserve <= 0.0) { return; }          // starved: drop from the population

  // Trail + crowd mass deposit (this agent's presence).
  depositAt(nextPos, depositRate * P.v6.z, P.v6.w);

  // Reproduction: append up to two children, debit the parent. Gated on local
  // crowd so the population self-limits into networks instead of a filled blob.
  if (reserve > reproThreshold && sampleDensity(nextPos) < P.v7.x) {
    let childReserve = reserve * 0.25;
    var debit = 0.0;
    for (var side = 0; side < 2; side = side + 1) {
      let sideSign = select(-1.0, 1.0, side == 0);
      let cAngle = angle + sideSign * reproAngle + (hash(seed + 37.0 + f32(side)) - 0.5) * 0.18;
      let cPos = nextPos + vec2<f32>(cos(cAngle), sin(cAngle)) * childStep;
      if (cPos.x > 0.0 && cPos.x < 1.0 && cPos.y > 0.0 && cPos.y < 1.0) {
        let cslot = atomicAdd(&countOut, 1u);
        if (cslot < u32(P.v0.w)) {
          agentsOut[cslot] = Agent(cPos, cAngle, childReserve);
          debit += childReserve;
        }
      }
    }
    reserve -= debit;
  }

  let slot = atomicAdd(&countOut, 1u);
  if (slot < u32(P.v0.w)) {
    agentsOut[slot] = Agent(nextPos, angle, min(reserve, maxReserve));
  }
}
`;

// Seam mode routes the 8 diffusion neighbor taps through resolveSampleUvSafe (so
// the field diffuses across chart seams like the WebGL diffuse pass), and zeroes
// non-authoritative texels. Group(1) carries the seam atlases (same as move).
const buildResolveWGSL = (seam) => WGSL_SHARED + (seam ? SEAM_WGSL : '') + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var fieldRead: texture_2d<f32>;
@group(0) @binding(2) var densityRead: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> depositBuf: array<i32>;
@group(0) @binding(4) var<storage, read> densityBuf: array<i32>;
@group(0) @binding(5) var fieldWrite: texture_storage_2d<r32float, write>;
@group(0) @binding(6) var densityWrite: texture_storage_2d<r32float, write>;

fn load(p: vec2<i32>, s: i32) -> f32 {
  let c = clamp(p, vec2<i32>(0), vec2<i32>(s - 1));
  return max(textureLoad(fieldRead, c, 0).r, 0.0);
}
${seam ? `
// Seam-aware neighbor: resolve center→neighbor UV; no-flux fallback to center.
fn diffNeighbor(centerUv: vec2<f32>, p: vec2<i32>, off: vec2<i32>, s: i32, cVal: f32) -> f32 {
  let r = resolveSampleUvSafe(centerUv, centerUv + vec2<f32>(off) / P.v0.x);
  if (r.valid < 0.5) { return cVal; }
  let t = vec2<i32>(clamp(r.uv, vec2<f32>(0.0), vec2<f32>(0.999999)) * P.v0.x);
  return max(textureLoad(fieldRead, t, 0).r, 0.0);
}` : `
fn diffNeighbor(centerUv: vec2<f32>, p: vec2<i32>, off: vec2<i32>, s: i32, cVal: f32) -> f32 {
  return load(p + off, s);
}`}

@compute @workgroup_size(${FIELD_WG}, ${FIELD_WG})
fn resolveMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = i32(P.v0.x);
  if (i32(gid.x) >= s || i32(gid.y) >= s) { return; }
  let p = vec2<i32>(i32(gid.x), i32(gid.y));
  let idx = p.y * s + p.x;
  let centerUv = (vec2<f32>(p) + 0.5) / f32(s);
${seam ? `  if (!isAuthoritativeChartTexel(centerUv)) {
    textureStore(fieldWrite, p, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    textureStore(densityWrite, p, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }` : ``}

  let c = load(p, s);
  // 3x3 box diffusion of the food field (seam-aware neighbors in seam mode).
  var sum = 0.0;
  sum += diffNeighbor(centerUv, p, vec2<i32>(-1, -1), s, c) + diffNeighbor(centerUv, p, vec2<i32>(0, -1), s, c) + diffNeighbor(centerUv, p, vec2<i32>(1, -1), s, c);
  sum += diffNeighbor(centerUv, p, vec2<i32>(-1,  0), s, c)                                                     + diffNeighbor(centerUv, p, vec2<i32>(1,  0), s, c);
  sum += diffNeighbor(centerUv, p, vec2<i32>(-1,  1), s, c) + diffNeighbor(centerUv, p, vec2<i32>(0,  1), s, c) + diffNeighbor(centerUv, p, vec2<i32>(1,  1), s, c);
  let blurred = sum * 0.125;
  var food = mix(c, blurred, P.v5.x);

  // Agent trail deposits (fixed-point -> float).
  food += f32(depositBuf[idx]) / P.v5.w;

  // Persistent oat food sources.
  let uv = (vec2<f32>(p) + 0.5) / f32(s);
  let oatCount = i32(P.v6.x);
  for (var k = 0; k < oatCount; k = k + 1) {
    let o = P.oats[k];
    let d = uv - o.xy;
    let r2 = max(o.w * o.w, 1e-6);
    food += o.z * exp(-dot(d, d) / r2);
  }

  food = clamp(food * P.v5.y, 0.0, P.v5.z);
  textureStore(fieldWrite, p, vec4<f32>(food, 0.0, 0.0, 1.0));

  // Density = this frame's splat with brief persistence (smoother crowd field;
  // also keeps densityRead live so layout:'auto' doesn't prune its binding).
  let splat = f32(densityBuf[idx]) / P.v5.w;
  let prevDens = max(textureLoad(densityRead, p, 0).r, 0.0);
  let dens = max(splat, prevDens * 0.9);
  textureStore(densityWrite, p, vec4<f32>(dens, 0.0, 0.0, 1.0));
}
`;

function align256(n) { return Math.ceil(n / 256) * 256; }

/**
 * Create the physarum simulation.
 * @param {object} opts
 * @param {GPUDevice} [opts.device]  reuse an existing device (else one is requested)
 * @param {number}  [opts.fieldSize=1024]
 * @param {number}  [opts.capacity=500000]  hard population cap
 * @param {number}  [opts.seedCount=60000]
 * @param {Array}   [opts.oats=DEFAULT_OATS]
 * @param {number}  [opts.initialFood=0.06]
 */
export async function createPhysarumSim(opts = {}) {
  const fieldSize = opts.fieldSize ?? 1024;
  const capacity = opts.capacity ?? 500000;
  const seedCount = Math.min(opts.seedCount ?? 60000, capacity);
  const oats = (opts.oats ?? DEFAULT_OATS).slice(0, MAX_OATS);
  const initialFood = opts.initialFood ?? 0.06;
  const seam = !!opts.seam;                       // route agent sensing through the seam sampler
  const providedSeamTextures = opts.seamTextures || null;  // { key: GPUTexture } from the app's baked atlases
  let populationTarget = opts.populationTarget ?? null;    // null = hard-cap only; else self-balance to this

  let device = opts.device;
  if (!device) {
    if (!('gpu' in navigator)) throw new Error('WebGPU unavailable: navigator.gpu is undefined.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('WebGPU unavailable: no GPU adapter.');
    device = await adapter.requestDevice();
  }

  const params = { ...DEFAULT_PARAMS };
  const fieldTexels = fieldSize * fieldSize;

  // ── Buffers ──
  const agentBuf = [0, 1].map(() => device.createBuffer({
    size: capacity * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  }));
  const countBuf = [0, 1].map(() => device.createBuffer({
    size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  }));
  const depositBuf = device.createBuffer({ size: fieldTexels * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const densityDepBuf = device.createBuffer({ size: fieldTexels * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const paramsBuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const countReadback = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

  // Field readback: bytesPerRow must be 256-aligned for copyTextureToBuffer.
  const fieldRowBytes = align256(fieldSize * 4);
  const fieldReadback = device.createBuffer({ size: fieldRowBytes * fieldSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

  const mkFieldTex = () => device.createTexture({
    size: [fieldSize, fieldSize], format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
  });
  const fieldTex = [mkFieldTex(), mkFieldTex()];
  const densTex = [mkFieldTex(), mkFieldTex()];

  // ── Seam atlases (group 1, seam mode only) ──
  // Chart/redirect atlases are fieldSize²; the 4 transition candidate atlases are
  // (SEAM_TRANSITION_CANDIDATE_COUNT × fieldSize) wide. Identity atlases (chartId=1
  // everywhere, no redirects) make resolveSampleUvSafe take the fast path — used to
  // verify the port compiles + runs with no regression vs flat mode. The real bridge
  // supplies the app's baked atlases as { key: GPUTexture }.
  function makeIdentitySeamTexture(key) {
    // Identity atlas data is uniform, so a tiny texture suffices — textureLoad
    // clamps any UV into it. (Full-size identity atlases would waste ~360MB and
    // can OOM.) The real bridge passes the app's full-size baked atlases instead.
    const S = 4;
    const tex = device.createTexture({ size: [S, S], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const data = new Float32Array(S * S * 4);
    if (key === 'chartId') { for (let i = 0; i < S * S; i++) data[i * 4] = 1.0; }  // one authoritative chart
    device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: S * 16, rowsPerImage: S }, [S, S]);
    return tex;
  }
  if (seam) device.pushErrorScope('out-of-memory');
  if (seam) device.pushErrorScope('validation');
  const seamTexMap = seam
    ? Object.fromEntries(SEAM_TEXTURE_KEYS.map((k) => [k, (providedSeamTextures && providedSeamTextures[k]) || makeIdentitySeamTexture(k)]))
    : null;

  // ── Pipelines ──
  const movePipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: buildMoveWGSL(seam) }), entryPoint: 'moveMain' } });
  const resolvePipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: buildResolveWGSL(seam) }), entryPoint: 'resolveMain' } });

  const mkSeamBindGroup = (pipe) => device.createBindGroup({
    layout: pipe.getBindGroupLayout(1),
    entries: SEAM_TEXTURE_KEYS.map((k, i) => ({ binding: i, resource: seamTexMap[k].createView() })),
  });
  const seamBindGroup = seam ? mkSeamBindGroup(movePipe) : null;
  const resolveSeamBindGroup = seam ? mkSeamBindGroup(resolvePipe) : null;

  let seamSetupError = null;
  if (seam) {
    const vErr = await device.popErrorScope();   // validation (pushed last)
    const mErr = await device.popErrorScope();   // out-of-memory
    seamSetupError = (vErr && vErr.message) || (mErr && mErr.message) || null;
    if (seamSetupError) console.error('[sim] seam setup error:', seamSetupError);
  }

  const moveBind = [0, 1].map((p) => {
    const q = p ^ 1;
    return device.createBindGroup({ layout: movePipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: paramsBuf } },
      { binding: 1, resource: { buffer: agentBuf[p] } },
      { binding: 2, resource: { buffer: agentBuf[q] } },
      { binding: 3, resource: { buffer: countBuf[p] } },
      { binding: 4, resource: { buffer: countBuf[q] } },
      { binding: 5, resource: fieldTex[p].createView() },
      { binding: 6, resource: densTex[p].createView() },
      { binding: 7, resource: { buffer: depositBuf } },
      { binding: 8, resource: { buffer: densityDepBuf } },
    ] });
  });
  const resolveBind = [0, 1].map((p) => {
    const q = p ^ 1;
    return device.createBindGroup({ layout: resolvePipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: paramsBuf } },
      { binding: 1, resource: fieldTex[p].createView() },
      { binding: 2, resource: densTex[p].createView() },
      { binding: 3, resource: { buffer: depositBuf } },
      { binding: 4, resource: { buffer: densityDepBuf } },
      { binding: 5, resource: fieldTex[q].createView() },
      { binding: 6, resource: densTex[q].createView() },
    ] });
  });

  // ── Params ──
  const pf = new Float32Array(64);
  function uploadParams(dt, frameSeed) {
    pf.set([fieldSize, dt, frameSeed, capacity], 0);
    pf.set([params.sensorDistance, params.sensorAngle, params.turnAngle, params.wander], 4);
    pf.set([params.stepSize, params.minMoveScale, populationTarget ? ctrlReproThreshold : params.reproThreshold, params.reproAngle], 8);
    pf.set([params.childStep, params.maxReserve, params.uptakeRate, params.depositRate], 12);
    pf.set([params.burnRate, params.foodWeight, params.crowdWeight, params.densityTarget], 16);
    pf.set([params.fieldDiffusion, params.fieldDecay, params.foodClamp, DEPOSIT_FP], 20);
    pf.set([oats.length, params.crowdExponent, params.deltaScale, 0.032], 24);
    pf.set([params.reproCrowdCap, seam ? 1 : 0, seam ? 1 : 0, 0], 28);
    for (let k = 0; k < MAX_OATS; k++) {
      const o = oats[k] || [0, 0, 0, 1];
      pf.set([o[0], o[1], o[2], o[3]], 32 + k * 4);
    }
    device.queue.writeBuffer(paramsBuf, 0, pf);
  }

  // ── State ──
  let parity = 0;            // index of the latest field/agents
  let ctrlReproThreshold = DEFAULT_PARAMS.reproThreshold;   // controller-managed when populationTarget set
  let frameSeed = 1.0;
  let liveEstimate = seedCount;
  let countBusy = false;
  let fieldBusy = false;
  const agentGroups = Math.ceil(capacity / WG);
  const fieldGroups = Math.ceil(fieldSize / FIELD_WG);

  function seedRandom() {
    const arr = new Float32Array(seedCount * 4);
    for (let i = 0; i < seedCount; i++) {
      const o = oats[(Math.random() * oats.length) | 0] || [0.5, 0.5, 0, 0.05];
      const r = Math.random() * 0.08;
      const a = Math.random() * Math.PI * 2;
      arr[i * 4 + 0] = Math.min(0.999, Math.max(0.001, o[0] + Math.cos(a) * r));
      arr[i * 4 + 1] = Math.min(0.999, Math.max(0.001, o[1] + Math.sin(a) * r));
      arr[i * 4 + 2] = Math.random() * Math.PI * 2;
      arr[i * 4 + 3] = params.reproThreshold * 0.6;    // starting reserve
    }
    device.queue.writeBuffer(agentBuf[0], 0, arr);
    device.queue.writeBuffer(countBuf[0], 0, new Uint32Array([seedCount]));
    device.queue.writeBuffer(countBuf[1], 0, new Uint32Array([0]));
    const init = new Float32Array(fieldTexels).fill(initialFood);
    const zero = new Float32Array(fieldTexels);
    for (const t of fieldTex) device.queue.writeTexture({ texture: t }, init, { bytesPerRow: fieldSize * 4, rowsPerImage: fieldSize }, [fieldSize, fieldSize]);
    for (const t of densTex) device.queue.writeTexture({ texture: t }, zero, { bytesPerRow: fieldSize * 4, rowsPerImage: fieldSize }, [fieldSize, fieldSize]);
    parity = 0;
    liveEstimate = seedCount;
  }

  // One simulation step: the whole agent pipeline in a single command buffer.
  function step(dt = 1.0) {
    frameSeed = (frameSeed + 0.61803398875) % 1000.0;
    uploadParams(dt, frameSeed);

    const p = parity, q = parity ^ 1;
    const enc = device.createCommandEncoder();
    enc.clearBuffer(countBuf[q]);          // fresh accumulators for this step
    enc.clearBuffer(depositBuf);
    enc.clearBuffer(densityDepBuf);

    // ONE dispatch = advance + births + deaths + deposits (no scan/compact).
    let pass = enc.beginComputePass();
    pass.setPipeline(movePipe);
    pass.setBindGroup(0, moveBind[p]);
    if (seam) pass.setBindGroup(1, seamBindGroup);
    pass.dispatchWorkgroups(agentGroups);
    pass.end();

    // Field diffuse/decay + oat sources + density resolve.
    pass = enc.beginComputePass();
    pass.setPipeline(resolvePipe);
    pass.setBindGroup(0, resolveBind[p]);
    if (seam) pass.setBindGroup(1, resolveSeamBindGroup);
    pass.dispatchWorkgroups(fieldGroups, fieldGroups);
    pass.end();

    device.queue.submit([enc.finish()]);
    parity = q;                            // latest is now index q
  }

  // Async live-agent count (never blocks a frame; returns the last value if busy).
  async function liveCount() {
    if (countBusy) return liveEstimate;
    countBusy = true;
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(countBuf[parity], 0, countReadback, 0, 4);
    device.queue.submit([enc.finish()]);
    try {
      await countReadback.mapAsync(GPUMapMode.READ);
      liveEstimate = Math.min(capacity, new Uint32Array(countReadback.getMappedRange())[0]);
      countReadback.unmap();
      // Population controller (integral) on reproThreshold: over target → raise it
      // (fewer births; ≥maxReserve=7 means zero births), under target → lower it.
      // Inherently safe — it only limits births, so it can't drive extinction (as
      // population falls, births auto-resume). Self-balances instead of hard-capping.
      if (populationTarget) {
        const err = (liveEstimate - populationTarget) / populationTarget;
        const gain = err > 0 ? 1.0 : 0.25;   // suppress births fast, relax slowly
        // Clamp ≥ default so the controller only ever SUPPRESSES births (never aids
        // growth toward the cap) — this avoids the controller causing the overshoot.
        ctrlReproThreshold = Math.min(7.5, Math.max(DEFAULT_PARAMS.reproThreshold, ctrlReproThreshold + err * gain));
      }
    } catch (e) { /* device lost / race — ignore */ }
    countBusy = false;
    return liveEstimate;
  }

  // Read the latest field into a Float32Array(fieldSize*fieldSize) for the WebGL
  // bridge. Returns null if a readback is already in flight (caller reuses last).
  async function readFieldInto(target) {
    if (fieldBusy) return null;
    fieldBusy = true;
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: fieldTex[parity] },
      { buffer: fieldReadback, bytesPerRow: fieldRowBytes, rowsPerImage: fieldSize },
      [fieldSize, fieldSize],
    );
    device.queue.submit([enc.finish()]);
    try {
      await fieldReadback.mapAsync(GPUMapMode.READ);
      const src = new Float32Array(fieldReadback.getMappedRange());
      const rowFloats = fieldRowBytes / 4;
      if (rowFloats === fieldSize) {
        target.set(src.subarray(0, fieldTexels));
      } else {
        for (let y = 0; y < fieldSize; y++) target.set(src.subarray(y * rowFloats, y * rowFloats + fieldSize), y * fieldSize);
      }
      fieldReadback.unmap();
    } catch (e) { fieldBusy = false; return null; }
    fieldBusy = false;
    return target;
  }

  // Debug: read back the first n agents (x, y, heading, reserve) of the latest buffer.
  async function debugReadAgents(n = 8) {
    const bytes = n * 16;
    const rb = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(agentBuf[parity], 0, rb, 0, bytes);
    device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap(); rb.destroy();
    const out = [];
    for (let i = 0; i < n; i++) out.push({ x: +f[i * 4].toFixed(4), y: +f[i * 4 + 1].toFixed(4), reserve: +f[i * 4 + 3].toFixed(4) });
    return out;
  }

  seedRandom();
  uploadParams(1.0, frameSeed);

  return {
    device,
    fieldSize,
    capacity,
    seam,
    seamSetupError,
    params,                 // mutable; edit then call step()
    oats,
    paramsBuffer: paramsBuf,
    fieldTextures: fieldTex,
    getParity: () => parity,
    currentFieldTexture: () => fieldTex[parity],
    currentFieldView: () => fieldTex[parity].createView(),
    step,
    seedRandom,
    liveCount,
    readFieldInto,
    debugReadAgents,
    getLiveEstimate: () => liveEstimate,
    setPopulationTarget: (t) => { populationTarget = t || null; },
    getCtrlReproThreshold: () => ctrlReproThreshold,
  };
}
