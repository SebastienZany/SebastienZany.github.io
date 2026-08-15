import { triangleJacobian } from './seams.mjs';

const POSITION_EPSILON = 1e-5;
const RAY_EPSILON = 1e-9;

export function buildSurfaceTopology(mesh, { allowBoundary = false } = {}) {
  const physicalVertexIds = new Uint32Array(mesh.positions.length / 3);
  const physicalIdByPosition = new Map();
  for (let vertex = 0; vertex < physicalVertexIds.length; vertex += 1) {
    const key = positionKey(mesh.positions, vertex);
    if (!physicalIdByPosition.has(key)) physicalIdByPosition.set(key, physicalIdByPosition.size);
    physicalVertexIds[vertex] = physicalIdByPosition.get(key);
  }
  const physicalVertexCount = physicalIdByPosition.size;
  const groups = new Map();
  for (let triangleIndex = 0; triangleIndex < mesh.indices.length / 3; triangleIndex += 1) {
    for (let edgeCorner = 0; edgeCorner < 3; edgeCorner += 1) {
      const vertex0 = mesh.indices[triangleIndex * 3 + edgeCorner];
      const vertex1 = mesh.indices[triangleIndex * 3 + ((edgeCorner + 1) % 3)];
      const physical0 = physicalVertexIds[vertex0];
      const physical1 = physicalVertexIds[vertex1];
      const low = Math.min(physical0, physical1);
      const edgeKey = low * physicalVertexCount + Math.max(physical0, physical1);
      let uses = groups.get(edgeKey);
      if (!uses) groups.set(edgeKey, uses = []);
      uses.push({ triangleIndex, edgeCorner, vertex0, vertex1 });
    }
  }
  const neighborTriangles = new Int32Array(mesh.indices.length).fill(-1);
  const neighborCorners = new Uint8Array(mesh.indices.length);
  const edgeIds = new Uint32Array(mesh.indices.length);
  let edgeCount = 0;
  for (const [key, uses] of groups) {
    const edgeId = edgeCount;
    edgeCount += 1;
    if (uses.length !== 2 && !(allowBoundary && uses.length === 1)) {
      throw new Error(`walk: physical edge ${key} has ${uses.length} triangle uses`);
    }
    for (let index = 0; index < uses.length; index += 1) {
      const use = uses[index];
      const other = uses[1 - index] ?? null;
      edgeIds[use.triangleIndex * 3 + use.edgeCorner] = edgeId;
      if (other) {
        neighborTriangles[use.triangleIndex * 3 + use.edgeCorner] = other.triangleIndex;
        neighborCorners[use.triangleIndex * 3 + use.edgeCorner] = other.edgeCorner;
      }
    }
  }
  return { edgeCount, neighborTriangles, neighborCorners, edgeIds, physicalVertexIds, physicalVertexCount };
}

export function closestPointOnSegment(point, start, end) {
  const edge = [end[0] - start[0], end[1] - start[1]];
  const denominator = edge[0] ** 2 + edge[1] ** 2;
  const t = denominator > 0
    ? clamp(((point[0] - start[0]) * edge[0] + (point[1] - start[1]) * edge[1]) / denominator, 0, 1)
    : 0;
  const closest = [start[0] + edge[0] * t, start[1] + edge[1] * t];
  return { point: closest, t, distanceSquared: distanceSquared2(point, closest) };
}

