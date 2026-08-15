import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { parseMeshAsset } from '../src/atlas/asset.js';
import { buildAtlasBundle, writeAtlasBundle } from './asset-bundle.mjs';
import { ATLAS_SCHEMA_VERSION, DEFAULT_ATLAS_TARGETS, MAX_SECTION_BYTES } from './atlas-constants.mjs';
import { buildTargetSectionInputs } from './atlas-sections.mjs';
import { buildBlockGraph } from './block-graph.mjs';
import { buildBoundaryFrameIndex } from './boundary-index.mjs';
import { measureFloat16WorldError } from './float16.mjs';
import { rasterizeAtlas } from './rasterize.mjs';
import { repackAtlasWithTarget } from './repack.mjs';
import { buildDirectionalFrames, triangleJacobian } from './seams.mjs';
import { splitChartLocalSlits } from './slit-split.mjs';

const v2Root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MESH_PATH = resolve(v2Root, 'assets/mesh-1.bin');
const DEFAULT_REPORT_PATH = resolve(v2Root, 'assets/atlas-report.md');
const DEFAULT_OUTPUT_DIRECTORY = resolve(v2Root, 'assets');
const DEFAULT_SHELL_PATH = resolve(v2Root, 'index.html');
const OAT_SIGMA_UV = (0.08 / 4) * 0.42; // main.js:174 and 2849: radius 0.02 UV, sigma 0.42 radius.
const WORST_ROW_COUNT = 20;

export class AtlasDeploymentBlockedError extends Error {}

export async function bakeAtlas({
  meshPath = DEFAULT_MESH_PATH,
  reportPath = DEFAULT_REPORT_PATH,
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
  shellPath = DEFAULT_SHELL_PATH,
  targets = DEFAULT_ATLAS_TARGETS,
  quiet = false,
} = {}) {
  const sourceMesh = parseMeshAsset(await readFile(meshPath));
  announce(quiet, 'splitting chart-local slits');
  const splitMesh = splitChartLocalSlits(sourceMesh);
  const targetReports = [];
  const sectionInputs = [];
  const reportContext = { sourceMesh, splitMesh, targets: targetReports, failedTarget: null };
  await writeFile(reportPath, buildReport(reportContext));

  for (const target of targets) {
    try {
      announce(quiet, `${target.fieldSize}: conservative masks and packing`);
      const repack = repackAtlasWithTarget(splitMesh, target);
      announce(quiet, `${target.fieldSize}: hinge frames and geodesic donor walks`);
      const frames = buildDirectionalFrames(splitMesh, repack);
      const raster = rasterizeAtlas(splitMesh, repack);
      announce(quiet, `${target.fieldSize}: boundary frame census and block graph`);
      const boundaryIndex = buildBoundaryFrameIndex(
        splitMesh,
        repack,
        frames,
        raster.authoritativeOwner,
      );
      const blockGraph = buildBlockGraph(splitMesh, repack, raster);
      const smallestKernelWorld = smallestOatSigmaWorld(splitMesh, repack);
      const precision = measureFloat16WorldError(raster.worldPos, raster.ownership, smallestKernelWorld);
      const targetResult = { repack, frames, raster, boundaryIndex, blockGraph, precision };
      const overflowFile = await writeOverflowCensus(outputDirectory, target.fieldSize, boundaryIndex);
      targetReports.push(summarizeTarget(splitMesh, targetResult, overflowFile));
      await writeFile(reportPath, buildReport(reportContext));
      if (!raster.gutter.deploymentBlocked) sectionInputs.push(...buildTargetSectionInputs(splitMesh, targetResult));
    } catch (error) {
      reportContext.failedTarget = { fieldSize: target.fieldSize, message: error.message };
      await writeFile(reportPath, buildReport(reportContext));
      throw error;
    }
    globalThis.gc?.();
  }

  const signedDonorCount = targetReports.reduce((sum, target) => sum + target.gutter.signedDegraded, 0);
  if (signedDonorCount) {
    await writeFile(reportPath, buildReport(reportContext));
    throw new AtlasDeploymentBlockedError(
      `atlas deployment blocked: ${formatInteger(signedDonorCount)} signed degraded donors have no mandated encoding; see BLOCKERS.md`,
    );
  }

  const bundle = buildAtlasBundle(sectionInputs, {
    schemaVersion: ATLAS_SCHEMA_VERSION,
    targets: targets.map(({ fieldSize, gutterTexels, densityScale, directTapClampTexels }) => ({
      fieldSize, gutterTexels, densityScale, directTapClampTexels,
    })),
  });
  await writeAtlasBundle(outputDirectory, bundle);
  await bindShell(shellPath, bundle.manifest);
  announce(quiet, `wrote ${relative(v2Root, reportPath)} and ${bundle.manifest.sections.length} bound sections`);
  return { sourceMesh, splitMesh, targetReports, manifest: bundle.manifest };
}

