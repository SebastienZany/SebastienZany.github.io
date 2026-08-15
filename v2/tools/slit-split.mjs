import { DisjointSets } from './union-find.mjs';

const POSITION_KEY_EPSILON = 1e-5;

// A chart-local slit has two or three indexed boundary copies. Multi-source graph cuts assign
// the surrounding triangles to the closest copy; every new interface is an ordinary paired
// mesh edge. This is the constructive extension step: it cannot leave a slit unresolved.
export function splitChartLocalSlits(mesh) {
  validateInput(mesh);
  const topology = buildIndexedTopology(mesh.indices, mesh.triangleChartIds, mesh.vertexCount);
  const pairsByComponent = groupPairsByComponent(mesh.seamPairs, mesh.slitComponentCount);
  const cutEdgeKeys = new Set();
  const pathCensus = [];

  for (let componentId = 0; componentId < pairsByComponent.length; componentId += 1) {
    const pairRows = pairsByComponent[componentId];
    const chartIndex = pairRows[0].pair.sides[0].chartId;
    const decomposition = decomposePhysicalPaths(pairRows, mesh.positions);
    pathCensus.push(decomposition);
    for (const pathRows of decomposition.paths) {
      extendComponentCut({
        chartIndex,
        pairRows: pathRows,
        sideGroups: groupIndexedSlitCopies(pathRows),
        chartTriangles: topology.trianglesByChart[chartIndex],
        triangleNeighbors: topology.triangleNeighbors,
        cutEdgeKeys,
      });
    }
  }

  const finalCharts = connectedTriangleCharts(mesh, topology, cutEdgeKeys);
  assertEverySlitSeparated(mesh.seamPairs, finalCharts.triangleChartIndices);
  const geometry = reindexGeometry(mesh, finalCharts);
  const seamPairs = rebuildSeamPairs(mesh, geometry, finalCharts, topology, cutEdgeKeys);
  const charts = describeFinalCharts(mesh, geometry, finalCharts);

  return {
    ...geometry,
    triangleChartIds: Uint32Array.from(finalCharts.triangleChartIndices, (id) => id + 1),
    charts,
    seamPairs,
    extensionEdges: seamPairs.filter((pair) => pair.isExtension),
    cutEdgeKeys,
    fixtureName: mesh.fixtureName,
    fixtureSeamPairIndices: mesh.fixtureSeamPairIndices,
    stats: {
      inputChartCount: mesh.chartCount,
      outputChartCount: charts.length,
      slitPairCount: mesh.seamPairs.filter((pair) => pair.isSlit).length,
      slitComponentCount: pairsByComponent.length,
      simplePathCount: pathCensus.reduce((sum, entry) => sum + entry.pathCount, 0),
      branchVertexCount: pathCensus.reduce((sum, entry) => sum + entry.branchVertexCount, 0),
      closedLoopCount: pathCensus.reduce((sum, entry) => sum + entry.closedLoopCount, 0),
      extensionEdgeCount: cutEdgeKeys.size,
      unresolvedSlitCount: 0,
    },
  };
}

function extendComponentCut(context) {
  const { pairRows, sideGroups, chartTriangles, triangleNeighbors, cutEdgeKeys } = context;
  const regionIds = labelRegions(chartTriangles, triangleNeighbors, cutEdgeKeys);
  const seedsByRegion = new Map();
  pairRows.forEach(({ pair }, pairOffset) => {
    pair.sides.forEach((side, sideIndex) => {
      const regionId = regionIds.get(side.triangleIndex);
      const label = sideGroups[pairOffset * 2 + sideIndex];
      let seeds = seedsByRegion.get(regionId);
      if (!seeds) seedsByRegion.set(regionId, seeds = new Map());
      const prior = seeds.get(side.triangleIndex);
      if (prior !== undefined && prior !== label) {
        throw new Error(`slit split: triangle ${side.triangleIndex} belongs to two slit copies`);
      }
      seeds.set(side.triangleIndex, label);
    });
  });

  for (const [regionId, seeds] of seedsByRegion) {
    if (new Set(seeds.values()).size < 2) continue;
    const labels = nearestSeedLabels(regionId, regionIds, seeds, triangleNeighbors, cutEdgeKeys);
    for (const [triangleIndex, neighbors] of triangleNeighbors) {
      if (regionIds.get(triangleIndex) !== regionId) continue;
      for (const neighbor of neighbors) {
        if (regionIds.get(neighbor.triangleIndex) !== regionId) continue;
        if (labels.get(triangleIndex) !== labels.get(neighbor.triangleIndex)) {
          cutEdgeKeys.add(neighbor.edgeKey);
        }
      }
    }
  }
}