export function walkSurfaceOffset({
  mesh,
  uv1,
  topology,
  sourceSide,
  destinationSide,
  boundaryUvPos,
  edgeFraction,
  offsetUv,
  maxHops = 1_000,
}) {
  const sourceJacobian = triangleJacobian(mesh, uv1, sourceSide.triangleIndex);
  const sourceOffsetWorld = combine3(sourceJacobian.dU, offsetUv[0], sourceJacobian.dV, offsetUv[1]);
  const distanceWorld = Math.hypot(...sourceOffsetWorld);
  const boundaryWorldPos = interpolateEdge(mesh.positions, sourceSide.vertex0, sourceSide.vertex1, edgeFraction);
  if (distanceWorld <= 1e-15) {
    return endpointRecord(mesh, uv1, sourceSide.triangleIndex, boundaryWorldPos, 0, 0);
  }
  const sourceDirection = sourceOffsetWorld.map((value) => value / distanceWorld);
  const destinationDirection = hingeTransport(mesh, sourceSide, destinationSide, sourceDirection);
  const result = walkRay(
    mesh,
    uv1,
    topology,
    destinationSide.triangleIndex,
    boundaryWorldPos,
    destinationDirection,
    distanceWorld,
    maxHops,
  );
  return { ...result, boundaryUvPos, distanceWorld };
}

export function walkRay(mesh, uv1, topology, startTriangle, startWorldPos, startDirection, distanceWorld, maxHops = 1_000) {
  let triangleIndex = startTriangle;
  let worldPos = [...startWorldPos];
  let direction = normalize3(startDirection);
  let remaining = distanceWorld;
  let triangleHopCount = 0;
  let chartCrossingCount = 1;
  let priorTriangle = -1;
  for (; triangleHopCount <= maxHops; triangleHopCount += 1) {
    const immediateEdge = immediateExitEdge(mesh, topology, triangleIndex, worldPos, direction, priorTriangle);
    if (immediateEdge) {
      const neighborOffset = triangleIndex * 3 + immediateEdge.edgeCorner;
      const neighborTriangle = topology.neighborTriangles[neighborOffset];
      if (neighborTriangle < 0) throw new Error(`walk: ray left the physical mesh at edge ${immediateEdge.edgeId}`);
      if (mesh.triangleChartIds?.[neighborTriangle] !== mesh.triangleChartIds?.[triangleIndex]) chartCrossingCount += 1;
      direction = hingeTransportAcrossCorners(mesh, triangleIndex, immediateEdge.edgeCorner, neighborTriangle, direction);
      priorTriangle = triangleIndex;
      triangleIndex = neighborTriangle;
      continue;
    }
    const intersection = nextTriangleEdge(mesh, topology, triangleIndex, worldPos, direction);
    if (!intersection || intersection.distance >= remaining - RAY_EPSILON) {
      worldPos = addScaled3(worldPos, direction, remaining);
      return endpointRecord(mesh, uv1, triangleIndex, worldPos, triangleHopCount, chartCrossingCount);
    }
    worldPos = addScaled3(worldPos, direction, intersection.distance);
    remaining -= intersection.distance;
    const neighborOffset = triangleIndex * 3 + intersection.edgeCorner;
    const neighborTriangle = topology.neighborTriangles[neighborOffset];
    if (neighborTriangle < 0) throw new Error(`walk: ray left the physical mesh at edge ${intersection.edgeId}`);
    const priorChart = mesh.triangleChartIds?.[triangleIndex];
    const nextChart = mesh.triangleChartIds?.[neighborTriangle];
    if (priorChart !== undefined && nextChart !== priorChart) chartCrossingCount += 1;
    direction = hingeTransportAcrossCorners(
      mesh,
      triangleIndex,
      intersection.edgeCorner,
      neighborTriangle,
      direction,
    );
    priorTriangle = triangleIndex;
    triangleIndex = neighborTriangle;
  }
  throw new Error(`walk: exceeded ${maxHops} triangle crossings`);
}

function immediateExitEdge(mesh, topology, triangleIndex, worldPos, direction, priorTriangle) {
  const barycentric = worldBarycentric(mesh, triangleIndex, worldPos);
  const probe = worldBarycentric(mesh, triangleIndex, addScaled3(worldPos, direction, 1e-8));
  const candidates = [];
  for (let oppositeCorner = 0; oppositeCorner < 3; oppositeCorner += 1) {
    const derivative = probe[oppositeCorner] - barycentric[oppositeCorner];
    if (barycentric[oppositeCorner] > 1e-6 || derivative >= -1e-10) continue;
    const edgeCorner = (oppositeCorner + 1) % 3;
    const neighbor = topology.neighborTriangles[triangleIndex * 3 + edgeCorner];
    candidates.push({
      edgeCorner,
      edgeId: topology.edgeIds[triangleIndex * 3 + edgeCorner],
      derivative,
      returnsToPrior: neighbor === priorTriangle,
    });
  }
  candidates.sort((left, right) => left.returnsToPrior - right.returnsToPrior || left.derivative - right.derivative || left.edgeId - right.edgeId);
  return candidates[0] ?? null;
}

