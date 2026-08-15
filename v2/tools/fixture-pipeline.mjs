import { buildChartSegmentation, extractSeamEdges } from './mesh.mjs';

// Fixture input stays pleasant to hand-author. This adapter duplicates vertices at declared
// chart boundaries, caps true open boundaries, then hands the result to the exact M1/M2 path.
export function fixtureBakeMesh(fixture) {
  const expanded = expandDeclaredCharts(fixture);
  capOpenBoundaryLoops(expanded);
  const positions = Float32Array.from(expanded.positions);
  const uv0 = Float32Array.from(expanded.uv);
  const indices = Uint32Array.from(expanded.indices);
  const normals = vertexNormals(positions, indices);
  const segmentation = buildChartSegmentation(uv0, indices);
  const seams = extractSeamEdges(positions, uv0, indices, segmentation);
  const fixtureSeamPairIndices = declaredSeamPairIndices(fixture, positions, seams.seamPairs);
  const fixtureDeclaredChartCount = Math.max(...fixture.triangleChartIds) + 1;
  return {
    positions,
    normals,
    uv0,
    indices,
    triangleChartIds: segmentation.triangleChartIds,
    charts: segmentation.charts,
    seamPairs: seams.seamPairs,
    slitComponents: seams.slitComponents,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
    chartCount: segmentation.charts.length,
    seamPairCount: seams.seamPairs.length,
    directionalSideCount: seams.seamPairs.length * 2,
    slitComponentCount: seams.slitComponents.length,
    fixtureName: fixture.name,
    fixtureSeamPairIndices,
    fixtureDeclaredChartCount,
  };
}

function declaredSeamPairIndices(fixture, expandedPositions, seamPairs) {
  const declaredEdges = new Set();
  for (const seam of fixture.seams) {
    if (seam.edgeA) declaredEdges.add(sourcePhysicalEdgeKey(fixture, seam.edgeA));
    if (seam.edgeB) declaredEdges.add(sourcePhysicalEdgeKey(fixture, seam.edgeB));
    if (seam.closedPolyline) {
      for (let index = 0; index + 1 < seam.closedPolyline.length; index += 1) {
        declaredEdges.add(sourcePhysicalEdgeKey(fixture, seam.closedPolyline.slice(index, index + 2)));
      }
    }
  }
  const pairIndices = [];
  seamPairs.forEach((pair, pairIndex) => {
    const side = pair.sides[0];
    const key = expandedPhysicalEdgeKey(expandedPositions, side.vertex0, side.vertex1);
    if (declaredEdges.has(key)) pairIndices.push(pairIndex);
  });
  return Uint32Array.from(pairIndices);
}

function sourcePhysicalEdgeKey(fixture, [vertex0, vertex1]) {
  return physicalEdgeKey(
    fixture.attributes.positions.slice(vertex0 * 3, vertex0 * 3 + 3),
    fixture.attributes.positions.slice(vertex1 * 3, vertex1 * 3 + 3),
  );
}

function expandedPhysicalEdgeKey(positions, vertex0, vertex1) {
  return physicalEdgeKey(
    Array.from(positions.subarray(vertex0 * 3, vertex0 * 3 + 3)),
    Array.from(positions.subarray(vertex1 * 3, vertex1 * 3 + 3)),
  );
}

function physicalEdgeKey(first, second) {
  const firstKey = first.map((value) => Math.round(value * 1e7) / 1e7).join(',');
  const secondKey = second.map((value) => Math.round(value * 1e7) / 1e7).join(',');
  return firstKey < secondKey ? `${firstKey}|${secondKey}` : `${secondKey}|${firstKey}`;
}

function expandDeclaredCharts(fixture) {
  const sourcePositions = fixture.attributes.positions;
  const sourceUv = fixture.attributes.uv;
  const positions = []; const uv = []; const indices = [];
  const vertexByChartSource = new Map();
  for (let triangle = 0; triangle < fixture.triangleChartIds.length; triangle += 1) {
    const chart = fixture.triangleChartIds[triangle];
    for (let corner = 0; corner < 3; corner += 1) {
      const source = fixture.indices[triangle * 3 + corner];
      const key = `${chart}:${source}`;
      let vertex = vertexByChartSource.get(key);
      if (vertex === undefined) {
        vertex = positions.length / 3;
        vertexByChartSource.set(key, vertex);
        positions.push(...sourcePositions.slice(source * 3, source * 3 + 3));
        uv.push(...sourceUv.slice(source * 2, source * 2 + 2));
      }
      indices.push(vertex);
    }
  }
  return { positions, uv, indices };
}