function summarizeTarget(splitMesh, result, overflowFile) {
  const { repack, frames, raster, boundaryIndex, blockGraph, precision } = result;
  const legacyWorldAreaPerTexel = splitMesh.charts.reduce((sum, chart) => sum + chart.worldArea, 0)
    / (0.523679082 * repack.fieldSize ** 2);
  const densityRows = repack.chartTable.map((chart) => ({
    ...chart,
    worldTexelWidthRatio: Math.sqrt(chart.worldAreaPerTexel / legacyWorldAreaPerTexel),
  }));
  const widthRatios = densityRows.map(({ worldTexelWidthRatio }) => worldTexelWidthRatio);
  return {
    fieldSize: repack.fieldSize,
    target: repack.target,
    stats: repack.stats,
    clearance: {
      minimumChebyshevDistance: repack.clearance.minimumChebyshevDistance,
      dilatedIntersectionCount: 0,
    },
    density: {
      minWorldTexelWidthRatio: Math.min(...widthRatios),
      maxWorldTexelWidthRatio: Math.max(...widthRatios),
      minFactor: Math.min(...densityRows.map(({ texelDensityFactor }) => texelDensityFactor)),
      maxFactor: Math.max(...densityRows.map(({ texelDensityFactor }) => texelDensityFactor)),
      worst: densityRows.sort((left, right) => (
        Math.abs(Math.log(right.texelDensityFactor)) - Math.abs(Math.log(left.texelDensityFactor))
      ) || left.chartId - right.chartId).slice(0, WORST_ROW_COUNT),
    },
    gutter: {
      recordCount: raster.gutter.recordCount,
      deadCount: raster.gutter.deadCount,
      exactBilinear: raster.gutter.census.exactBilinear,
      nonnegativeMoment: raster.gutter.census.nonnegativeMoment,
      degraded: raster.gutter.census.degraded,
      signedDegraded: raster.gutter.census.signedDegraded,
      maxPositionErrorTexels: raster.gutter.census.maxPositionErrorTexels,
      maxWalkHops: maxTyped(raster.gutter.walkHopCounts),
      maxChartCrossings: maxTyped(raster.gutter.walkChartCrossings),
    },
    frames: {
      count: frames.frameCount,
      groups: boundaryIndex.frameGroupCount,
      coveredTexels: boundaryIndex.coveredTexelCount,
      overflowCount: boundaryIndex.overflowCount,
      maximumCandidates: maxTyped(boundaryIndex.candidateCounts),
      overflowFile,
    },
    blocks: { nodes: blockGraph.nodeCount, directedEdges: blockGraph.targets.length },
    precision,
    worstSeams: rankWorstSeams(splitMesh, repack, frames.frames),
    worstCorners: rankWorstCorners(splitMesh, repack.uv1),
  };
}