function nearestSeedLabels(regionId, regionIds, seeds, triangleNeighbors, existingCuts) {
  const labels = new Map();
  const distances = new Map();
  const queue = [...seeds].sort((left, right) => left[1] - right[1] || left[0] - right[0]);
  for (const [triangleIndex, label] of queue) {
    labels.set(triangleIndex, label);
    distances.set(triangleIndex, 0);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const [triangleIndex] = queue[head];
    const nextDistance = distances.get(triangleIndex) + 1;
    const label = labels.get(triangleIndex);
    for (const neighbor of triangleNeighbors.get(triangleIndex)) {
      if (existingCuts.has(neighbor.edgeKey) || regionIds.get(neighbor.triangleIndex) !== regionId) continue;
      const oldDistance = distances.get(neighbor.triangleIndex);
      const oldLabel = labels.get(neighbor.triangleIndex);
      if (oldDistance === undefined || nextDistance < oldDistance || (
        nextDistance === oldDistance && label < oldLabel
      )) {
        distances.set(neighbor.triangleIndex, nextDistance);
        labels.set(neighbor.triangleIndex, label);
        queue.push([neighbor.triangleIndex, label]);
      }
    }
  }
  return labels;
}

function labelRegions(chartTriangles, triangleNeighbors, cutEdgeKeys) {
  const regionIds = new Map();
  let nextRegionId = 0;
  for (const firstTriangle of chartTriangles) {
    if (regionIds.has(firstTriangle)) continue;
    const queue = [firstTriangle];
    regionIds.set(firstTriangle, nextRegionId);
    for (let head = 0; head < queue.length; head += 1) {
      for (const neighbor of triangleNeighbors.get(queue[head])) {
        if (cutEdgeKeys.has(neighbor.edgeKey) || regionIds.has(neighbor.triangleIndex)) continue;
        regionIds.set(neighbor.triangleIndex, nextRegionId);
        queue.push(neighbor.triangleIndex);
      }
    }
    nextRegionId += 1;
  }
  return regionIds;
}

function connectedTriangleCharts(mesh, topology, cutEdgeKeys) {
  const triangleChartIndices = new Int32Array(mesh.triangleCount).fill(-1);
  const triangleLists = [];
  for (let originalChart = 0; originalChart < mesh.chartCount; originalChart += 1) {
    for (const firstTriangle of topology.trianglesByChart[originalChart]) {
      if (triangleChartIndices[firstTriangle] >= 0) continue;
      const chartIndex = triangleLists.length;
      const triangles = [firstTriangle];
      triangleChartIndices[firstTriangle] = chartIndex;
      for (let head = 0; head < triangles.length; head += 1) {
        for (const neighbor of topology.triangleNeighbors.get(triangles[head])) {
          if (cutEdgeKeys.has(neighbor.edgeKey) || triangleChartIndices[neighbor.triangleIndex] >= 0) continue;
          triangleChartIndices[neighbor.triangleIndex] = chartIndex;
          triangles.push(neighbor.triangleIndex);
        }
      }
      triangleLists.push({ originalChartId: originalChart, triangles });
    }
  }
  return { triangleChartIndices, triangleLists };
}

function reindexGeometry(mesh, finalCharts) {
  const positions = [];
  const normals = [];
  const uv0 = [];
  const originalVertexIds = [];
  const indices = new Uint32Array(mesh.indices.length);
  const vertexByChartAndOriginal = new Map();
  for (let triangleIndex = 0; triangleIndex < mesh.triangleCount; triangleIndex += 1) {
    const chartIndex = finalCharts.triangleChartIndices[triangleIndex];
    for (let corner = 0; corner < 3; corner += 1) {
      const sourceVertex = mesh.indices[triangleIndex * 3 + corner];
      const key = `${chartIndex}:${sourceVertex}`;
      let bakedVertex = vertexByChartAndOriginal.get(key);
      if (bakedVertex === undefined) {
        bakedVertex = originalVertexIds.length;
        vertexByChartAndOriginal.set(key, bakedVertex);
        originalVertexIds.push(sourceVertex);
        positions.push(...mesh.positions.subarray(sourceVertex * 3, sourceVertex * 3 + 3));
        normals.push(...mesh.normals.subarray(sourceVertex * 3, sourceVertex * 3 + 3));
        uv0.push(...mesh.uv0.subarray(sourceVertex * 2, sourceVertex * 2 + 2));
      }
      indices[triangleIndex * 3 + corner] = bakedVertex;
    }
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uv0: Float32Array.from(uv0),
    indices,
    originalVertexIds: Uint32Array.from(originalVertexIds),
    vertexByChartAndOriginal,
  };
}

