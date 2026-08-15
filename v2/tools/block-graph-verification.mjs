import { dijkstraBlockGraph, interpolateBlockDistances } from './block-graph.mjs';

// An eight-neighbor square lattice has at most 8.24% octile routing distortion. Ten percent
// leaves numerical/metric margin without blessing a four-neighbor Manhattan graph.
export const BLOCK_GRAPH_RELATIVE_DISTANCE_LIMIT = 0.10;
// A seam edge is represented at its midpoint and each endpoint lives at a block anchor. Two
// local block widths are therefore the constructive additive error budget.
export const BLOCK_GRAPH_ADDITIVE_WIDTHS = 2;
// Values on the same global bilinear lattice should agree to floating-point noise when sampled
// on opposite sides of a lattice boundary. This is relative to the field's finite range.
export const BLOCK_GRAPH_CONTINUITY_RELATIVE_LIMIT = 1e-5;

export function verifyBlockGraph(mesh, repack, raster, graph) {
  const continuity = measureInterpolationContinuity(graph);
  const distance = mesh.fixtureName
    ? measureFixtureDistances(mesh, repack, raster, graph)
    : emptyDistanceResult('exact mesh reference is required only on analytic fixtures');
  return { ...distance, ...continuity };
}

function measureFixtureDistances(mesh, repack, raster, graph) {
  const declaredNodes = graph.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => mesh.charts[node.chartId - 1].originalChartId < mesh.fixtureDeclaredChartCount);
  if (!declaredNodes.length) throw new Error(`block graph: ${mesh.fixtureName} has no declared-surface nodes`);
  if (mesh.fixtureName === 'thin-sheet') return measureThinSheetSeparation(mesh, graph, declaredNodes);

  const topology = raster.surfaceTopology;
  const sources = evenlySpaced(declaredNodes, Math.min(4, declaredNodes.length));
  const targets = evenlySpaced(declaredNodes, Math.min(16, declaredNodes.length));
  const rows = [];
  for (const source of sources) {
    const graphDistances = dijkstraBlockGraph(graph, source.index);
    for (const target of targets) {
      if (source.index === target.index) continue;
      const exactDistance = exactFixtureDistance(mesh, topology, source.node, target.node);
      if (!Number.isFinite(exactDistance) || exactDistance <= 1e-9) continue;
      const graphDistance = graphDistances[target.index];
      const blockWidth = Math.max(
        chartBlockWidth(repack, source.node.chartId, graph.blockTexels),
        chartBlockWidth(repack, target.node.chartId, graph.blockTexels),
      );
      const limit = exactDistance * BLOCK_GRAPH_RELATIVE_DISTANCE_LIMIT
        + blockWidth * BLOCK_GRAPH_ADDITIVE_WIDTHS;
      const error = Math.abs(graphDistance - exactDistance);
      rows.push({
        sourceNode: source.index,
        targetNode: target.index,
        exactDistance,
        graphDistance,
        error,
        limit,
        passed: Number.isFinite(graphDistance) && error <= limit,
      });
    }
  }
  if (!rows.length) throw new Error(`block graph: ${mesh.fixtureName} produced no exact distance samples`);
  return {
    distanceSampleCount: rows.length,
    distanceViolationCount: rows.filter(({ passed }) => !passed).length,
    maximumDistanceError: maximum(rows.map(({ error }) => error)),
    maximumDistanceLimitRatio: maximum(rows.map(({ error, limit }) => error / Math.max(limit, 1e-30))),
    disconnectedPairCount: 0,
    rows,
  };
}

function measureThinSheetSeparation(mesh, graph, nodes) {
  let sampleCount = 0; let violations = 0;
  const rows = [];
  for (const source of nodes) {
    const sourceOriginalChart = mesh.charts[source.node.chartId - 1].originalChartId;
    const distances = dijkstraBlockGraph(graph, source.index);
    for (const target of nodes) {
      const targetOriginalChart = mesh.charts[target.node.chartId - 1].originalChartId;
      if (sourceOriginalChart === targetOriginalChart) continue;
      sampleCount += 1;
      const passed = distances[target.index] === Infinity;
      if (!passed) violations += 1;
      rows.push({ sourceNode: source.index, targetNode: target.index, graphDistance: distances[target.index], passed });
    }
  }
  return {
    distanceSampleCount: sampleCount,
    distanceViolationCount: violations,
    maximumDistanceError: violations ? Infinity : 0,
    maximumDistanceLimitRatio: violations ? Infinity : 0,
    disconnectedPairCount: sampleCount,
    rows,
  };
}