function capOpenBoundaryLoops(mesh) {
  const usesByPhysicalEdge = new Map();
  for (let triangle = 0; triangle < mesh.indices.length / 3; triangle += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex0 = mesh.indices[triangle * 3 + corner];
      const vertex1 = mesh.indices[triangle * 3 + ((corner + 1) % 3)];
      const key0 = positionKey(mesh.positions, vertex0); const key1 = positionKey(mesh.positions, vertex1);
      const edgeKey = key0 < key1 ? `${key0}|${key1}` : `${key1}|${key0}`;
      let uses = usesByPhysicalEdge.get(edgeKey);
      if (!uses) usesByPhysicalEdge.set(edgeKey, uses = []);
      uses.push({ key0, key1 });
    }
  }
  const openEdges = [...usesByPhysicalEdge.values()].filter((uses) => uses.length === 1).map(([use]) => use);
  if (!openEdges.length) return;
  const adjacency = new Map();
  for (const edge of openEdges) {
    addNeighbor(adjacency, edge.key0, edge.key1);
    addNeighbor(adjacency, edge.key1, edge.key0);
  }
  if ([...adjacency.values()].some((neighbors) => neighbors.length !== 2)) {
    throw new Error('fixture: open boundary is not a collection of simple loops');
  }
  const unused = new Set(openEdges.map(({ key0, key1 }) => edgeKey(key0, key1)));
  while (unused.size) {
    const firstEdge = [...unused].sort()[0];
    const [start, next] = firstEdge.split('|');
    const loop = [start];
    let previous = start; let current = next;
    unused.delete(firstEdge);
    while (current !== start) {
      loop.push(current);
      const candidates = adjacency.get(current).filter((key) => key !== previous);
      const following = candidates[0];
      const key = edgeKey(current, following);
      if (!unused.delete(key)) throw new Error('fixture: boundary loop revisited an edge');
      previous = current; current = following;
    }
    addCap(mesh, loop);
  }
}

function addCap(mesh, positionKeys) {
  const points = positionKeys.map(parsePositionKey);
  const center = [0, 1, 2].map((axis) => points.reduce((sum, point) => sum + point[axis], 0) / points.length);
  const centerVertex = mesh.positions.length / 3;
  mesh.positions.push(...center); mesh.uv.push(0.5, 0.5);
  const ring = points.map((point, index) => {
    const vertex = mesh.positions.length / 3;
    mesh.positions.push(...point);
    const angle = index / points.length * Math.PI * 2;
    mesh.uv.push(0.5 + Math.cos(angle) * 0.4, 0.5 + Math.sin(angle) * 0.4);
    return vertex;
  });
  for (let index = 0; index < ring.length; index += 1) {
    mesh.indices.push(centerVertex, ring[index], ring[(index + 1) % ring.length]);
  }
}

function vertexNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
    const vertices = [...indices.subarray(triangle * 3, triangle * 3 + 3)];
    const a = point3(positions, vertices[0]); const b = point3(positions, vertices[1]); const c = point3(positions, vertices[2]);
    const ab = subtract3(b, a); const ac = subtract3(c, a);
    const normal = cross3(ab, ac);
    for (const vertex of vertices) for (let axis = 0; axis < 3; axis += 1) normals[vertex * 3 + axis] += normal[axis];
  }
  for (let vertex = 0; vertex < normals.length / 3; vertex += 1) {
    const length = Math.hypot(...normals.subarray(vertex * 3, vertex * 3 + 3));
    if (!(length > 0)) throw new Error(`fixture: vertex ${vertex} has no normal`);
    for (let axis = 0; axis < 3; axis += 1) normals[vertex * 3 + axis] /= length;
  }
  return normals;
}

function addNeighbor(adjacency, from, to) {
  let neighbors = adjacency.get(from);
  if (!neighbors) adjacency.set(from, neighbors = []);
  if (!neighbors.includes(to)) neighbors.push(to);
}
function positionKey(positions, vertex) {
  // This is deliberately tighter than M1's 1e-5 pairing epsilon while still coalescing sin(2π)
  // with zero in analytic generators.
  return [0, 1, 2].map((axis) => Math.round(Number(positions[vertex * 3 + axis]) * 1e7) / 1e7).join(',');
}
function parsePositionKey(key) { return key.split(',').map(Number); }
function edgeKey(first, second) { return first < second ? `${first}|${second}` : `${second}|${first}`; }
function point3(values, vertex) { return [...values.subarray(vertex * 3, vertex * 3 + 3)]; }
function subtract3(a, b) { return a.map((value, axis) => value - b[axis]); }
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
