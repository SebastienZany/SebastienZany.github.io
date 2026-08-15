import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { parseMeshAsset } from '../src/atlas/asset.js';
import { DEFAULT_ATLAS_TARGETS, MAX_SECTION_BYTES } from './atlas-constants.mjs';
import { buildBlockGraph } from './block-graph.mjs';
import { verifyBlockGraph } from './block-graph-verification.mjs';
import { buildBoundaryFrameIndex } from './boundary-index.mjs';
import { verifyC1Reconstruction } from './c1-verification.mjs';
import { measureCornerContinuity } from './corner-verification.mjs';
import { verifyDiffusionMass } from './diffusion-verification.mjs';
import { verifyImpulseSpread } from './impulse-verification.mjs';
import { fixtureBakeMesh } from './fixture-pipeline.mjs';
import { buildFixtureSet } from './fixtures.mjs';
import { rasterizeAtlas } from './rasterize.mjs';
import { repackAtlasWithTarget } from './repack.mjs';
import {
  measureAffineWalkBands,
  measureRandomTransport,
  measureWalkReconstruction,
  sharpWorldField,
  smoothWorldField,
  verifyCorruptedDonorIsDetected,
  verifyCoverage,
  verifyStencilTable,
  verifyTransposeIdentity,
} from './seam-verification.mjs';
import { buildDirectionalFrames } from './seams.mjs';
import { splitChartLocalSlits } from './slit-split.mjs';
import { verifySeamConditionedTransport } from './transport-verification.mjs';

const v2Root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MESH_PATH = resolve(v2Root, 'assets/mesh-1.bin');
const REPORT_PATH = resolve(v2Root, 'assets/verify-seams-report.md');
const COVERAGE_SAMPLES = 100_000;
const TRANSPORT_SAMPLES = 100_000;
// Exact-bilinear stencils must reproduce their endpoint's first moment to the brief's ¼-texel bar.
const EXACT_STENCIL_MOMENT_TEXELS = 0.25;
// The numerical inner-product proof sums roughly one million terms; 2e-12 relative retains
// several orders of margin over observed f64 accumulation noise without hiding a wrong tap.
const TRANSPOSE_RELATIVE_EPSILON = 2e-12;

export class SeamVerificationBlockedError extends Error {}

export async function verifySeams({ quiet = false } = {}) {
  const sourceMesh = parseMeshAsset(await readFile(MESH_PATH));
  const splitMesh = splitChartLocalSlits(sourceMesh);
  const context = { fixtures: [], targets: [], failures: [], pending: pendingInvariantList() };
  announce(quiet, 'verifying analytic fixtures at both required field sizes');

  for (const target of DEFAULT_ATLAS_TARGETS) {
    for (const [name, fixture] of Object.entries(buildFixtureSet())) {
      try {
        const fixtureTarget = { ...target, densityScale: 0.3, role: 'fixture' };
        const metrics = verifyOneTarget(
          splitChartLocalSlits(fixtureBakeMesh(fixture)),
          fixtureTarget,
          0x2000 + target.fieldSize + context.fixtures.length,
        );
        context.fixtures.push({ name, fieldSize: target.fieldSize, ...compactMetrics(metrics) });
        applyCoreGates(metrics, `${name}@${target.fieldSize}`, context.failures, true);
      } catch (error) {
        context.failures.push(`${name}@${target.fieldSize}: ${error.message}`);
      }
      globalThis.gc?.();
    }
  }
  await writeFile(REPORT_PATH, buildReport(context));

  for (const target of DEFAULT_ATLAS_TARGETS) {
    announce(quiet, `${target.fieldSize}: verifying real coverage, donors, affine bands, and transport`);
    try {
      const metrics = verifyOneTarget(splitMesh, target, 0x5000 + target.fieldSize);
      const failureFile = await writeTransportFailures(target.fieldSize, metrics.transport);
      const conditionedFailureFile = await writeTransportFailures(
        target.fieldSize,
        metrics.conditionedTransport,
        'conditioned-transport-failures',
      );
      context.targets.push({ fieldSize: target.fieldSize, failureFile, conditionedFailureFile, ...compactMetrics(metrics) });
      applyCoreGates(metrics, `real@${target.fieldSize}`, context.failures, false);
      if (metrics.stencils.signedCount) {
        context.failures.push(
          `real@${target.fieldSize}: ${metrics.stencils.signedCount.toLocaleString('en-US')} signed donor records have no u16 encoding`,
        );
      }
    } catch (error) {
      context.failures.push(`real@${target.fieldSize}: ${error.message}`);
    }
    await writeFile(REPORT_PATH, buildReport(context));
    globalThis.gc?.();
  }

  await writeFile(REPORT_PATH, buildReport(context));
  if (context.failures.length || context.pending.length) {
    throw new SeamVerificationBlockedError(
      `seam verification incomplete: ${context.failures.length} failed/blocking gates and ${context.pending.length} pending invariant groups; see assets/verify-seams-report.md`,
    );
  }
  return context;
}