function nextTriangleEdge(mesh, topology, triangleIndex, worldPos, worldDirection) {
  const vertices = [...mesh.indices.subarray(triangleIndex * 3, triangleIndex * 3 + 3)];
  const origin = vertex3(mesh.positions, vertices[0]);
  const basisX = normalize3(subtract3(vertex3(mesh.positions, vertices[1]), origin));
  const normal = triangleNormal(mesh, triangleIndex);
  const basisY = cross3(normal, basisX);
  const point2 = project2(subtract3(worldPos, origin), basisX, basisY);
  const direction2 = project2(worldDirection, basisX, basisY);
  const points = vertices.map((vertex) => project2(subtract3(vertex3(mesh.positions, vertex), origin), basisX, basisY));
  const candidates = [];
  for (let edgeCorner = 0; edgeCorner < 3; edgeCorner += 1) {
    const start = points[edgeCorner];
    const edge = subtract2(points[(edgeCorner + 1) % 3], start);
    const denominator = cross2(direction2, edge);
    if (Math.abs(denominator) < 1e-14) continue;
    const fromPoint = subtract2(start, point2);
    const distance = cross2(fromPoint, edge) / denominator;
    const edgeFraction = cross2(fromPoint, direction2) / denominator;
    if (distance <= RAY_EPSILON || edgeFraction < -1e-8 || edgeFraction > 1 + 1e-8) continue;
    const edgeId = topology.edgeIds[triangleIndex * 3 + edgeCorner];
    candidates.push({ distance, edgeFraction, edgeCorner, edgeId });
  }
  candidates.sort((left, right) => left.distance - right.distance || left.edgeId - right.edgeId);
  return candidates[0] ?? null;
}

function endpointRecord(mesh, uv1, triangleIndex, worldPos, triangleHopCount, chartCrossingCount) {
  const barycentric = worldBarycentric(mesh, triangleIndex, worldPos);
  const vertices = [...mesh.indices.subarray(triangleIndex * 3, triangleIndex * 3 + 3)];
  const uvPos = [0, 1].map((axis) => barycentric.reduce((sum, weight, corner) => (
    sum + weight * uv1[vertices[corner] * 2 + axis]
  ), 0));
  return { triangleIndex, worldPos, uvPos, barycentric, triangleHopCount, chartCrossingCount };
}

function worldBarycentric(mesh, triangleIndex, worldPos) {
  const vertices = [...mesh.indices.subarray(triangleIndex * 3, triangleIndex * 3 + 3)];
  const a = vertex3(mesh.positions, vertices[0]);
  const v0 = subtract3(vertex3(mesh.positions, vertices[1]), a);
  const v1 = subtract3(vertex3(mesh.positions, vertices[2]), a);
  const v2 = subtract3(worldPos, a);
  const d00 = dot3(v0, v0); const d01 = dot3(v0, v1); const d11 = dot3(v1, v1);
  const d20 = dot3(v2, v0); const d21 = dot3(v2, v1);
  const inverse = 1 / (d00 * d11 - d01 * d01);
  const b = (d11 * d20 - d01 * d21) * inverse;
  const c = (d00 * d21 - d01 * d20) * inverse;
  return [1 - b - c, b, c];
}

function hingeTransport(mesh, sourceSide, destinationSide, vector) {
  const start = vertex3(mesh.positions, sourceSide.vertex0);
  const end = vertex3(mesh.positions, sourceSide.vertex1);
  const axis = normalize3(subtract3(end, start));
  return rotateBetweenTriangles(mesh, sourceSide.triangleIndex, destinationSide.triangleIndex, axis, midpoint3(start, end), vector);
}

