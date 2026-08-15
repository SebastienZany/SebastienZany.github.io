import { calculateCornerCensus, classifySlitComponents } from './mesh-components.mjs';
import { DisjointSets } from './union-find.mjs';

export const POSITION_PAIR_EPSILON = 1e-5;
const NO_COMPONENT = 0xffffffff;

export function buildChartSegmentation(uv0, indices) {
  validateMeshInputs(undefined, uv0, indices);
  const triangleCount = indices.length / 3;
  const sets = new DisjointSets(triangleCount);
  const edgeUses = new Map();
  let nonManifoldEdgeCount = 0;

  forEachTriangleEdge(indices, (triangleIndex, vertex0, vertex1) => {
    const key = indexEdgeKey(vertex0, vertex1, uv0.length / 2);
    const firstUse = edgeUses.get(key);
    if (!firstUse) {
      edgeUses.set(key, { triangleIndex, vertex0, vertex1, useCount: 1 });
      return;
    }
    if (!sameUvEdge(firstUse, vertex0, vertex1, uv0)) return;
    sets.union(firstUse.triangleIndex, triangleIndex);
    firstUse.useCount += 1;
    if (firstUse.useCount === 3) nonManifoldEdgeCount += 1;
  });

  const triangleChartIds = new Uint32Array(triangleCount);
  const rootToChart = new Map();
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const root = sets.find(triangleIndex);
    if (!rootToChart.has(root)) rootToChart.set(root, rootToChart.size);
    triangleChartIds[triangleIndex] = rootToChart.get(root);
  }

  const charts = createChartStats(rootToChart.size);
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    accumulateChartTriangle(charts[triangleChartIds[triangleIndex]], triangleIndex, uv0, indices);
  }
  const boundarySides = [];
  for (const edge of edgeUses.values()) {
    if (edge.useCount !== 1) continue;
    boundarySides.push({
      triangleIndex: edge.triangleIndex,
      vertex0: edge.vertex0,
      vertex1: edge.vertex1,
      chartId: triangleChartIds[edge.triangleIndex],
    });
  }

  return { triangleChartIds, charts, boundarySides, nonManifoldEdgeCount };
}

export function extractSeamEdges(
  positions,
  uv0,
  indices,
  segmentation,
  { positionEpsilon = POSITION_PAIR_EPSILON } = {},
) {
  validateMeshInputs(positions, uv0, indices);
  if (!segmentation?.triangleChartIds || !segmentation?.boundarySides) {
    throw new Error('seams: chart segmentation with boundary sides is required');
  }
  if (!(positionEpsilon > 0)) throw new Error('seams: position epsilon must be positive');

  const edgeGroups = groupBoundarySides(positions, segmentation.boundarySides, positionEpsilon);
  const seamPairs = [];
  let unmatchedBoundaryCount = 0;
  let ambiguousBoundaryCount = 0;
  for (const sides of edgeGroups.values()) {
    if (sides.length === 1) {
      unmatchedBoundaryCount += 1;
      continue;
    }
    if (sides.length !== 2) {
      ambiguousBoundaryCount += sides.length;
      continue;
    }
    seamPairs.push(makeSeamPair(positions, uv0, indices, sides[0], sides[1], positionEpsilon));
  }
  if (unmatchedBoundaryCount || ambiguousBoundaryCount) {
    throw new Error(
      `seams: ${unmatchedBoundaryCount} unmatched and ${ambiguousBoundaryCount} ambiguous boundary sides`,
    );
  }

  const slitAnalysis = classifySlitComponents(seamPairs, positions, positionEpsilon);
  return {
    seamPairs,
    directionalSideCount: seamPairs.length * 2,
    slitComponents: slitAnalysis.components,
    endpointGroupedSlitComponentCount: slitAnalysis.endpointGroupedCount,
    endpointGroupStats: slitAnalysis.endpointGroupStats,
    chartLocalComponentStats: slitAnalysis.chartLocalStats,
    cornerCensus: calculateCornerCensus(
      positions,
      indices,
      segmentation.triangleChartIds,
      positionEpsilon,
    ),
    positionEpsilon,
  };
}

