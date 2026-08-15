import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseGlb } from './glb.mjs';
import {
  boundsExtents,
  buildChartSegmentation,
  countSubTexelCharts,
  extractSeamEdges,
  normalizeGeometry,
} from './mesh.mjs';
import { packMeshAsset } from './pack.mjs';

const v2Root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INPUT = resolve(v2Root, '../luyvwj-fwgyww.glb');
const DEFAULT_ASSET = resolve(v2Root, 'assets/mesh-1.bin');
const DEFAULT_REPORT = resolve(v2Root, 'assets/mesh-report.md');
const TOOL_FILES = [
  'src/atlas/asset.js',
  'tools/bake-mesh.mjs',
  'tools/glb.mjs',
  'tools/mesh-components.mjs',
  'tools/mesh-topology.mjs',
  'tools/mesh.mjs',
  'tools/pack.mjs',
  'tools/union-find.mjs',
];

export async function bakeMesh({
  inputPath = DEFAULT_INPUT,
  assetPath = DEFAULT_ASSET,
  reportPath = DEFAULT_REPORT,
  quiet = false,
} = {}) {
  const inputBytes = await readFile(inputPath);
  const inputHash = sha256(inputBytes);
  const source = parseGlb(inputBytes, basename(inputPath));
  const normalization = normalizeGeometry(source.positions);
  const segmentation = buildChartSegmentation(source.uv0, source.indices);
  const seams = extractSeamEdges(source.positions, source.uv0, source.indices, segmentation);
  const subTexelCharts = {
    1024: countSubTexelCharts(
      source.uv0,
      source.indices,
      segmentation.triangleChartIds,
      segmentation.charts.length,
      1024,
    ),
    1536: countSubTexelCharts(
      source.uv0,
      source.indices,
      segmentation.triangleChartIds,
      segmentation.charts.length,
      1536,
    ),
  };
  const assetBytes = packMeshAsset({
    positions: normalization.positions,
    normals: source.normals,
    uv0: source.uv0,
    indices: source.indices,
    triangleChartIds: segmentation.triangleChartIds,
    charts: segmentation.charts,
    seamPairs: seams.seamPairs,
    slitComponents: seams.slitComponents,
  });
  const toolHashes = await hashToolFiles();
  const report = buildReport({
    inputName: basename(inputPath),
    inputHash,
    assetHash: sha256(assetBytes),
    assetByteLength: assetBytes.byteLength,
    toolHashes,
    source,
    normalization,
    segmentation,
    seams,
    subTexelCharts,
  });

  await Promise.all([
    writeOutput(assetPath, assetBytes),
    writeOutput(reportPath, report),
  ]);
  if (!quiet) {
    console.log(`baked ${relative(v2Root, assetPath)} (${assetBytes.byteLength.toLocaleString('en-US')} bytes)`);
    console.log(`wrote ${relative(v2Root, reportPath)}`);
  }
  return { assetBytes, report, segmentation, seams, subTexelCharts };
}