function verifyOneTarget(mesh, target, seed) {
  const repack = repackAtlasWithTarget(mesh, target);
  const frames = buildDirectionalFrames(mesh, repack);
  const raster = rasterizeAtlas(mesh, repack);
  const boundary = buildBoundaryFrameIndex(mesh, repack, frames, raster.authoritativeOwner);
  const graph = buildBlockGraph(mesh, repack, raster);
  const blockVerification = verifyBlockGraph(mesh, repack, raster, graph);
  const coverage = verifyCoverage(mesh, repack, raster, COVERAGE_SAMPLES, seed);
  const stencils = verifyStencilTable(mesh, repack, raster);
  const transpose = verifyTransposeIdentity(raster);
  const smooth = measureWalkReconstruction(mesh, repack, raster, smoothWorldField);
  const sharp = measureWalkReconstruction(mesh, repack, raster, sharpWorldField);
  const affine = measureAffineWalkBands(mesh, repack, frames, raster.surfaceTopology);
  const c1 = verifyC1Reconstruction(mesh, repack, raster, frames);
  const corners = measureCornerContinuity(mesh, repack, raster);
  const diffusion = target.role === 'fixture' ? null : verifyDiffusionMass(repack, raster, boundary, 100);
  const impulse = verifyImpulseSpread(mesh, repack, raster, target.role === 'fixture' ? 2 : 8, 4);
  const transport = measureRandomTransport(repack, raster, boundary, frames, TRANSPORT_SAMPLES, seed ^ 0xa63_17e5);
  const conditionedTransport = target.role === 'fixture' ? null : verifySeamConditionedTransport(
    mesh, repack, raster, boundary, frames, TRANSPORT_SAMPLES, seed ^ 0x7a6_5eab,
  );
  const corruption = verifyCorruptedDonorIsDetected(mesh, repack, raster);
  return {
    repack,
    raster,
    frames,
    boundary,
    graph,
    blockVerification,
    coverage,
    stencils,
    transpose,
    smooth,
    sharp,
    affine,
    c1,
    corners,
    diffusion,
    impulse,
    transport,
    conditionedTransport,
    corruption,
  };
}