function buildReport({ sourceMesh, splitMesh, targets, failedTarget }) {
  const originalSlits = sourceMesh.seamPairs.filter((pair) => pair.isSlit).length;
  const folds = [60, 80, 89].map((degrees) => sourceMesh.seamPairs.filter(
    ({ foldAngleRadians }) => foldAngleRadians * 180 / Math.PI > degrees,
  ).length);
  const targetSections = targets.length
    ? targets.map(targetReport).join('\n')
    : '_Target measurement has not completed yet._';
  const signedDonors = targets.reduce((sum, target) => sum + target.gutter.signedDegraded, 0);
  const status = failedTarget
    ? `Failed while measuring ${failedTarget.fieldSize}: ${failedTarget.message}`
    : signedDonors
      ? `Deployment blocked: ${formatInteger(signedDonors)} signed degraded donors cannot use the mandated unsigned-u16 encoding.`
      : targets.length === 0
        ? 'Bake in progress.'
        : 'All measured targets are deployable.';
  return `# M2 atlas bake report

Deterministic CPU output of \`npm run bake\`. The report is written incrementally so a failed
asset gate preserves every completed measurement. **Status: ${status}**

## Slit split and audited ground truth

| Quantity | Re-derived value |
|---|---:|
| Input charts | ${formatInteger(sourceMesh.chartCount)} |
| Post-split charts | ${formatInteger(splitMesh.stats.outputChartCount)} |
| Undirected input seam pairs | ${formatInteger(sourceMesh.seamPairCount)} |
| Same-chart slit pairs | ${formatInteger(originalSlits)} |
| Chart-local slit components | ${formatInteger(splitMesh.stats.slitComponentCount)} |
| Simple split paths | ${formatInteger(splitMesh.stats.simplePathCount)} |
| Branch vertices / closed loops | ${formatInteger(splitMesh.stats.branchVertexCount)} / ${formatInteger(splitMesh.stats.closedLoopCount)} |
| Extension edges | ${formatInteger(splitMesh.stats.extensionEdgeCount)} |
| Unresolved slits | ${formatInteger(splitMesh.stats.unresolvedSlitCount)} |
| Fold >60° / >80° / >89° | ${folds.map(formatInteger).join(' / ')} |

Triangle count, winding, source positions/normals, and area are unchanged. Every original slit
side belongs to a different post-split chart; every extension has exactly two paired sides. The
chart-local 18-component/19-branch-vertex/zero-loop correction is documented in
\`../BLOCKERS.md\` and the M1 report.

${targetSections}

## Deployment decision

No manifest or atlas sections are emitted unless every target can encode every donor. The
floating walk tables remain fully measurable, but the brief's unsigned \`u16\` exact-sum record
cannot represent negative degraded weights. The second incompatible requested assertion
(adjoint scatter followed by gather equals one) is replaced only in the CPU oracle by the valid
transpose inner-product identity; it is not mislabeled as the requested deployed-data gate.
`;
}

function targetReport(target) {
  const { stats } = target;
  return `## ${target.fieldSize} × ${target.fieldSize} (${target.target.role})

| Gate | Measurement |
|---|---:|
| Gutter / direct-tap clamp | ${target.target.gutterTexels} / ${target.target.directTapClampTexels} texels |
| Global density scale | ${target.target.densityScale.toFixed(3)} |
| Authoritative texels | ${formatInteger(stats.authoritativeTexelCount)} |
| Conservative dilated demand | ${formatInteger(stats.dilatedTexelDemand)} (${percent(stats.measuredDemandRatio)}) |
| Achieved mask occupancy | ${percent(stats.achievedOccupancyRatio)} |
| Minimum-chart upscales | ${formatInteger(stats.minChartUpscaleCount)} |
| Clearance minimum / required | ${target.clearance.minimumChebyshevDistance} / ${target.target.gutterTexels * 2 + 1} Chebyshev texels |
| Closed-dilation intersections | ${target.clearance.dilatedIntersectionCount} |
| Mean world-texel width vs legacy | ${stats.meanWorldTexelWidthRatio.toFixed(5)}× |
| Min / max chart world-texel width vs legacy | ${target.density.minWorldTexelWidthRatio.toFixed(5)}× / ${target.density.maxWorldTexelWidthRatio.toFixed(5)}× |
| Density factor min / max | ${target.density.minFactor.toFixed(6)} / ${target.density.maxFactor.toFixed(6)} |
| Gutter donors / dead | ${formatInteger(target.gutter.recordCount)} / ${target.gutter.deadCount} |
| Exact / moment / degraded stencils | ${formatInteger(target.gutter.exactBilinear)} / ${formatInteger(target.gutter.nonnegativeMoment)} / ${formatInteger(target.gutter.degraded)} |
| Signed degraded (deployment blocker) | ${formatInteger(target.gutter.signedDegraded)} |
| Worst stencil first-moment error | ${target.gutter.maxPositionErrorTexels.toFixed(5)} texels |
| Maximum walk hops / chart crossings | ${target.gutter.maxWalkHops} / ${target.gutter.maxChartCrossings} |
| Directional frames / connected seam curves | ${formatInteger(target.frames.count)} / ${formatInteger(target.frames.groups)} |
| Frame-list covered / cap-overflow texels | ${formatInteger(target.frames.coveredTexels)} / ${formatInteger(target.frames.overflowCount)} |
| Maximum seam-curve candidates | ${target.frames.maximumCandidates} |
| Block nodes / directed edges | ${formatInteger(target.blocks.nodes)} / ${formatInteger(target.blocks.directedEdges)} |
| worldPos f16 error / ⅛-kernel threshold | ${target.precision.worstPositionError.toExponential(5)} / ${target.precision.threshold.toExponential(5)} world units |
| worldPos storage decision | ${target.precision.storage} |

Density sacrifice conversions: ${Object.entries(stats.parameterConversions).map(([name, scale]) => `\`${name}\` ×${scale}`).join(', ')}.

