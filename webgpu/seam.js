// WGSL port of main.js's `safeSamplingGlsl` seam sampler (resolveSampleUvSafe +
// helpers). This is the correctness-critical translation for step 2 of the
// WebGPU migration: it lets the compute sim sample the food field across the UV
// atlas's chart seams exactly like the WebGL surface/diffuse shaders do.
//
// Seam atlas textures are bound in group(1); the sim's own resources stay in
// group(0). useSeamStitching / useZeroGutterTransitions are read from Params
// (P.v7.y / P.v7.z) and fieldSize from P.v0.x, so this string only needs to be
// concatenated after the sim's Params/struct declarations.
//
// GLSL→WGSL notes: the WebGL Nearest `texture(t,uv)` reads become `textureLoad`
// at the UV's texel (the atlases are r/rgba32float = unfilterable, so sampling
// with textureSampleLevel is illegal; textureLoad needs no sampler and matches
// Nearest exactly); `a?b:c` → `select(c,b,a)`; `inout` → return-an-updated-struct.

export const SEAM_TRANSITION_CANDIDATE_COUNT = 4;
export const ZERO_GUTTER_TRANSITION_OUTWARD_DOT_MIN = 0.15;
export const ZERO_GUTTER_TRANSITION_CROSSING_TOLERANCE_TEXELS = 0.75;
export const SEAM_REDIRECT_CLAIM_COLLISION_THRESHOLD = 1.5;

// Bind-group-1 layout the host must satisfy when seam mode is on (order = binding
// index 0..8). All are texture_2d<f32>; no sampler (reads use textureLoad).
// (transitionClaim is intentionally absent — resolveSampleUvSafe never reads it,
// so binding it would fail layout:'auto', which prunes unreferenced bindings.)
export const SEAM_TEXTURE_KEYS = [
  'chartId', 'chartUnsafe',
  'redirectUv', 'redirectMeta', 'redirectClaim',
  'transitionUv', 'transitionMeta', 'transitionDirection', 'transitionBasis',
];