function applyCoreGates(metrics, label, failures, fixture) {
  if (metrics.raster.gutter.deadCount !== 0) failures.push(`${label}: ${metrics.raster.gutter.deadCount} dead gutters`);
  if (metrics.stencils.maxMomentErrorByClass[0] > EXACT_STENCIL_MOMENT_TEXELS) {
    failures.push(`${label}: exact stencil moment error ${metrics.stencils.maxMomentErrorByClass[0]} texels`);
  }
  if (metrics.transpose.relativeError > TRANSPOSE_RELATIVE_EPSILON) {
    failures.push(`${label}: transpose relative error ${metrics.transpose.relativeError}`);
  }
  const smoothFilledMaximum = Math.max(...metrics.smooth.bands.map(({ maxValueError }) => maxValueError));
  const sharpFilledMaximum = Math.max(...metrics.sharp.bands.map(({ maxValueError }) => maxValueError));
  if (metrics.smooth.disabledMaxValueError <= smoothFilledMaximum) failures.push(`${label}: smooth no-fill negative control did not fail`);
  if (metrics.sharp.disabledMaxValueError <= sharpFilledMaximum) failures.push(`${label}: sharp no-fill negative control did not fail`);
  if (!metrics.corruption.rejected) failures.push(`${label}: corrupted donor injection passed`);
  if (metrics.corners.uncoveredCornerCount) failures.push(`${label}: ${metrics.corners.uncoveredCornerCount} multi-chart corners lack gutter samples`);
  if (metrics.diffusion && !metrics.diffusion.massBoundPassed) {
    failures.push(`${label}: 100-step mass drift reaches ${metrics.diffusion.maximumRelativeMassDrift}`);
  }
  if (metrics.diffusion && !metrics.diffusion.bandBoundPassed) {
    failures.push(`${label}: per-seam-band signed flux reaches ${metrics.diffusion.maximumRelativeBandFlux}`);
  }
  if (metrics.diffusion && !metrics.diffusion.wrongTapDetected) failures.push(`${label}: wrong diffusion tap did not fail the flux detector`);
  if (metrics.impulse.traceViolations || metrics.impulse.ellipticityViolations) {
    failures.push(
      `${label}: impulse spread has ${metrics.impulse.traceViolations} speed and `
      + `${metrics.impulse.ellipticityViolations} ellipticity violations`,
    );
  }
  if (metrics.blockVerification.distanceViolationCount) {
    failures.push(`${label}: block graph has ${metrics.blockVerification.distanceViolationCount} exact-distance violations`);
  }
  if (metrics.blockVerification.continuityViolationCount) {
    failures.push(`${label}: block interpolation has ${metrics.blockVerification.continuityViolationCount} continuity violations`);
  }
  if (metrics.conditionedTransport) {
    for (const [name, count] of [
      ['resolver failures', metrics.conditionedTransport.resolverFailures],
      ['position failures', metrics.conditionedTransport.positionViolations],
      ['heading failures', metrics.conditionedTransport.headingViolations],
      ['cross-back failures', metrics.conditionedTransport.crossBackViolations],
    ]) if (count) failures.push(`${label}: conditioned transport has ${count} ${name}`);
  }
  if (metrics.c1.smooth.interiorValueViolations || metrics.c1.smooth.interiorGradientViolations) {
    failures.push(
      `${label}: seam-interior C1 smooth gate has ${metrics.c1.smooth.interiorValueViolations} value and `
      + `${metrics.c1.smooth.interiorGradientViolations} gradient violations`,
    );
  }
  if (metrics.c1.sharp.interiorValueViolations) {
    failures.push(`${label}: seam-interior sharp-front pointwise gate has ${metrics.c1.sharp.interiorValueViolations} violations`);
  }
  if (fixture) {
    const maximumAffine = Math.max(...metrics.affine.map(({ maxAffineErrorTexels }) => maxAffineErrorTexels));
    if (maximumAffine > EXACT_STENCIL_MOMENT_TEXELS) failures.push(`${label}: fixture hinge affine error ${maximumAffine} texels`);
  }
}

function compactMetrics(metrics) {
  return {
    fieldSize: metrics.repack.fieldSize,
    gutterTexels: metrics.repack.target.gutterTexels,
    charts: metrics.repack.chartTable.length,
    seams: metrics.frames.frameCount / 2,
    demandRatio: metrics.repack.stats.measuredDemandRatio,
    clearance: metrics.repack.clearance.minimumChebyshevDistance,
    coverage: metrics.coverage,
    stencils: metrics.stencils,
    transpose: metrics.transpose,
    smooth: metrics.smooth,
    sharp: metrics.sharp,
    affine: metrics.affine,
    c1: metrics.c1,
    corners: metrics.corners,
    diffusion: metrics.diffusion,
    impulse: metrics.impulse,
    transport: { ...metrics.transport, failureTexels: undefined },
    conditionedTransport: metrics.conditionedTransport
      ? { ...metrics.conditionedTransport, failureTexels: undefined }
      : null,
    frameOverflow: metrics.boundary.overflowCount,
    maximumFrameCandidates: maximum(metrics.boundary.candidateCounts),
    multipleFrameCandidates: countWhere(metrics.boundary.candidateCounts, (value) => value > 1),
    blockNodes: metrics.graph.nodeCount,
    blockEdges: metrics.graph.targets.length,
    blockVerification: metrics.blockVerification,
  };
}

function buildReport(context) {
  const fixtureRows = context.fixtures.map((row) => `| ${row.name} | ${row.fieldSize} | ${row.charts} | ${row.stencils.recordCount} | ${row.stencils.signedCount} | ${scientific(row.transpose.relativeError)} | ${row.transport.seamCount} | ${row.transport.conservativeFailureCount} | ${row.blockVerification.distanceViolationCount} / ${row.blockVerification.continuityViolationCount} |`).join('\n');
  return `# M2 seam invariant report

CPU output of \`npm run verify:seams\`. Status: **${context.failures.length || context.pending.length ? 'not green' : 'green'}**.
The exact-bilinear ¼-texel bar is applied only to that class. Moment/degraded records retain
their own measured bands, as required by the brief.

## Fixture matrix

| Fixture | Size | Charts | Gutters | Signed degraded | Transpose rel. error | Seam walks | Conservative failures | Block exact / continuity violations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${fixtureRows || '| _in progress_ | | | | | | | | |'}

${context.targets.map(realTargetReport).join('\n')}

## Failed or blocking gates

${context.failures.length ? context.failures.map((failure) => `- ${failure}`).join('\n') : '_None._'}

## Invariant groups not yet established

${context.pending.length ? context.pending.map((entry) => `- ${entry}`).join('\n') : '_None._'}

The missing groups are reported as missing—not skipped or inferred from adjacent tests. Browser/GPU
work is outside this CPU milestone and is not attempted by this command.
`;
}