function buildReport(context) {
  const {
    inputName,
    inputHash,
    assetHash,
    assetByteLength,
    toolHashes,
    source,
    normalization,
    segmentation,
    seams,
    subTexelCharts,
  } = context;
  const foldCounts = [60, 80, 89].map((threshold) => [
    threshold,
    seams.seamPairs.filter((pair) => pair.foldAngleRadians * 180 / Math.PI > threshold).length,
  ]);
  const altitudesAt1536 = seams.seamPairs
    .flatMap((pair) => pair.sides.map((side) => side.uvAltitude * 1536))
    .sort((left, right) => left - right);
  const medianAltitude = altitudesAt1536[Math.floor(altitudesAt1536.length / 2)];
  const slitPairCount = seams.seamPairs.filter((pair) => pair.isSlit).length;
  const sourceExtents = boundsExtents(normalization.sourceBounds);
  const normalizedExtents = boundsExtents(normalization.normalizedBounds);
  const totalUvArea = segmentation.charts.reduce((sum, chart) => sum + chart.uvArea, 0);

  return `# MESH1 analysis report

Deterministic output of \`npm run bake:mesh\`. MESH1 contains the normalized input geometry and
original UVs; it does not contain M2's repacked or slit-split runtime topology.

## Mesh

| Quantity | Value |
|---|---:|
| Vertices | ${formatInteger(source.positions.length / 3)} |
| Triangles | ${formatInteger(source.indices.length / 3)} |
| Charts | ${formatInteger(segmentation.charts.length)} |
| Indexed UV-boundary sides | ${formatInteger(segmentation.boundarySides.length)} |
| Non-manifold indexed edges | ${formatInteger(segmentation.nonManifoldEdgeCount)} |
| Summed chart UV area | ${totalUvArea.toFixed(9)} |
| MESH1 bytes | ${formatInteger(assetByteLength)} |

All POSITION, NORMAL, and TEXCOORD_0 scalars are finite. UVs have zero scalars outside [0, 1].
The source uses indexed triangles with no GLB extensions; its one embedded image and material are
intentionally absent because the game replaces that material (legacy anchor \`main.js:15379\`).

## Legacy normalization frame

Legacy anchor: \`main.js:15294\`. Source bbox center is translated to the origin, then uniformly
scaled by ${normalization.scaleFactor.toFixed(12)} so its longest extent is 9.6 world units.

| Frame | Min xyz | Max xyz | Extents xyz |
|---|---|---|---|
| Source | ${formatVector(normalization.sourceBounds.min)} | ${formatVector(normalization.sourceBounds.max)} | ${formatVector(sourceExtents)} |
| Normalized | ${formatVector(normalization.normalizedBounds.min)} | ${formatVector(normalization.normalizedBounds.max)} | ${formatVector(normalizedExtents)} |

Source bbox center: ${formatVector(normalization.sourceCenter)}.

## Chart histograms

Triangle count per chart:

${markdownHistogram(histogram(segmentation.charts, 'triangleCount', [1, 4, 16, 64, 256, 1024]))}

UV area, expressed as equivalent texel area at each target field size (thin charts may still miss
every texel center, so this is deliberately separate from the exact sub-texel census):

### At 1536

${markdownHistogram(areaHistogram(segmentation.charts, 1536))}

### At 1024

${markdownHistogram(areaHistogram(segmentation.charts, 1024))}

Exact texel-center census:

| Field size | Charts containing zero texel centers | Chart ids |
|---:|---:|---|
| 1536 | ${subTexelCharts[1536].length} | ${subTexelCharts[1536].join(', ')} |
| 1024 | ${subTexelCharts[1024].length} | ${subTexelCharts[1024].join(', ')} |

## Seams

| Quantity | Value |
|---|---:|
| Undirected seam pairs | ${formatInteger(seams.seamPairs.length)} |
| Directional sides | ${formatInteger(seams.directionalSideCount)} |
| Cross-chart pairs | ${formatInteger(seams.seamPairs.length - slitPairCount)} |
| Same-chart slit pairs | ${formatInteger(slitPairCount)} |
| Chart-local slit components | ${formatInteger(seams.slitComponents.length)} |
| Largest chart-local component | ${formatInteger(Math.max(...seams.slitComponents.map((component) => component.edgeCount)))} edges |
| Endpoint-only slit groups (diagnostic) | ${formatInteger(seams.endpointGroupedSlitComponentCount)} |
| Fold >60° / >80° / >89° | ${foldCounts.map(([, count]) => formatInteger(count)).join(' / ')} |
| Median adjacent-triangle altitude at 1536 | ${medianAltitude.toFixed(4)} texels |
| Directional sides below 4 texels altitude | ${formatInteger(altitudesAt1536.filter((altitude) => altitude < 4).length)} |

Corner census: 3-chart ${formatInteger(seams.cornerCensus.byChartCount[3])},
4-chart ${formatInteger(seams.cornerCensus.byChartCount[4])}, and
5-chart ${formatInteger(seams.cornerCensus.byChartCount[5])}. Angle defects at the multi-chart
corners: +${formatInteger(seams.cornerCensus.angleDefects.positive)} positive,
−${formatInteger(seams.cornerCensus.angleDefects.negative)} negative, and
${formatInteger(seams.cornerCensus.angleDefects.flat)} approximately flat (±0.05 rad).

### Slit graph scope blocker

The audited 19 branching components and 5 closed loops occur in the 570 endpoint-only groups,
not in the required 630 chart-local work units. The chart-local graph measures 18 branching
components with 19 branch vertices and zero closed loops. \`../BLOCKERS.md\` records the exact
contradiction and its M2 impact; both graph scopes are retained below instead of relabeling one.

| Graph | Components | Multi-chart groups | Branching components | Branch vertices | Closed loops |
|---|---:|---:|---:|---:|---:|
| Endpoint-only diagnostic | ${seams.endpointGroupStats.componentCount} | ${seams.endpointGroupStats.multiChartGroupCount} | ${seams.endpointGroupStats.branchingComponentCount} | ${seams.endpointGroupStats.branchVertexCount} | ${seams.endpointGroupStats.closedLoopCount} |
| Chart-local work units | ${seams.chartLocalComponentStats.componentCount} | 0 | ${seams.chartLocalComponentStats.branchingComponentCount} | ${seams.chartLocalComponentStats.branchVertexCount} | ${seams.chartLocalComponentStats.closedLoopCount} |

## Provenance hashes (SHA-256)

| Input/output | Hash |
|---|---|
| ${inputName} | \`${inputHash}\` |
| mesh-1.bin | \`${assetHash}\` |
| Combined tool chain | \`${combinedToolHash(toolHashes)}\` |

| Tool file | SHA-256 |
|---|---|
${toolHashes.map(({ name, hash }) => `| ${name} | \`${hash}\` |`).join('\n')}
`;
}

function histogram(records, property, upperBounds) {
  const counts = new Array(upperBounds.length + 1).fill(0);
  for (const record of records) {
    const bin = upperBounds.findIndex((upperBound) => record[property] <= upperBound);
    counts[bin === -1 ? counts.length - 1 : bin] += 1;
  }
  return counts.map((count, index) => ({
    band: histogramBand(index, upperBounds),
    count,
  }));
}

function areaHistogram(charts, fieldSize) {
  const upperBounds = [1, 4, 16, 64, 256, 1024];
  const scaled = charts.map((chart) => ({ texelArea: chart.uvArea * fieldSize * fieldSize }));
  return histogram(scaled, 'texelArea', upperBounds);
}

function histogramBand(index, upperBounds) {
  if (index === 0) return `≤ ${upperBounds[0]}`;
  if (index === upperBounds.length) return `> ${upperBounds.at(-1)}`;
  return `> ${upperBounds[index - 1]} to ≤ ${upperBounds[index]}`;
}

function markdownHistogram(rows) {
  return `| Band | Charts |\n|---|---:|\n${rows.map(({ band, count }) => `| ${band} | ${count} |`).join('\n')}`;
}

async function hashToolFiles() {
  return Promise.all(TOOL_FILES.map(async (name) => ({
    name,
    hash: sha256(await readFile(resolve(v2Root, name))),
  })));
}

function combinedToolHash(toolHashes) {
  return sha256(toolHashes.map(({ name, hash }) => `${name}:${hash}\n`).join(''));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function writeOutput(filePath, contents) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

function formatInteger(value) {
  return value.toLocaleString('en-US');
}

function formatVector(values) {
  return values.map((value) => value.toFixed(9)).join(', ');
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--quiet') options.quiet = true;
    else if (argument === '--input') options.inputPath = resolve(argv[++index]);
    else if (argument === '--asset') options.assetPath = resolve(argv[++index]);
    else if (argument === '--report') options.reportPath = resolve(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  bakeMesh(parseArguments(process.argv.slice(2))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