function rebuildSeamPairs(mesh, geometry, finalCharts, topology, cutEdgeKeys) {
  const pairs = mesh.seamPairs.map((pair, sourcePairIndex) => ({
    sides: pair.sides.map((side) => remapSide(side, geometry, finalCharts)),
    foldAngleRadians: pair.foldAngleRadians,
    coincidenceError: pair.coincidenceError,
    sourcePairIndex,
    wasSlit: pair.isSlit,
    isExtension: false,
  }));
  const cutKeys = [...cutEdgeKeys].sort((left, right) => left - right);
  for (const edgeKey of cutKeys) {
    const uses = topology.edgeUses.get(edgeKey);
    if (uses?.length !== 2) throw new Error(`slit split: extension edge ${edgeKey} is not paired`);
    const [first, second] = uses;
    const alignedSecond = { ...second, vertex0: first.vertex0, vertex1: first.vertex1 };
    pairs.push({
      sides: [first, alignedSecond].map((use) => remapSide(use, geometry, finalCharts)),
      foldAngleRadians: triangleFold(mesh.positions, mesh.indices, first.triangleIndex, second.triangleIndex),
      coincidenceError: 0,
      sourcePairIndex: -1,
      wasSlit: false,
      isExtension: true,
    });
  }
  return pairs;
}

function remapSide(side, geometry, finalCharts) {
  const chartIndex = finalCharts.triangleChartIndices[side.triangleIndex];
  return {
    triangleIndex: side.triangleIndex,
    vertex0: geometry.vertexByChartAndOriginal.get(`${chartIndex}:${side.vertex0}`),
    vertex1: geometry.vertexByChartAndOriginal.get(`${chartIndex}:${side.vertex1}`),
    chartId: chartIndex + 1,
  };
}

function describeFinalCharts(mesh, geometry, finalCharts) {
  return finalCharts.triangleLists.map(({ originalChartId, triangles }, chartIndex) => {
    const uvBounds = [Infinity, Infinity, -Infinity, -Infinity];
    let worldArea = 0;
    let uvArea = 0;
    for (const triangleIndex of triangles) {
      const vertices = geometry.indices.subarray(triangleIndex * 3, triangleIndex * 3 + 3);
      const points = [...vertices].map((vertex) => [geometry.uv0[vertex * 2], geometry.uv0[vertex * 2 + 1]]);
      for (const [u, v] of points) {
        uvBounds[0] = Math.min(uvBounds[0], u); uvBounds[1] = Math.min(uvBounds[1], v);
        uvBounds[2] = Math.max(uvBounds[2], u); uvBounds[3] = Math.max(uvBounds[3], v);
      }
      uvArea += Math.abs(cross2(points[0], points[1], points[2])) * 0.5;
      worldArea += triangleArea(mesh.positions, mesh.indices, triangleIndex);
    }
    return { id: chartIndex + 1, originalChartId, triangles, triangleCount: triangles.length, uvBounds, uvArea, worldArea };
  });
}

function buildIndexedTopology(indices, triangleChartIds, vertexCount) {
  const edgeUses = new Map();
  const triangleNeighbors = new Map();
  const trianglesByChart = [];
  for (let triangleIndex = 0; triangleIndex < triangleChartIds.length; triangleIndex += 1) {
    const chart = triangleChartIds[triangleIndex];
    if (!trianglesByChart[chart]) trianglesByChart[chart] = [];
    trianglesByChart[chart].push(triangleIndex);
    triangleNeighbors.set(triangleIndex, []);
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex0 = indices[triangleIndex * 3 + corner];
      const vertex1 = indices[triangleIndex * 3 + ((corner + 1) % 3)];
      const edgeKey = indexEdgeKey(vertex0, vertex1, vertexCount);
      let uses = edgeUses.get(edgeKey);
      if (!uses) edgeUses.set(edgeKey, uses = []);
      uses.push({ triangleIndex, vertex0, vertex1, edgeKey, chartId: chart });
    }
  }
  for (const [edgeKey, uses] of edgeUses) {
    if (uses.length === 2) {
      triangleNeighbors.get(uses[0].triangleIndex).push({ triangleIndex: uses[1].triangleIndex, edgeKey });
      triangleNeighbors.get(uses[1].triangleIndex).push({ triangleIndex: uses[0].triangleIndex, edgeKey });
    }
  }
  return { edgeUses, triangleNeighbors, trianglesByChart };
}

function groupPairsByComponent(seamPairs, componentCount) {
  const groups = Array.from({ length: componentCount }, () => []);
  seamPairs.forEach((pair, pairIndex) => {
    if (pair.isSlit) groups[pair.slitComponentId].push({ pair, pairIndex });
  });
  if (groups.some((group) => group.length === 0)) throw new Error('slit split: empty component');
  return groups;
}