function measureInterpolationContinuity(graph) {
  if (!graph.nodeCount) return { continuitySampleCount: 0, continuityViolationCount: 0, maximumContinuityJump: 0 };
  const distances = dijkstraBlockGraph(graph, 0);
  const finite = [...distances].filter(Number.isFinite);
  const scale = Math.max(1e-12, maximum(finite) - Math.min(...finite));
  const epsilon = 1e-4;
  let continuitySampleCount = 0; let continuityViolationCount = 0; let maximumContinuityJump = 0;
  const nodesByChart = new Map();
  graph.nodes.forEach((node) => {
    let nodes = nodesByChart.get(node.chartId);
    if (!nodes) nodesByChart.set(node.chartId, nodes = []);
    nodes.push(node);
  });
  for (const [chartId, nodes] of nodesByChart) {
    for (const node of nodes) {
      for (const axis of [0, 1]) {
        const atlasX = axis === 0 ? (node.blockX + 0.5) * graph.blockTexels : node.atlasCenter[0];
        const atlasY = axis === 1 ? (node.blockY + 0.5) * graph.blockTexels : node.atlasCenter[1];
        const left = interpolateBlockDistances(
          graph,
          distances,
          chartId,
          atlasX - (axis === 0 ? epsilon : 0),
          atlasY - (axis === 1 ? epsilon : 0),
        );
        const right = interpolateBlockDistances(
          graph,
          distances,
          chartId,
          atlasX + (axis === 0 ? epsilon : 0),
          atlasY + (axis === 1 ? epsilon : 0),
        );
        if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
        const jump = Math.abs(left - right);
        continuitySampleCount += 1;
        maximumContinuityJump = Math.max(maximumContinuityJump, jump);
        if (jump > scale * BLOCK_GRAPH_CONTINUITY_RELATIVE_LIMIT + 1e-10) continuityViolationCount += 1;
      }
    }
  }
  return { continuitySampleCount, continuityViolationCount, maximumContinuityJump };
}

function exactFixtureDistance(mesh, topology, source, target) {
  const sourceChart = mesh.charts[source.chartId - 1].originalChartId;
  const targetChart = mesh.charts[target.chartId - 1].originalChartId;
  const sourcePoint = source.worldCenter; const targetPoint = target.worldCenter;
  switch (mesh.fixtureName) {
    case 'seam-quad':
      return Math.hypot(sourcePoint[0] - targetPoint[0], sourcePoint[1] - targetPoint[1]);
    case 'folded-quad-45':
    case 'folded-quad-80':
      return distance2(foldedCoordinate(sourcePoint, sourceChart), foldedCoordinate(targetPoint, targetChart));
    case 'cylinder':
      return cylinderDistance(source, target);
    case 'three-chart-corner':
      return coneDistance(cornerCoordinate(sourcePoint, sourceChart), cornerCoordinate(targetPoint, targetChart));
    case 'two-chart-sphere':
      return exactPolyhedralDistance(mesh, topology, source, target);
    default:
      throw new Error(`block graph: no exact fixture metric for ${mesh.fixtureName}`);
  }
}

function foldedCoordinate(point, originalChart) {
  return originalChart === 0 ? [point[0], point[1]] : [point[0], -Math.hypot(point[1], point[2])];
}

function cylinderDistance(source, target) {
  const segmentCount = 16;
  const edgeLength = 2 * Math.sin(Math.PI / segmentCount);
  const circumference = segmentCount * edgeLength;
  const sourceCoordinate = cylinderCoordinate(source, edgeLength, segmentCount);
  const targetCoordinate = cylinderCoordinate(target, edgeLength, segmentCount);
  const along = Math.abs(sourceCoordinate[0] - targetCoordinate[0]);
  const wrapped = Math.min(along, circumference - along);
  return Math.hypot(wrapped, sourceCoordinate[1] - targetCoordinate[1]);
}

function cylinderCoordinate(node, edgeLength, segmentCount) {
  const segment = Math.min(segmentCount - 1, Math.floor(node.representativeTriangle / 2));
  const angle0 = segment / segmentCount * Math.PI * 2;
  const angle1 = (segment + 1) / segmentCount * Math.PI * 2;
  const start = [Math.cos(angle0), Math.sin(angle0)];
  const edge = [Math.cos(angle1) - start[0], Math.sin(angle1) - start[1]];
  const point = [node.worldCenter[0], node.worldCenter[2]];
  const fraction = clamp(dot2(subtract2(point, start), edge) / dot2(edge, edge), 0, 1);
  return [(segment + fraction) * edgeLength, node.worldCenter[1]];
}

function cornerCoordinate(point, originalChart) {
  if (originalChart === 0) return [point[0], point[1]];
  if (originalChart === 1) return [-point[2], point[1]];
  return [-point[2], -point[0]];
}

function coneDistance(source, target) {
  let result = Infinity;
  for (const turns of [-1, 0, 1]) {
    const rotated = rotate2(target, turns * Math.PI * 1.5);
    result = Math.min(result, distance2(source, rotated));
  }
  return result;
}