function hingeTransportAcrossCorners(mesh, sourceTriangle, sourceEdgeCorner, destinationTriangle, vector) {
  const vertex0 = mesh.indices[sourceTriangle * 3 + sourceEdgeCorner];
  const vertex1 = mesh.indices[sourceTriangle * 3 + ((sourceEdgeCorner + 1) % 3)];
  const start = vertex3(mesh.positions, vertex0); const end = vertex3(mesh.positions, vertex1);
  const axis = normalize3(subtract3(end, start));
  return rotateBetweenTriangles(mesh, sourceTriangle, destinationTriangle, axis, midpoint3(start, end), vector);
}

function rotateBetweenTriangles(mesh, sourceTriangle, destinationTriangle, axis, edgeMidpoint, vector) {
  const sourceOutward = triangleInward(mesh, sourceTriangle, edgeMidpoint, axis).map((value) => -value);
  const destinationInward = triangleInward(mesh, destinationTriangle, edgeMidpoint, axis);
  const angle = Math.atan2(dot3(axis, cross3(sourceOutward, destinationInward)), dot3(sourceOutward, destinationInward));
  return rotate3(vector, axis, angle);
}

function triangleInward(mesh, triangleIndex, edgeMidpoint, edgeAxis) {
  const vertices = [...mesh.indices.subarray(triangleIndex * 3, triangleIndex * 3 + 3)];
  const centroid = [0, 1, 2].map((coordinate) => vertices.reduce((sum, vertex) => (
    sum + mesh.positions[vertex * 3 + coordinate]
  ), 0) / 3);
  const direction = subtract3(centroid, edgeMidpoint);
  const alongEdge = dot3(direction, edgeAxis);
  return normalize3(direction.map((value, coordinate) => value - edgeAxis[coordinate] * alongEdge));
}

function triangleNormal(mesh, triangleIndex) {
  const [a, b, c] = [...mesh.indices.subarray(triangleIndex * 3, triangleIndex * 3 + 3)];
  return normalize3(cross3(
    subtract3(vertex3(mesh.positions, b), vertex3(mesh.positions, a)),
    subtract3(vertex3(mesh.positions, c), vertex3(mesh.positions, a)),
  ));
}

function rotate3(vector, axis, angle) {
  const cosine = Math.cos(angle); const sine = Math.sin(angle);
  const cross = cross3(axis, vector); const along = dot3(axis, vector) * (1 - cosine);
  return vector.map((value, index) => value * cosine + cross[index] * sine + axis[index] * along);
}

function positionKey(positions, vertex) {
  return [0, 1, 2].map((axis) => Math.round(positions[vertex * 3 + axis] / POSITION_EPSILON)).join('_');
}

function interpolateEdge(positions, vertex0, vertex1, fraction) {
  return [0, 1, 2].map((axis) => positions[vertex0 * 3 + axis] * (1 - fraction) + positions[vertex1 * 3 + axis] * fraction);
}

function midpoint3(a, b) { return a.map((value, index) => (value + b[index]) * 0.5); }

function vertex3(values, vertex) { return [...values.subarray(vertex * 3, vertex * 3 + 3)]; }
function project2(vector, basisX, basisY) { return [dot3(vector, basisX), dot3(vector, basisY)]; }
function addScaled3(a, b, scale) { return a.map((value, index) => value + b[index] * scale); }
function subtract3(a, b) { return a.map((value, index) => value - b[index]); }
function subtract2(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function combine3(a, aScale, b, bScale) { return a.map((value, index) => value * aScale + b[index] * bScale); }
function cross2(a, b) { return a[0] * b[1] - a[1] * b[0]; }
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function normalize3(vector) { const length = Math.hypot(...vector); return vector.map((value) => value / length); }
function distanceSquared2(a, b) { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2; }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