function groupIndexedSlitCopies(pairRows) {
  const sets = new DisjointSets(pairRows.length * 2);
  const ownerByVertex = new Map();
  pairRows.forEach(({ pair }, pairOffset) => pair.sides.forEach((side, sideIndex) => {
    const node = pairOffset * 2 + sideIndex;
    for (const vertex of [side.vertex0, side.vertex1]) {
      if (ownerByVertex.has(vertex)) sets.union(node, ownerByVertex.get(vertex));
      else ownerByVertex.set(vertex, node);
    }
  }));
  const roots = [...new Set(pairRows.flatMap((_, index) => [sets.find(index * 2), sets.find(index * 2 + 1)]))]
    .sort((left, right) => left - right);
  const labelByRoot = new Map(roots.map((root, label) => [root, label]));
  return pairRows.flatMap((_, index) => [labelByRoot.get(sets.find(index * 2)), labelByRoot.get(sets.find(index * 2 + 1))]);
}

function decomposePhysicalPaths(pairRows, positions) {
  const endpoints = pairRows.map(({ pair }) => [
    positionKey(positions, pair.sides[0].vertex0),
    positionKey(positions, pair.sides[0].vertex1),
  ]);
  const incident = new Map();
  endpoints.forEach(([key0, key1], rowIndex) => {
    for (const key of [key0, key1]) {
      let rows = incident.get(key);
      if (!rows) incident.set(key, rows = []);
      rows.push(rowIndex);
    }
  });
  const unused = new Set(pairRows.map((_, index) => index));
  const paths = [];
  const starts = [...incident].filter(([, rows]) => rows.length !== 2).sort(([left], [right]) => left.localeCompare(right));
  for (const [startKey, rows] of starts) {
    for (const firstRow of [...rows].sort((left, right) => pairRows[left].pairIndex - pairRows[right].pairIndex)) {
      if (!unused.has(firstRow)) continue;
      const path = [];
      let currentKey = startKey;
      let rowIndex = firstRow;
      while (unused.has(rowIndex)) {
        unused.delete(rowIndex);
        path.push(pairRows[rowIndex]);
        const [key0, key1] = endpoints[rowIndex];
        const nextKey = key0 === currentKey ? key1 : key0;
        if (incident.get(nextKey).length !== 2) break;
        const nextRow = incident.get(nextKey).find((candidate) => unused.has(candidate));
        if (nextRow === undefined) break;
        currentKey = nextKey;
        rowIndex = nextRow;
      }
      paths.push(path);
    }
  }
  const closedLoopCount = unused.size ? 1 : 0;
  if (unused.size) throw new Error('slit split: chart-local closed loop contradicts the M1 gate');
  return {
    paths,
    pathCount: paths.length,
    branchVertexCount: [...incident.values()].filter((rows) => rows.length > 2).length,
    endpointCount: [...incident.values()].filter((rows) => rows.length === 1).length,
    closedLoopCount,
  };
}

function assertEverySlitSeparated(seamPairs, triangleChartIndices) {
  const unresolved = seamPairs.filter((pair) => pair.isSlit && (
    triangleChartIndices[pair.sides[0].triangleIndex] === triangleChartIndices[pair.sides[1].triangleIndex]
  ));
  if (unresolved.length) throw new Error(`slit split: ${unresolved.length} original slit pairs remain in one chart`);
}

function indexEdgeKey(vertex0, vertex1, vertexCount) {
  const low = Math.min(vertex0, vertex1);
  return low * vertexCount + Math.max(vertex0, vertex1);
}

function positionKey(positions, vertex) {
  return `${Math.round(positions[vertex * 3] / POSITION_KEY_EPSILON)}_${Math.round(positions[vertex * 3 + 1] / POSITION_KEY_EPSILON)}_${Math.round(positions[vertex * 3 + 2] / POSITION_KEY_EPSILON)}`;
}

function triangleFold(positions, indices, triangle0, triangle1) {
  const normal0 = triangleNormal(positions, indices, triangle0);
  const normal1 = triangleNormal(positions, indices, triangle1);
  return Math.acos(Math.max(-1, Math.min(1, Math.abs(dot3(normal0, normal1)))));
}

function triangleNormal(positions, indices, triangleIndex) {
  const [a, b, c] = [...indices.subarray(triangleIndex * 3, triangleIndex * 3 + 3)];
  const ab = vector(positions, a, b); const ac = vector(positions, a, c);
  const value = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const length = Math.hypot(...value);
  return value.map((axis) => axis / length);
}

function triangleArea(positions, indices, triangleIndex) {
  const [a, b, c] = [...indices.subarray(triangleIndex * 3, triangleIndex * 3 + 3)];
  const ab = vector(positions, a, b); const ac = vector(positions, a, c);
  return Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) * 0.5;
}

function vector(values, start, end) {
  return [0, 1, 2].map((axis) => values[end * 3 + axis] - values[start * 3 + axis]);
}

function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross2(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }

function validateInput(mesh) {
  if (!mesh?.seamPairs || !mesh?.slitComponents || !mesh?.charts) throw new Error('slit split: MESH1 input required');
}
