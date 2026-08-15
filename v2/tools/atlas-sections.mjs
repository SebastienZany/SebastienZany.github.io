import { quantizeFloat16 } from './float16.mjs';
import { packAtlasSection } from './section-pack.mjs';

// A target remains a group of independently compressed files so no one section can cross the
// Pages/GitHub ceiling. The manifest, rather than shared filenames, is the atomic version bond.
export function buildTargetSectionInputs(splitMesh, targetResult) {
  const { repack, frames, raster, boundaryIndex, blockGraph, precision } = targetResult;
  if (raster.gutter.deploymentBlocked) {
    throw new Error(
      `atlas sections: ${raster.gutter.census.signedDegraded} signed donor stencils cannot be encoded as unsigned u16`,
    );
  }
  const size = repack.fieldSize;
  const metadata = { fieldSize: size, gutterTexels: repack.target.gutterTexels };
  const chartArrays = encodeChartTable(repack.chartTable);
  const nodeArrays = encodeBlockNodes(blockGraph.nodes);
  const worldValues = precision.storage === 'f16' ? quantizeFloat16(raster.worldPos) : raster.worldPos;
  return [
    section(size, 'geometry', {
      positions: splitMesh.positions,
      normals: splitMesh.normals,
      indices: splitMesh.indices,
      originalVertexIds: splitMesh.originalVertexIds,
      triangleChartIds: splitMesh.triangleChartIds,
    }, metadata),
    section(size, 'charts', { uv1: repack.uv1, ...chartArrays }, {
      ...metadata,
      densityScale: repack.target.densityScale,
      parameterConversions: repack.stats.parameterConversions,
    }),
    section(size, 'frames', { frameData: frames.frameData }, {
      ...metadata,
      frameStrideFloats: frames.frameStrideFloats,
      zeroRecordReserved: true,
    }),
    section(size, 'ownership', {
      ownership: raster.ownership,
      triangleMap: raster.triangleMap,
    }, metadata),
    section(size, 'world', { worldPos: worldValues }, { ...metadata, storage: precision.storage }),
    section(size, 'tangents', { tangentFrame: raster.tangentFrame }, metadata),
    section(size, 'gutter', {
      coords: raster.gutter.coords,
      tapIndices: raster.gutter.tapIndices,
      weights: raster.gutter.quantizedWeights,
      stencilClass: raster.gutter.stencilClass,
      walkTriangles: raster.gutter.walkTriangles,
      walkHopCounts: raster.gutter.walkHopCounts,
      walkChartCrossings: raster.gutter.walkChartCrossings,
    }, { ...metadata, weightEncoding: 'u16-unorm-exact-sum-65535', tapCount: 4 }),
    section(size, 'boundary', {
      nearestFrame: boundaryIndex.nearestFrame,
      frameLists: boundaryIndex.frameLists,
      frameListCounts: boundaryIndex.frameListCounts,
      candidateCounts: boundaryIndex.candidateCounts,
      overflowTexels: boundaryIndex.overflowTexels,
    }, { ...metadata, frameListCap: 4 }),
    section(size, 'blocks', {
      ...nodeArrays,
      offsets: blockGraph.offsets,
      targets: blockGraph.targets,
      weights: blockGraph.weights,
    }, {
      ...metadata,
      nodeCount: blockGraph.nodeCount,
      blocksPerAxis: blockGraph.blocksPerAxis,
      blockTexels: blockGraph.blockTexels,
    }),
  ];
}

function section(size, name, arrays, metadata) {
  return { size, name, bytes: packAtlasSection(arrays, metadata) };
}

function encodeChartTable(charts) {
  const chartIds = new Uint32Array(charts.length);
  const originalChartIds = new Uint32Array(charts.length);
  const scale = new Float32Array(charts.length);
  const translateUv = new Float32Array(charts.length * 2);
  const authoritativeTexelCount = new Uint32Array(charts.length);
  const worldAreaPerTexel = new Float32Array(charts.length);
  const texelDensityFactor = new Float32Array(charts.length);
  const flags = new Uint8Array(charts.length);
  charts.forEach((chart, index) => {
    chartIds[index] = chart.chartId;
    originalChartIds[index] = chart.originalChartId;
    scale[index] = chart.scale;
    translateUv.set(chart.translateUv, index * 2);
    authoritativeTexelCount[index] = chart.authoritativeTexelCount;
    worldAreaPerTexel[index] = chart.worldAreaPerTexel;
    texelDensityFactor[index] = chart.texelDensityFactor;
    flags[index] = chart.minChartUpscaled ? 1 : 0;
  });
  return {
    chartIds,
    originalChartIds,
    scale,
    translateUv,
    authoritativeTexelCount,
    worldAreaPerTexel,
    texelDensityFactor,
    flags,
  };
}

function encodeBlockNodes(nodes) {
  const nodeChartIds = new Uint32Array(nodes.length);
  const nodeBlockCoords = new Uint16Array(nodes.length * 2);
  const nodeTexelCounts = new Uint32Array(nodes.length);
  const nodeWorldCenters = new Float32Array(nodes.length * 3);
  nodes.forEach((node, index) => {
    nodeChartIds[index] = node.chartId;
    nodeBlockCoords.set([node.blockX, node.blockY], index * 2);
    nodeTexelCounts[index] = node.texelCount;
    nodeWorldCenters.set(node.worldCenter, index * 3);
  });
  return { nodeChartIds, nodeBlockCoords, nodeTexelCounts, nodeWorldCenters };
}