function exactPolyhedralDistance(mesh, topology, source, target) {
  if (source.representativeTriangle === target.representativeTriangle) {
    return distance3(source.worldCenter, target.worldCenter);
  }
  let best = Infinity;
  const path = [source.representativeTriangle];
  const visited = new Uint8Array(mesh.triangleChartIds.length);
  visited[source.representativeTriangle] = 1;
  const search = (triangle) => {
    if (triangle === target.representativeTriangle) {
      best = Math.min(best, unfoldedPathDistance(mesh, topology, path, source.worldCenter, target.worldCenter));
      return;
    }
    for (let corner = 0; corner < 3; corner += 1) {
      const neighbor = topology.neighborTriangles[triangle * 3 + corner];
      if (neighbor < 0 || visited[neighbor]) continue;
      visited[neighbor] = 1; path.push(neighbor); search(neighbor); path.pop(); visited[neighbor] = 0;
    }
  };
  search(source.representativeTriangle);
  if (!Number.isFinite(best)) throw new Error('block graph: exact polyhedral unfolding found no valid path');
  return best;
}

function unfoldedPathDistance(mesh, topology, path, sourceWorld, targetWorld) {
  const layouts = [initialTriangleLayout(mesh, path[0])];
  for (let index = 1; index < path.length; index += 1) {
    layouts.push(unfoldNextTriangle(mesh, topology, path[index - 1], path[index], layouts[index - 1]));
  }
  const source = barycentricPoint2(layouts[0], worldBarycentric(mesh, path[0], sourceWorld));
  const target = barycentricPoint2(layouts.at(-1), worldBarycentric(mesh, path.at(-1), targetWorld));
  if (!segmentTraversesLayouts(source, target, layouts, mesh, topology, path)) return Infinity;
  return distance2(source, target);
}

function initialTriangleLayout(mesh, triangle) {
  const points = trianglePoints(mesh, triangle);
  const length01 = distance3(points[0], points[1]);
  const x2 = (distance3(points[0], points[2]) ** 2 + length01 ** 2 - distance3(points[1], points[2]) ** 2) / (2 * length01);
  const y2 = Math.sqrt(Math.max(0, distance3(points[0], points[2]) ** 2 - x2 ** 2));
  return [[0, 0], [length01, 0], [x2, y2]];
}

function unfoldNextTriangle(mesh, topology, priorTriangle, nextTriangle, priorLayout) {
  let priorCorner = -1;
  for (let corner = 0; corner < 3; corner += 1) {
    if (topology.neighborTriangles[priorTriangle * 3 + corner] === nextTriangle) priorCorner = corner;
  }
  if (priorCorner < 0) throw new Error('block graph: unfolding path contains nonadjacent triangles');
  const nextCorner = topology.neighborCorners[priorTriangle * 3 + priorCorner];
  const priorPhysical = [priorCorner, (priorCorner + 1) % 3].map((corner) => (
    topology.physicalVertexIds[mesh.indices[priorTriangle * 3 + corner]]
  ));
  const nextEdgeCorners = [nextCorner, (nextCorner + 1) % 3];
  const nextPhysical = nextEdgeCorners.map((corner) => topology.physicalVertexIds[mesh.indices[nextTriangle * 3 + corner]]);
  const layout = Array(3);
  for (let endpoint = 0; endpoint < 2; endpoint += 1) {
    const matching = nextPhysical.indexOf(priorPhysical[endpoint]);
    layout[nextEdgeCorners[matching]] = priorLayout[(priorCorner + endpoint) % 3];
  }
  const thirdCorner = [0, 1, 2].find((corner) => !nextEdgeCorners.includes(corner));
  const firstCorner = nextEdgeCorners[0]; const secondCorner = nextEdgeCorners[1];
  const first = layout[firstCorner]; const second = layout[secondCorner];
  const thirdWorld = trianglePoints(mesh, nextTriangle)[thirdCorner];
  const nextPoints = trianglePoints(mesh, nextTriangle);
  const candidates = circleIntersections(
    first,
    second,
    distance3(nextPoints[firstCorner], thirdWorld),
    distance3(nextPoints[secondCorner], thirdWorld),
  );
  const priorThird = priorLayout[(priorCorner + 2) % 3];
  const priorSide = cross2(subtract2(second, first), subtract2(priorThird, first));
  layout[thirdCorner] = candidates.find((candidate) => (
    cross2(subtract2(second, first), subtract2(candidate, first)) * priorSide <= 0
  )) ?? candidates[0];
  return layout;
}