function realTargetReport(row) {
  const smooth = row.smooth.bands; const sharp = row.sharp.bands;
  return `## Real atlas ${row.fieldSize}

| Invariant | Measurement |
|---|---:|
| Coverage samples / wrong chart | ${formatInteger(row.coverage.sampleCount)} / ${row.coverage.wrongChartSamples} |
| Authoritative texels missing/wrong triangle | ${row.coverage.missingTriangleTexels} / ${row.coverage.wrongTriangleChartTexels} |
| Clearance measured / required | ${row.clearance} / ${row.gutterTexels * 2 + 1} |
| Gutter records / signed degraded | ${formatInteger(row.stencils.recordCount)} / ${formatInteger(row.stencils.signedCount)} |
| Exact/moment/degraded moment max | ${row.stencils.maxMomentErrorByClass.map((value) => value.toFixed(6)).join(' / ')} texels |
| Weight-sum max / absolute-weight max | ${scientific(row.stencils.maxWeightSumError)} / ${row.stencils.maxAbsoluteWeight.toFixed(6)} |
| Transpose identity relative error | ${scientific(row.transpose.relativeError)} |
| Smooth value max exact/moment/degraded | ${smooth.map(({ maxValueError }) => scientific(maxValueError)).join(' / ')} |
| Sharp value max exact/moment/degraded | ${sharp.map(({ maxValueError }) => scientific(maxValueError)).join(' / ')} |
| Smooth/sharp no-fill negative-control max | ${scientific(row.smooth.disabledMaxValueError)} / ${scientific(row.sharp.disabledMaxValueError)} |
| Affine max by distance | ${row.affine.map(({ distanceTexels, maxAffineErrorTexels }) => `${distanceTexels}: ${maxAffineErrorTexels.toFixed(4)}`).join('; ')} texels |
| Legacy max by distance | ${row.affine.map(({ distanceTexels, maxLegacyErrorTexels }) => `${distanceTexels}: ${maxLegacyErrorTexels.toFixed(4)}`).join('; ')} texels |
| C1 paths / interior / corner-zone samples | ${formatInteger(row.c1.pathCount)} / ${formatInteger(row.c1.smooth.interiorSampleCount)} / ${formatInteger(row.c1.smooth.cornerSampleCount)} |
| Smooth interior value / gradient violations | ${formatInteger(row.c1.smooth.interiorValueViolations)} / ${formatInteger(row.c1.smooth.interiorGradientViolations)} |
| Smooth corner-zone value / gradient violations | ${formatInteger(row.c1.smooth.cornerValueViolations)} / ${formatInteger(row.c1.smooth.cornerGradientViolations)} |
| Sharp interior / corner-zone pointwise violations | ${formatInteger(row.c1.sharp.interiorValueViolations)} / ${formatInteger(row.c1.sharp.cornerValueViolations)} |
| C1 disabled-fill value/gradient trips | ${formatInteger(row.c1.smooth.negativeControlValueViolations + row.c1.sharp.negativeControlValueViolations)} / ${formatInteger(row.c1.smooth.negativeControlGradientViolations)} |
| ≥3-chart corners / uncovered / sampled records | ${formatInteger(row.corners.cornerCount)} / ${formatInteger(row.corners.uncoveredCornerCount)} / ${formatInteger(row.corners.sampledRecordCount)} |
| Corner cross-bisector excess / donor error max | ${scientific(row.corners.maxCrossBisectorExcess)} / ${scientific(row.corners.maxDonorValueError)} |
| Measured corner value-error radius / C1 gradient-violation radius | ${row.corners.maxErrorRadiusTexels.toFixed(4)} / ${row.c1.smooth.maxCornerGradientViolationRadiusTexels.toFixed(4)} texels |
| 100-step mass drift / worst local seam-band flux | ${scientific(row.diffusion.maximumRelativeMassDrift)} / ${scientific(row.diffusion.maximumRelativeBandFlux)} |
| Ledger residual / wrong-tap max band delta / detected | ${scientific(row.diffusion.maximumLedgerResidual)} / ${scientific(row.diffusion.wrongTapMaximumRelativeBandDelta)} / ${row.diffusion.wrongTapDetected ? 'yes' : 'NO'} |
| Impulses / spread-speed / ellipticity violations | ${row.impulse.sampleCount} / ${row.impulse.traceViolations} / ${row.impulse.ellipticityViolations} |
| Worst impulse trace / ellipticity mismatch | ${percent(row.impulse.maximumTraceMismatch)} / ${percent(row.impulse.maximumEllipticityMismatch)} |
| Random transport samples / seam resolves / failures | ${formatInteger(row.transport.sampleCount)} / ${formatInteger(row.transport.seamCount)} / ${formatInteger(row.transport.conservativeFailureCount)} |
| Cross-backs >¼ / worst | ${formatInteger(row.transport.crossBackOverQuarterTexel)} / ${row.transport.maxCrossBackErrorTexels.toFixed(5)} texels |
| Conditioned walks / eligible frames / resolver failures | ${formatInteger(row.conditionedTransport.sampleCount)} / ${formatInteger(row.conditionedTransport.eligibleFrameCount)} / ${formatInteger(row.conditionedTransport.resolverFailures)} |
| Conditioned position / heading / cross-back failures | ${formatInteger(row.conditionedTransport.positionViolations)} / ${formatInteger(row.conditionedTransport.headingViolations)} / ${formatInteger(row.conditionedTransport.crossBackViolations)} |
| Conditioned worst position / heading / cross-back | ${row.conditionedTransport.maxPositionErrorTexels.toFixed(5)} texels / ${row.conditionedTransport.maxHeadingErrorDegrees.toFixed(5)}° / ${row.conditionedTransport.maxCrossBackErrorTexels.toFixed(5)} texels |
| Frame cap overflow / maximum candidates | ${formatInteger(row.frameOverflow)} / ${row.maximumFrameCandidates} |
| Texels with >1 nearby seam curve (proxy, not multi-hop incidence) | ${formatInteger(row.multipleFrameCandidates)} |
| Block graph nodes / directed edges | ${formatInteger(row.blockNodes)} / ${formatInteger(row.blockEdges)} |
| Block interpolation samples / violations | ${formatInteger(row.blockVerification.continuitySampleCount)} / ${formatInteger(row.blockVerification.continuityViolationCount)} |

Every conservative-failure texel from this run is listed in \`${row.failureFile}\`.
Every failed geometrically conditioned walk is listed in \`${row.conditionedFailureFile}\`.

Worst cone corners:

| Charts | Defect | Cross-bisector excess | Donor error | Error radius | World position |
|---:|---:|---:|---:|---:|---|
${row.corners.worst.slice(0, 10).map((corner) => `| ${corner.chartCount} | ${corner.defectRadians.toFixed(5)} | ${scientific(corner.maxCrossBisectorExcess)} | ${scientific(corner.maxDonorValueError)} | ${corner.maxErrorRadiusTexels.toFixed(3)} | ${corner.worldPos.map((value) => value.toFixed(6)).join(', ')} |`).join('\n')}

Worst signed diffusion bands:

| Seam-curve group | Relative flux | Signed world-area flux |
|---:|---:|---:|
${row.diffusion.worstGroups.slice(0, 10).map((group) => `| ${group.groupId} | ${scientific(group.relativeFlux)} | ${scientific(group.signedFlux)} |`).join('\n')}
`;
}