Every cap overflow is listed in \`${target.frames.overflowFile}\` as texel index, coordinate, and
pre-cap candidate count; the nearest four are retained.

### Worst density factors

| Chart | Original chart | Authoritative texels | Density factor | World width vs legacy | Min-chart upscale |
|---:|---:|---:|---:|---:|---|
${target.density.worst.map((row) => `| ${row.chartId} | ${row.originalChartId} | ${row.authoritativeTexelCount} | ${row.texelDensityFactor.toFixed(6)} | ${row.worldTexelWidthRatio.toFixed(5)}× | ${row.minChartUpscaled ? 'yes' : 'no'} |`).join('\n')}

### Worst seams (fold × anisotropy × boundary length)

| Pair | Score | Fold | Anisotropy | Length | Source/destination UV | World midpoint |
|---:|---:|---:|---:|---:|---|---|
${target.worstSeams.map((row) => `| ${row.pairIndex} | ${row.score.toFixed(2)} | ${row.foldDegrees.toFixed(2)}° | ${row.anisotropy.toFixed(3)} | ${row.lengthTexels.toFixed(2)} texels | ${vectors(row.uvMidpoints)} | ${vector(row.worldPos)} |`).join('\n')}

### Worst cone corners

| Charts | Defect | UV representatives | World coordinate |
|---:|---:|---|---|
${target.worstCorners.map((row) => `| ${row.chartCount} | ${row.defectRadians.toFixed(5)} rad | ${vectors(row.uvByChart.slice(0, 5).map(({ uv }) => uv))} | ${vector(row.worldPos)} |`).join('\n')}
`;
}

async function writeOverflowCensus(outputDirectory, fieldSize, boundaryIndex) {
  const name = `atlas-${fieldSize}.frame-overflow.csv.gz`;
  const rows = ['texelIndex,x,y,candidateCount'];
  for (const texelIndex of boundaryIndex.overflowTexels) rows.push(
    `${texelIndex},${texelIndex % fieldSize},${Math.floor(texelIndex / fieldSize)},${boundaryIndex.candidateCounts[texelIndex]}`,
  );
  const bytes = gzipSync(`${rows.join('\n')}\n`, { level: 9, mtime: 0 });
  if (bytes.byteLength >= MAX_SECTION_BYTES) throw new Error(`${name} exceeds the 95 MB file gate`);
  await writeFile(resolve(outputDirectory, name), bytes);
  return name;
}