function segmentTraversesLayouts(source, target, layouts, mesh, topology, path) {
  const crossings = [0];
  for (let index = 0; index + 1 < path.length; index += 1) {
    const triangle = path[index]; const next = path[index + 1];
    let corner = -1;
    for (let candidate = 0; candidate < 3; candidate += 1) {
      if (topology.neighborTriangles[triangle * 3 + candidate] === next) corner = candidate;
    }
    const intersection = segmentIntersectionParameter(
      source,
      target,
      layouts[index][corner],
      layouts[index][(corner + 1) % 3],
    );
    if (!intersection || intersection.ray < crossings.at(-1) - 1e-8) return false;
    crossings.push(intersection.ray);
  }
  crossings.push(1);
  for (let index = 0; index < layouts.length; index += 1) {
    const midpoint = lerp2(source, target, (crossings[index] + crossings[index + 1]) * 0.5);
    if (!insideTriangle2(midpoint, layouts[index])) return false;
  }
  void mesh;
  return true;
}

function segmentIntersectionParameter(ray0, ray1, edge0, edge1) {
  const ray = subtract2(ray1, ray0); const edge = subtract2(edge1, edge0);
  const denominator = cross2(ray, edge);
  if (Math.abs(denominator) < 1e-12) return null;
  const offset = subtract2(edge0, ray0);
  const rayFraction = cross2(offset, edge) / denominator;
  const edgeFraction = cross2(offset, ray) / denominator;
  if (rayFraction < -1e-8 || rayFraction > 1 + 1e-8 || edgeFraction < -1e-8 || edgeFraction > 1 + 1e-8) return null;
  return { ray: clamp(rayFraction, 0, 1), edge: clamp(edgeFraction, 0, 1) };
}

function insideTriangle2(point, triangle) {
  const signs = [0, 1, 2].map((corner) => cross2(
    subtract2(triangle[(corner + 1) % 3], triangle[corner]),
    subtract2(point, triangle[corner]),
  ));
  return signs.every((value) => value >= -1e-7) || signs.every((value) => value <= 1e-7);
}

function circleIntersections(first, second, firstRadius, secondRadius) {
  const edge = subtract2(second, first); const length = Math.hypot(...edge);
  const along = (firstRadius ** 2 - secondRadius ** 2 + length ** 2) / (2 * length);
  const transverse = Math.sqrt(Math.max(0, firstRadius ** 2 - along ** 2));
  const axis = edge.map((value) => value / length); const normal = [-axis[1], axis[0]];
  const center = [first[0] + axis[0] * along, first[1] + axis[1] * along];
  return [
    [center[0] + normal[0] * transverse, center[1] + normal[1] * transverse],
    [center[0] - normal[0] * transverse, center[1] - normal[1] * transverse],
  ];
}

function worldBarycentric(mesh, triangle, point) {
  const [a, b, c] = trianglePoints(mesh, triangle);
  const ab = subtract3(b, a); const ac = subtract3(c, a); const offset = subtract3(point, a);
  const d00 = dot3(ab, ab); const d01 = dot3(ab, ac); const d11 = dot3(ac, ac);
  const d20 = dot3(offset, ab); const d21 = dot3(offset, ac);
  const inverse = 1 / (d00 * d11 - d01 ** 2);
  const second = (d11 * d20 - d01 * d21) * inverse;
  const third = (d00 * d21 - d01 * d20) * inverse;
  return [1 - second - third, second, third];
}

function trianglePoints(mesh, triangle) {
  return [...mesh.indices.subarray(triangle * 3, triangle * 3 + 3)].map((vertex) => (
    Array.from(mesh.positions.subarray(vertex * 3, vertex * 3 + 3))
  ));
}

function barycentricPoint2(layout, barycentric) {
  return [0, 1].map((axis) => barycentric.reduce((sum, weight, corner) => sum + weight * layout[corner][axis], 0));
}

function chartBlockWidth(repack, chartId, blockTexels) {
  return Math.sqrt(repack.chartTable[chartId - 1].worldAreaPerTexel) * blockTexels;
}

function emptyDistanceResult(skippedReason) {
  return {
    distanceSampleCount: 0,
    distanceViolationCount: 0,
    maximumDistanceError: 0,
    maximumDistanceLimitRatio: 0,
    disconnectedPairCount: 0,
    rows: [],
    skippedReason,
  };
}

function evenlySpaced(rows, count) {
  return Array.from({ length: count }, (_, index) => rows[Math.floor((index + 0.5) / count * rows.length)]);
}
function maximum(values) { return values.length ? Math.max(...values) : 0; }
function rotate2(point, angle) { const cosine = Math.cos(angle); const sine = Math.sin(angle); return [point[0] * cosine - point[1] * sine, point[0] * sine + point[1] * cosine]; }
function lerp2(a, b, fraction) { return [a[0] * (1 - fraction) + b[0] * fraction, a[1] * (1 - fraction) + b[1] * fraction]; }
function subtract2(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function subtract3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot2(a, b) { return a[0] * b[0] + a[1] * b[1]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross2(a, b) { return a[0] * b[1] - a[1] * b[0]; }
function distance2(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function distance3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