// WGSL string. Depends on: `P` (Params) at @group(0) @binding(0) with P.v0.x =
// fieldSize, P.v7.y = useSeamStitching, P.v7.z = useZeroGutterTransitions.
export const SEAM_WGSL = /* wgsl */`
@group(1) @binding(0)  var t_chartId: texture_2d<f32>;
@group(1) @binding(1)  var t_chartUnsafe: texture_2d<f32>;
@group(1) @binding(2)  var t_redirectUv: texture_2d<f32>;
@group(1) @binding(3)  var t_redirectMeta: texture_2d<f32>;
@group(1) @binding(4)  var t_redirectClaim: texture_2d<f32>;
@group(1) @binding(5)  var t_transUv: texture_2d<f32>;
@group(1) @binding(6)  var t_transMeta: texture_2d<f32>;
@group(1) @binding(7)  var t_transDir: texture_2d<f32>;
@group(1) @binding(8)  var t_transBasis: texture_2d<f32>;

const SEAM_TRANS_CANDIDATES: i32 = ${SEAM_TRANSITION_CANDIDATE_COUNT};
const ZG_OUTWARD_DOT_MIN: f32 = ${ZERO_GUTTER_TRANSITION_OUTWARD_DOT_MIN};
const ZG_CROSS_TOL_TEXELS: f32 = ${ZERO_GUTTER_TRANSITION_CROSSING_TOLERANCE_TEXELS};
const SEAM_CLAIM_COLLISION: f32 = ${SEAM_REDIRECT_CLAIM_COLLISION_THRESHOLD};

// rot is a (sin,cos) heading rotation to apply when a sample/move crosses a seam
// (identity (0,1) within a chart). Sensing ignores it; movement applies it.
struct SeamSample { uv: vec2<f32>, valid: f32, rot: vec2<f32> };
struct TransWinner { uv: vec2<f32>, rot: vec2<f32>, count: f32, dist: f32 };

fn seamStitchOn() -> bool { return P.v7.y > 0.5; }
fn zeroGutterOn() -> bool { return P.v7.z > 0.5; }
fn rotateHeading(angle: f32, rot: vec2<f32>) -> f32 {
  let sinT = rot.x; let cosT = rot.y;
  return atan2(sin(angle) * cosT + cos(angle) * sinT, cos(angle) * cosT - sin(angle) * sinT);
}

fn transCandidateAtlasUv(uv: vec2<f32>, slot: i32) -> vec2<f32> {
  return vec2<f32>((uv.x + f32(slot)) / f32(SEAM_TRANS_CANDIDATES), uv.y);
}
fn isOutsideAtlas(uv: vec2<f32>) -> bool {
  return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
}
// Nearest read at a UV, using the texture's own dimensions (handles the 4x-wide
// transition atlases as well as the square chart/redirect atlases).
fn seamTex(t: texture_2d<f32>, uv: vec2<f32>) -> vec4<f32> {
  let dim = vec2<f32>(textureDimensions(t));
  let c = vec2<i32>(clamp(uv, vec2<f32>(0.0), vec2<f32>(0.999999)) * dim);
  return textureLoad(t, c, 0);
}
fn chartIdAt(uv: vec2<f32>) -> f32 {
  if (isOutsideAtlas(uv)) { return -1.0; }
  return floor(seamTex(t_chartId, uv).r + 0.5);
}
fn isOwnershipUnsafe(uv: vec2<f32>) -> bool {
  return isOutsideAtlas(uv) || seamTex(t_chartUnsafe, uv).r >= 0.5;
}
fn isAuthoritativeChartTexel(uv: vec2<f32>) -> bool {
  return chartIdAt(uv) > 0.5 && !isOwnershipUnsafe(uv);
}
fn hasRedirectClaimCollision(uv: vec2<f32>) -> bool {
  return !isOutsideAtlas(uv) && seamTex(t_redirectClaim, uv).r >= SEAM_CLAIM_COLLISION;
}

// Returns the (possibly updated) transition winner. Nearest seam wins.
fn tryZeroGutterCandidate(
  baseUv: vec2<f32>, sampleOffset: vec2<f32>, baseChart: f32,
  transitionUv: vec4<f32>, transitionMeta: vec4<f32>,
  transitionDirection: vec4<f32>, transitionBasis: vec4<f32>,
  w0: TransWinner,
) -> TransWinner {
  var w = w0;
  if (transitionUv.z < 0.5 || isOutsideAtlas(transitionUv.xy)) { return w; }
  let sourceChart = floor(transitionMeta.r + 0.5);
  let destinationChart = floor(transitionMeta.g + 0.5);
  if (abs(sourceChart - baseChart) > 0.5 ||
      destinationChart < 0.5 ||
      dot(transitionDirection.xy, transitionDirection.xy) < 0.25 ||
      dot(transitionDirection.zw, transitionDirection.zw) < 0.25 ||
      dot(transitionBasis.xy, transitionBasis.xy) < 0.25 ||
      dot(transitionBasis.zw, transitionBasis.zw) < 0.25) {
    return w;
  }
  let sourceOut = normalize(transitionDirection.xy);
  let destinationIn = normalize(transitionDirection.zw);
  let sourceEdge = normalize(transitionBasis.xy);
  let destinationEdge = normalize(transitionBasis.zw);

  let offsetLen = length(sampleOffset);
  if (offsetLen <= 1e-8) { return w; }
  let outwardUv = dot(sampleOffset, sourceOut);
  let outwardTexels = outwardUv * P.v0.x;
  let seamDistanceTexels = transitionUv.w;
  let outwardAlignment = outwardUv / offsetLen;
  if (outwardAlignment < ZG_OUTWARD_DOT_MIN || outwardTexels + ZG_CROSS_TOL_TEXELS < seamDistanceTexels) {
    return w;
  }

  let alongUv = dot(sampleOffset, sourceEdge);
  let destinationDepthUv = max(0.0, outwardTexels - seamDistanceTexels) / P.v0.x;
  let destUv = transitionUv.xy + destinationEdge * alongUv + destinationIn * destinationDepthUv;
  if (isOutsideAtlas(destUv) || isOwnershipUnsafe(destUv) || abs(chartIdAt(destUv) - destinationChart) > 0.5) {
    return w;
  }
  // Nearest seam wins: the offset crosses the closest boundary first.
  if (w.count > 0.5 && seamDistanceTexels >= w.dist) { return w; }
  w.uv = destUv;
  w.rot = transitionMeta.zw;
  w.dist = seamDistanceTexels;
  w.count = 1.0;
  return w;
}

fn resolveZeroGutterTransitionUv(baseUv: vec2<f32>, sampleUv: vec2<f32>, baseChart: f32) -> SeamSample {
  if (!zeroGutterOn() || !seamStitchOn()) { return SeamSample(baseUv, 0.0, vec2<f32>(0.0, 1.0)); }
  let sampleOffset = sampleUv - baseUv;
  var w = TransWinner(baseUv, vec2<f32>(0.0, 1.0), 0.0, 1e9);
  for (var slot = 0; slot < SEAM_TRANS_CANDIDATES; slot = slot + 1) {
    let cUv = transCandidateAtlasUv(baseUv, slot);
    w = tryZeroGutterCandidate(
      baseUv, sampleOffset, baseChart,
      seamTex(t_transUv, cUv), seamTex(t_transMeta, cUv),
      seamTex(t_transDir, cUv), seamTex(t_transBasis, cUv), w);
  }
  if (w.count < 0.5) { return SeamSample(baseUv, 0.0, vec2<f32>(0.0, 1.0)); }
  return SeamSample(w.uv, 1.0, w.rot);
}

// The field sampler used by agents (sensing) and diffuse (neighbor taps): maps a
// desired sampleUv to a safe atlas UV within the same chart (or across a seam via
// the zero-gutter transition / redirect atlases), else returns baseUv with valid=0.
fn resolveSampleUvSafe(baseUv: vec2<f32>, sampleUv: vec2<f32>) -> SeamSample {
  let ident = vec2<f32>(0.0, 1.0);
  if (!isAuthoritativeChartTexel(baseUv)) { return SeamSample(baseUv, 0.0, ident); }
  let baseChart = chartIdAt(baseUv);
  let sampleChart = chartIdAt(sampleUv);
  if (sampleChart == baseChart && !isOwnershipUnsafe(sampleUv)) {
    return SeamSample(sampleUv, 1.0, ident);
  }
  let trans = resolveZeroGutterTransitionUv(baseUv, sampleUv, baseChart);
  if (trans.valid >= 0.5) { return trans; }
  if (isOutsideAtlas(sampleUv)) { return SeamSample(baseUv, 0.0, ident); }
  if (sampleChart == 0.0 && !isOwnershipUnsafe(sampleUv) && !hasRedirectClaimCollision(sampleUv) && seamStitchOn()) {
    let redirectUv = seamTex(t_redirectUv, sampleUv);
    let destUv = redirectUv.xy;
    if (redirectUv.z >= 0.5 && !isOutsideAtlas(destUv) && !isOwnershipUnsafe(destUv)) {
      let redirectMeta = seamTex(t_redirectMeta, sampleUv);
      let sourceChart = floor(redirectMeta.r + 0.5);
      let destinationChart = floor(redirectMeta.g + 0.5);
      if (sourceChart == baseChart && destinationChart > 0.5 && chartIdAt(destUv) == destinationChart) {
        return SeamSample(destUv, 1.0, redirectMeta.zw);
      }
    }
  }
  return SeamSample(baseUv, 0.0, ident);
}
`;