function pendingInvariantList() {
  return [
    'Exact multi-hop sensing incidence along sensor-disc chords (nearby-frame multiplicity is reported only as a proxy).',
    'Deployed-data quantized transpose/conservation proof, blocked by the missing signed donor encoding.',
  ];
}

async function writeTransportFailures(fieldSize, transport, suffix = 'transport-failures') {
  const name = `atlas-${fieldSize}.${suffix}.csv.gz`;
  const rows = ['texelIndex,x,y', ...Array.from(transport.failureTexels, (texel) => (
    `${texel},${texel % fieldSize},${Math.floor(texel / fieldSize)}`
  ))];
  const bytes = gzipSync(`${rows.join('\n')}\n`, { level: 9, mtime: 0 });
  if (bytes.byteLength >= MAX_SECTION_BYTES) throw new Error(`${name} exceeds 95 MB`);
  await writeFile(resolve(v2Root, 'assets', name), bytes);
  return name;
}

function maximum(values) { let result = 0; for (const value of values) result = Math.max(result, value); return result; }
function countWhere(values, predicate) { let result = 0; for (const value of values) if (predicate(value)) result += 1; return result; }
function scientific(value) { return value.toExponential(4); }
function percent(value) { return `${(value * 100).toFixed(2)}%`; }
function formatInteger(value) { return value.toLocaleString('en-US'); }
function announce(quiet, message) { if (!quiet) console.log(message); }

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) verifySeams().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
