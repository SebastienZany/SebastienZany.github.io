import { DisjointSets } from './union-find.mjs';

export function classifySlitComponents(seamPairs, positions, epsilon) {
  const slitPairIndices = [];
  for (let pairIndex = 0; pairIndex < seamPairs.length; pairIndex += 1) {
    if (seamPairs[pairIndex].isSlit) slitPairIndices.push(pairIndex);
  }

  const localGroups = connectedPairGroups(seamPairs, slitPairIndices, positions, epsilon, true);
  const globalGroups = connectedPairGroups(seamPairs, slitPairIndices, positions, epsilon, false);
  const components = localGroups.map((pairIndices, id) => {
    for (const pairIndex of pairIndices) seamPairs[pairIndex].slitComponentId = id;
    return describeGroup(id, pairIndices, seamPairs, positions, epsilon);
  });
  const globalDescriptions = globalGroups.map((pairIndices, id) => (
    describeGroup(id, pairIndices, seamPairs, positions, epsilon)
  ));

  return {
    components,
    endpointGroupedCount: globalGroups.length,
    chartLocalStats: summarizeGroups(components),
    endpointGroupStats: {
      ...summarizeGroups(globalDescriptions),
      multiChartGroupCount: globalDescriptions.filter((group) => group.chartIds.length > 1).length,
    },
  };
}

export function calculateCornerCensus(positions, indices, triangleChartIds, epsilon) {
  const chartsByPosition = new Map();
  for (let triangleIndex = 0; triangleIndex < triangleChartIds.length; triangleIndex += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const key = positionKey(positions, indices[triangleIndex * 3 + corner], epsilon);
      let charts = chartsByPosition.get(key);
      if (!charts) chartsByPosition.set(key, charts = new Set());
      charts.add(triangleChartIds[triangleIndex]);
    }
  }
  const byChartCount = {};
  const angleSums = new Map();
  for (const [key, charts] of chartsByPosition) {
    byChartCount[charts.size] = (byChartCount[charts.size] ?? 0) + 1;
    if (charts.size >= 3) angleSums.set(key, 0);
  }
  for (let triangleIndex = 0; triangleIndex < triangleChartIds.length; triangleIndex += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertexIndex = indices[triangleIndex * 3 + corner];
      const key = positionKey(positions, vertexIndex, epsilon);
      if (angleSums.has(key)) {
        angleSums.set(key, angleSums.get(key) + cornerAngle(positions, indices, triangleIndex, corner));
      }
    }
  }
  const angleDefects = { positive: 0, negative: 0, flat: 0 };
  for (const angleSum of angleSums.values()) {
    const defect = 2 * Math.PI - angleSum;
    if (defect > 0.05) angleDefects.positive += 1;
    else if (defect < -0.05) angleDefects.negative += 1;
    else angleDefects.flat += 1;
  }
  return { byChartCount, angleDefects };
}

function connectedPairGroups(seamPairs, pairIndices, positions, epsilon, chartLocal) {
  const sets = new DisjointSets(pairIndices.length);
  const endpointOwners = new Map();
  for (let slitIndex = 0; slitIndex < pairIndices.length; slitIndex += 1) {
    const pair = seamPairs[pairIndices[slitIndex]];
    const chartPrefix = chartLocal ? `${pair.sides[0].chartId}:` : '';
    for (const vertexIndex of [pair.sides[0].vertex0, pair.sides[0].vertex1]) {
      const key = chartPrefix + positionKey(positions, vertexIndex, epsilon);
      if (endpointOwners.has(key)) sets.union(slitIndex, endpointOwners.get(key));
      else endpointOwners.set(key, slitIndex);
    }
  }
  const rootToGroup = new Map();
  const groups = [];
  for (let slitIndex = 0; slitIndex < pairIndices.length; slitIndex += 1) {
    const root = sets.find(slitIndex);
    if (!rootToGroup.has(root)) {
      rootToGroup.set(root, rootToGroup.size);
      groups.push([]);
    }
    groups[rootToGroup.get(root)].push(pairIndices[slitIndex]);
  }
  return groups;
}

function describeGroup(id, pairIndices, seamPairs, positions, epsilon) {
  const endpointDegrees = new Map();
  const chartIds = new Set();
  for (const pairIndex of pairIndices) {
    const side = seamPairs[pairIndex].sides[0];
    chartIds.add(side.chartId);
    for (const vertexIndex of [side.vertex0, side.vertex1]) {
      const key = positionKey(positions, vertexIndex, epsilon);
      endpointDegrees.set(key, (endpointDegrees.get(key) ?? 0) + 1);
    }
  }
  const degrees = [...endpointDegrees.values()];
  return {
    id,
    chartId: chartIds.size === 1 ? [...chartIds][0] : undefined,
    chartIds: [...chartIds].sort((left, right) => left - right),
    edgeCount: pairIndices.length,
    maxBranchDegree: Math.max(...degrees),
    branchVertexCount: degrees.filter((degree) => degree > 2).length,
    closedLoop: degrees.every((degree) => degree === 2),
  };
}

function summarizeGroups(groups) {
  return {
    componentCount: groups.length,
    branchingComponentCount: groups.filter((group) => group.maxBranchDegree > 2).length,
    branchVertexCount: groups.reduce((sum, group) => sum + group.branchVertexCount, 0),
    closedLoopCount: groups.filter((group) => group.closedLoop).length,
  };
}

function cornerAngle(positions, indices, triangleIndex, corner) {
  const vertex = indices[triangleIndex * 3 + corner];
  const vector0 = vectorBetween(positions, vertex, indices[triangleIndex * 3 + ((corner + 1) % 3)]);
  const vector1 = vectorBetween(positions, vertex, indices[triangleIndex * 3 + ((corner + 2) % 3)]);
  const denominator = Math.hypot(...vector0) * Math.hypot(...vector1);
  if (!(denominator > 0)) throw new Error(`corners: triangle ${triangleIndex} is degenerate`);
  const dot = vector0[0] * vector1[0] + vector0[1] * vector1[1] + vector0[2] * vector1[2];
  return Math.acos(Math.max(-1, Math.min(1, dot / denominator)));
}

function vectorBetween(positions, startVertex, endVertex) {
  return [0, 1, 2].map((axis) => positions[endVertex * 3 + axis] - positions[startVertex * 3 + axis]);
}

function positionKey(positions, vertexIndex, epsilon) {
  const offset = vertexIndex * 3;
  return `${Math.round(positions[offset] / epsilon)}_${Math.round(positions[offset + 1] / epsilon)}_${Math.round(positions[offset + 2] / epsilon)}`;
}