async function bindShell(shellPath, manifest) {
  const html = await readFile(shellPath, 'utf8');
  const bound = html
    .replace(/(<meta name="atlas-schema-version" content=")[^"]+(">)/, `$1${manifest.schemaVersion}$2`)
    .replace(/(<meta name="atlas-manifest-root" content=")[^"]+(">)/, `$1${manifest.rootHash}$2`);
  if (bound === html || !bound.includes(manifest.rootHash)) throw new Error('atlas bake: shell binding markers are missing');
  await writeFile(shellPath, bound);
}

function smallestOatSigmaWorld(mesh, repack) {
  const effectiveSigmaUv = OAT_SIGMA_UV * repack.target.densityScale;
  let smallest = Infinity;
  for (let triangleIndex = 0; triangleIndex < mesh.triangleChartIds.length; triangleIndex += 1) {
    const jacobian = triangleJacobian(mesh, repack.uv1, triangleIndex);
    const g00 = dot3(jacobian.dU, jacobian.dU);
    const g01 = dot3(jacobian.dU, jacobian.dV);
    const g11 = dot3(jacobian.dV, jacobian.dV);
    const trace = g00 + g11;
    const discriminant = Math.sqrt(Math.max(0, (g00 - g11) ** 2 + 4 * g01 ** 2));
    const largestEigenvalue = (trace + discriminant) * 0.5;
    const determinant = Math.max(0, g00 * g11 - g01 ** 2);
    const smallestSingularValue = Math.sqrt(determinant / largestEigenvalue);
    smallest = Math.min(smallest, smallestSingularValue * effectiveSigmaUv);
  }
  if (!(smallest > 0)) throw new Error('atlas precision: smallest oat sigma is singular');
  return smallest;
}

function rankWorstSeams(mesh, repack, frames) {
  return mesh.seamPairs.map((pair, pairIndex) => {
    const directional = [frames[pairIndex * 2], frames[pairIndex * 2 + 1]];
    const anisotropy = Math.max(...directional.map((frame) => frame.anisotropy));
    const lengthTexels = directional.reduce((sum, frame) => sum + frame.sourceLengthTexels, 0) * 0.5;
    const foldDegrees = pair.foldAngleRadians * 180 / Math.PI;
    return {
      pairIndex,
      score: foldDegrees * anisotropy * lengthTexels,
      foldDegrees,
      anisotropy,
      lengthTexels,
      uvMidpoints: pair.sides.map((side) => edgeMidpointUv(repack.uv1, side)),
      worldPos: edgeMidpointWorld(mesh.positions, pair.sides[0]),
    };
  }).sort((left, right) => right.score - left.score || left.pairIndex - right.pairIndex).slice(0, WORST_ROW_COUNT);
}

function rankWorstCorners(mesh, uv1) {
  const corners = new Map();
  for (let triangleIndex = 0; triangleIndex < mesh.triangleChartIds.length; triangleIndex += 1) {
    const vertices = [...mesh.indices.subarray(triangleIndex * 3, triangleIndex * 3 + 3)];
    vertices.forEach((vertex, cornerIndex) => {
      const worldPos = vertexWorld(mesh.positions, vertex);
      const key = worldPos.map((value) => Math.round(value * 1e5)).join(':');
      let row = corners.get(key);
      if (!row) corners.set(key, row = { worldPos, angleSum: 0, charts: new Map() });
      row.angleSum += cornerAngle(mesh.positions, vertices, cornerIndex);
      row.charts.set(mesh.triangleChartIds[triangleIndex], [uv1[vertex * 2], uv1[vertex * 2 + 1]]);
    });
  }
  return [...corners.values()].filter(({ charts }) => charts.size >= 3).map((row) => ({
    worldPos: row.worldPos,
    chartCount: row.charts.size,
    defectRadians: 2 * Math.PI - row.angleSum,
    uvByChart: [...row.charts].map(([chartId, uv]) => ({ chartId, uv })),
  })).sort((left, right) => Math.abs(right.defectRadians) - Math.abs(left.defectRadians)).slice(0, WORST_ROW_COUNT);
}

function cornerAngle(positions, vertices, corner) {
  const center = vertexWorld(positions, vertices[corner]);
  const first = subtract3(vertexWorld(positions, vertices[(corner + 1) % 3]), center);
  const second = subtract3(vertexWorld(positions, vertices[(corner + 2) % 3]), center);
  return Math.acos(clamp(dot3(first, second) / (Math.hypot(...first) * Math.hypot(...second)), -1, 1));
}

function edgeMidpointUv(uv, side) {
  return [0, 1].map((axis) => (uv[side.vertex0 * 2 + axis] + uv[side.vertex1 * 2 + axis]) * 0.5);
}
function edgeMidpointWorld(positions, side) {
  return [0, 1, 2].map((axis) => (positions[side.vertex0 * 3 + axis] + positions[side.vertex1 * 3 + axis]) * 0.5);
}
function vertexWorld(positions, vertex) { return [...positions.subarray(vertex * 3, vertex * 3 + 3)]; }
function subtract3(a, b) { return a.map((value, axis) => value - b[axis]); }
function dot3(a, b) { return a.reduce((sum, value, axis) => sum + value * b[axis], 0); }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function maxTyped(values) { let result = 0; for (const value of values) result = Math.max(result, value); return result; }
function vector(values) { return values.map((value) => value.toFixed(6)).join(', '); }
function vectors(rows) { return rows.map((row) => `(${vector(row)})`).join(' ↔ '); }
function percent(value) { return `${(value * 100).toFixed(3)}%`; }
function formatInteger(value) { return value.toLocaleString('en-US'); }
function announce(quiet, message) { if (!quiet) console.log(message); }

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) bakeAtlas().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