export function countSubTexelCharts(uv0, indices, triangleChartIds, chartCount, fieldSize) {
  validateMeshInputs(undefined, uv0, indices);
  if (triangleChartIds.length !== indices.length / 3) throw new Error('sub-texel: chart id count mismatch');
  if (!Number.isInteger(fieldSize) || fieldSize <= 0) throw new Error('sub-texel: invalid field size');
  const containsCenter = new Uint8Array(chartCount);
  let remaining = chartCount;
  for (let triangleIndex = 0; triangleIndex < triangleChartIds.length && remaining; triangleIndex += 1) {
    const chartId = triangleChartIds[triangleIndex];
    if (containsCenter[chartId]) continue;
    if (triangleContainsTexelCenter(uv0, indices, triangleIndex, fieldSize)) {
      containsCenter[chartId] = 1;
      remaining -= 1;
    }
  }
  const chartIds = [];
  for (let chartId = 0; chartId < chartCount; chartId += 1) {
    if (!containsCenter[chartId]) chartIds.push(chartId);
  }
  return chartIds;
}

function groupBoundarySides(positions, boundarySides, epsilon) {
  const groups = new Map();
  for (const side of boundarySides) {
    const endpoint0 = positionKey(positions, side.vertex0, epsilon);
    const endpoint1 = positionKey(positions, side.vertex1, epsilon);
    const key = endpoint0 < endpoint1 ? `${endpoint0}|${endpoint1}` : `${endpoint1}|${endpoint0}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = []);
    group.push(side);
  }
  return groups;
}

function makeSeamPair(positions, uv0, indices, side0, sourceSide1, epsilon) {
  const directDistance = pairedEndpointDistance(positions, side0, sourceSide1, false);
  const reversedDistance = pairedEndpointDistance(positions, side0, sourceSide1, true);
  const reverseSide1 = reversedDistance < directDistance;
  const coincidenceError = Math.min(directDistance, reversedDistance);
  if (coincidenceError > epsilon) {
    throw new Error(`seams: paired edges differ by ${coincidenceError}, above epsilon ${epsilon}`);
  }
  const side1 = reverseSide1
    ? { ...sourceSide1, vertex0: sourceSide1.vertex1, vertex1: sourceSide1.vertex0 }
    : { ...sourceSide1 };
  const pair = {
    sides: [
      { ...side0, uvAltitude: triangleUvAltitude(uv0, indices, side0) },
      { ...side1, uvAltitude: triangleUvAltitude(uv0, indices, side1) },
    ],
    foldAngleRadians: foldAngle(positions, indices, side0.triangleIndex, side1.triangleIndex),
    coincidenceError,
    slitComponentId: NO_COMPONENT,
  };
  pair.isSlit = pair.sides[0].chartId === pair.sides[1].chartId;
  return pair;
}

function createChartStats(chartCount) {
  return Array.from({ length: chartCount }, (_, id) => ({
    id,
    triangleCount: 0,
    uvBounds: [Infinity, Infinity, -Infinity, -Infinity],
    uvArea: 0,
  }));
}

function accumulateChartTriangle(chart, triangleIndex, uv0, indices) {
  const vertices = [indices[triangleIndex * 3], indices[triangleIndex * 3 + 1], indices[triangleIndex * 3 + 2]];
  const points = vertices.map((vertexIndex) => [uv0[vertexIndex * 2], uv0[vertexIndex * 2 + 1]]);
  chart.triangleCount += 1;
  for (const [u, v] of points) {
    chart.uvBounds[0] = Math.min(chart.uvBounds[0], u);
    chart.uvBounds[1] = Math.min(chart.uvBounds[1], v);
    chart.uvBounds[2] = Math.max(chart.uvBounds[2], u);
    chart.uvBounds[3] = Math.max(chart.uvBounds[3], v);
  }
  chart.uvArea += Math.abs(cross2(points[0], points[1], points[2])) * 0.5;
}

function triangleContainsTexelCenter(uv0, indices, triangleIndex, fieldSize) {
  const points = [0, 1, 2].map((corner) => {
    const vertexIndex = indices[triangleIndex * 3 + corner];
    return [uv0[vertexIndex * 2] * fieldSize, uv0[vertexIndex * 2 + 1] * fieldSize];
  });
  const denominator = cross2(points[0], points[1], points[2]);
  if (denominator === 0) return false;
  const minX = Math.max(0, Math.floor(Math.min(points[0][0], points[1][0], points[2][0])));
  const maxX = Math.min(fieldSize - 1, Math.ceil(Math.max(points[0][0], points[1][0], points[2][0])));
  const minY = Math.max(0, Math.floor(Math.min(points[0][1], points[1][1], points[2][1])));
  const maxY = Math.min(fieldSize - 1, Math.ceil(Math.max(points[0][1], points[1][1], points[2][1])));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const point = [x + 0.5, y + 0.5];
      const a = cross2(point, points[1], points[2]) / denominator;
      const b = cross2(points[0], point, points[2]) / denominator;
      const c = 1 - a - b;
      if (a >= 0 && b >= 0 && c >= 0) return true;
    }
  }
  return false;
}

function triangleUvAltitude(uv0, indices, side) {
  const triangleVertices = indices.subarray(side.triangleIndex * 3, side.triangleIndex * 3 + 3);
  const opposite = triangleVertices.find((vertexIndex) => vertexIndex !== side.vertex0 && vertexIndex !== side.vertex1);
  if (opposite === undefined) throw new Error(`seams: triangle ${side.triangleIndex} has a degenerate edge`);
  const a = [uv0[side.vertex0 * 2], uv0[side.vertex0 * 2 + 1]];
  const b = [uv0[side.vertex1 * 2], uv0[side.vertex1 * 2 + 1]];
  const c = [uv0[opposite * 2], uv0[opposite * 2 + 1]];
  const edgeLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(edgeLength > 0)) throw new Error(`seams: triangle ${side.triangleIndex} has a zero-length UV edge`);
  return Math.abs(cross2(a, b, c)) / edgeLength;
}

function foldAngle(positions, indices, triangle0, triangle1) {
  const normal0 = triangleNormal(positions, indices, triangle0);
  const normal1 = triangleNormal(positions, indices, triangle1);
  const dot = Math.abs(normal0[0] * normal1[0] + normal0[1] * normal1[1] + normal0[2] * normal1[2]);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

function triangleNormal(positions, indices, triangleIndex) {
  const a = indices[triangleIndex * 3];
  const b = indices[triangleIndex * 3 + 1];
  const c = indices[triangleIndex * 3 + 2];
  const ab = vectorBetween(positions, a, b);
  const ac = vectorBetween(positions, a, c);
  const normal = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const length = Math.hypot(...normal);
  if (!(length > 0)) throw new Error(`seams: triangle ${triangleIndex} has zero world-space area`);
  return normal.map((value) => value / length);
}

function pairedEndpointDistance(positions, side0, side1, reverse) {
  const first = reverse ? side1.vertex1 : side1.vertex0;
  const second = reverse ? side1.vertex0 : side1.vertex1;
  return Math.max(
    endpointDistance(positions, side0.vertex0, first),
    endpointDistance(positions, side0.vertex1, second),
  );
}

function endpointDistance(positions, vertex0, vertex1) {
  return Math.hypot(...vectorBetween(positions, vertex0, vertex1));
}

function vectorBetween(positions, startVertex, endVertex) {
  return [0, 1, 2].map((axis) => positions[endVertex * 3 + axis] - positions[startVertex * 3 + axis]);
}

function positionKey(positions, vertexIndex, epsilon) {
  const offset = vertexIndex * 3;
  return `${Math.round(positions[offset] / epsilon)}_${Math.round(positions[offset + 1] / epsilon)}_${Math.round(positions[offset + 2] / epsilon)}`;
}

function sameUvEdge(firstUse, vertex0, vertex1, uv0) {
  return (
    sameUvVertex(firstUse.vertex0, vertex0, uv0) && sameUvVertex(firstUse.vertex1, vertex1, uv0)
  ) || (
    sameUvVertex(firstUse.vertex0, vertex1, uv0) && sameUvVertex(firstUse.vertex1, vertex0, uv0)
  );
}

function sameUvVertex(vertex0, vertex1, uv0) {
  return uv0[vertex0 * 2] === uv0[vertex1 * 2] && uv0[vertex0 * 2 + 1] === uv0[vertex1 * 2 + 1];
}

function cross2(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function forEachTriangleEdge(indices, visit) {
  for (let triangleIndex = 0; triangleIndex < indices.length / 3; triangleIndex += 1) {
    const offset = triangleIndex * 3;
    visit(triangleIndex, indices[offset], indices[offset + 1]);
    visit(triangleIndex, indices[offset + 1], indices[offset + 2]);
    visit(triangleIndex, indices[offset + 2], indices[offset]);
  }
}

function indexEdgeKey(vertex0, vertex1, vertexCount) {
  const low = Math.min(vertex0, vertex1);
  return low * vertexCount + Math.max(vertex0, vertex1);
}

function validateMeshInputs(positions, uv0, indices) {
  if (!(uv0 instanceof Float32Array) || uv0.length === 0 || uv0.length % 2) {
    throw new Error('mesh: uv0 must be a non-empty Float32Array of pairs');
  }
  if (!(indices instanceof Uint32Array) || indices.length === 0 || indices.length % 3) {
    throw new Error('mesh: indices must be a non-empty Uint32Array of triangles');
  }
  if (positions !== undefined && (!(positions instanceof Float32Array) || positions.length / 3 !== uv0.length / 2)) {
    throw new Error('mesh: positions must match the UV vertex count');
  }
}
