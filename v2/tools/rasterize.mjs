import { GUTTER_RECORD_OFFSET } from './atlas-constants.mjs';
import { directionalFrame, triangleJacobian } from './seams.mjs';
import { buildDonorStencil, quantizeNonnegativeWeights } from './stencils.mjs';
import {
  buildSurfaceTopology,
  closestPointOnSegment,
  walkSurfaceOffset,
} from './surface-walk.mjs';

const NO_TRIANGLE = 0xffffffff;
const STENCIL_CLASSES = Object.freeze({ 'exact-bilinear': 0, 'nonnegative-moment': 1, degraded: 2 });

export function rasterizeAtlas(splitMesh, repack) {
  const { fieldSize } = repack;
  const texelCount = fieldSize ** 2;
  const authoritativeOwner = repack.clearance.authoritativeOwner;
  const ownership = authoritativeOwner.slice();
  const triangleMap = new Uint32Array(texelCount).fill(NO_TRIANGLE);
  const worldPos = new Float32Array(texelCount * 3);
  const tangentFrame = new Float32Array(texelCount * 6);
  writeAuthoritativeMaps(splitMesh, repack, triangleMap, worldPos, tangentFrame);

  const boundary = buildBoundaryEdges(splitMesh, repack.uv1);
  const topology = buildSurfaceTopology(splitMesh);
  const gutterCount = repack.masks.reduce((sum, mask) => sum + mask.dilatedCount - mask.authoritativeCount, 0);
  const gutterCoords = new Uint32Array(gutterCount);
  const tapIndices = new Uint32Array(gutterCount * 4);
  const weights = new Float32Array(gutterCount * 4);
  const quantizedWeights = new Uint16Array(gutterCount * 4);
  const stencilClass = new Uint8Array(gutterCount);
  const walkTriangles = new Uint32Array(gutterCount);
  const walkHopCounts = new Uint16Array(gutterCount);
  const walkChartCrossings = new Uint16Array(gutterCount);
  const census = { exactBilinear: 0, nonnegativeMoment: 0, degraded: 0, signedDegraded: 0, maxPositionErrorTexels: 0, degradedTexels: [] };
  let recordIndex = 0;

  for (let chartIndex = 0; chartIndex < repack.masks.length; chartIndex += 1) {
    const mask = repack.masks[chartIndex];
    const placement = repack.placements[chartIndex];
    const nearest = assignNearestBoundary(mask, placement, boundary.byChart[mask.chart.id], fieldSize, repack.target.gutterTexels);
    for (let localY = 0; localY < mask.height; localY += 1) {
      for (let localX = 0; localX < mask.width; localX += 1) {
        const localIndex = localY * mask.width + localX;
        if (!mask.dilated[localIndex] || mask.authoritative[localIndex]) continue;
        const descriptor = boundary.edges[nearest.edgeIds[localIndex]];
        if (!descriptor) throw new Error(`raster: chart ${mask.chart.id} has an unresolved gutter texel`);
        const x = placement.x + localX; const y = placement.y + localY;
        const texelIndex = y * fieldSize + x;
        const edgeFraction = nearest.edgeFractions[localIndex];
        const boundaryUvPos = lerp2(descriptor.sourceUv0, descriptor.sourceUv1, edgeFraction);
        const gutterUvPos = [(x + 0.5) / fieldSize, (y + 0.5) / fieldSize];
        const endpoint = walkSurfaceOffset({
          mesh: splitMesh,
          uv1: repack.uv1,
          topology,
          sourceSide: descriptor.source,
          destinationSide: descriptor.destination,
          boundaryUvPos,
          edgeFraction,
          offsetUv: subtract2(gutterUvPos, boundaryUvPos),
        });
        const destinationChart = splitMesh.triangleChartIds[endpoint.triangleIndex];
        let stencil;
        try {
          stencil = buildDonorStencil(endpoint.uvPos, destinationChart, authoritativeOwner, fieldSize);
        } catch (error) {
          throw new Error(
            `raster: donor failed at ${x},${y}; edge=${descriptor.id}; pair=${descriptor.pairIndex}; `
            + `sourceChart=${mask.chart.id}; destinationChart=${destinationChart}; `
            + `triangle=${endpoint.triangleIndex}; endpointUv=${endpoint.uvPos.join(',')}; `
            + `hops=${endpoint.triangleHopCount}`,
            { cause: error },
          );
        }
        gutterCoords[recordIndex] = texelIndex;
        tapIndices.set(stencil.tapIndices, recordIndex * 4);
        weights.set(stencil.weights, recordIndex * 4);
        stencilClass[recordIndex] = STENCIL_CLASSES[stencil.stencilClass];
        walkTriangles[recordIndex] = endpoint.triangleIndex;
        walkHopCounts[recordIndex] = Math.min(0xffff, endpoint.triangleHopCount);
        walkChartCrossings[recordIndex] = Math.min(0xffff, endpoint.chartCrossingCount);
        ownership[texelIndex] = recordIndex + GUTTER_RECORD_OFFSET;
        census.maxPositionErrorTexels = Math.max(census.maxPositionErrorTexels, stencil.positionErrorTexels);
        census[stencil.stencilClass === 'exact-bilinear' ? 'exactBilinear' : stencil.stencilClass === 'nonnegative-moment' ? 'nonnegativeMoment' : 'degraded'] += 1;
        if (stencil.stencilClass === 'degraded') census.degradedTexels.push(texelIndex);
        if (stencil.hasNegativeWeight) census.signedDegraded += 1;
        else quantizedWeights.set(quantizeNonnegativeWeights(stencil.weights), recordIndex * 4);
        writeGatheredMap(recordIndex, texelIndex, tapIndices, weights, worldPos, tangentFrame);
        recordIndex += 1;
      }
    }
  }
  if (recordIndex !== gutterCount) throw new Error(`raster: expected ${gutterCount} gutters, wrote ${recordIndex}`);
  return {
    ownership,
    authoritativeOwner,
    triangleMap,
    worldPos,
    tangentFrame,
    gutter: {
      coords: gutterCoords,
      tapIndices,
      weights,
      quantizedWeights: census.signedDegraded ? null : quantizedWeights,
      partialQuantizedWeights: quantizedWeights,
      stencilClass,
      walkTriangles,
      walkHopCounts,
      walkChartCrossings,
      recordCount: gutterCount,
      deadCount: 0,
      deploymentBlocked: census.signedDegraded > 0,
      census,
    },
    boundaryEdges: boundary.edges,
    surfaceTopology: topology,
  };
}

function writeAuthoritativeMaps(mesh, repack, triangleMap, worldPos, tangentFrame) {
  const tangentCache = new Float32Array(mesh.triangleChartIds.length * 6);
  const tangentReady = new Uint8Array(mesh.triangleChartIds.length);
  for (let chartIndex = 0; chartIndex < repack.masks.length; chartIndex += 1) {
    const mask = repack.masks[chartIndex]; const placement = repack.placements[chartIndex];
    for (let localY = 0; localY < mask.height; localY += 1) {
      for (let localX = 0; localX < mask.width; localX += 1) {
        const localIndex = localY * mask.width + localX;
        if (!mask.authoritative[localIndex]) continue;
        const triangleIndex = mask.triangleRefs[localIndex];
        if (triangleIndex < 0) throw new Error('raster: authoritative texel has no triangle');
        const x = placement.x + localX; const y = placement.y + localY;
        const texelIndex = y * repack.fieldSize + x;
        triangleMap[texelIndex] = triangleIndex;
        const barycentric = uvBarycentric(mesh, repack.uv1, triangleIndex, [(x + 0.5) / repack.fieldSize, (y + 0.5) / repack.fieldSize]);
        interpolateTriangle(mesh.positions, mesh.indices, triangleIndex, barycentric, worldPos, texelIndex * 3, 3);
        if (!tangentReady[triangleIndex]) {
          const jacobian = triangleJacobian(mesh, repack.uv1, triangleIndex);
          tangentCache.set([...normalize3(jacobian.dU), ...normalize3(jacobian.dV)], triangleIndex * 6);
          tangentReady[triangleIndex] = 1;
        }
        tangentFrame.set(tangentCache.subarray(triangleIndex * 6, triangleIndex * 6 + 6), texelIndex * 6);
      }
    }
  }
}

function buildBoundaryEdges(mesh, uv1) {
  const edges = [null];
  const byChart = Array.from({ length: mesh.charts.length + 1 }, () => []);
  mesh.seamPairs.forEach((pair, pairIndex) => {
    for (let direction = 0; direction < 2; direction += 1) {
      const source = pair.sides[direction]; const destination = pair.sides[1 - direction];
      const id = edges.length;
      const edge = {
        id,
        frameId: pairIndex * 2 + direction + 1,
        pairIndex,
        direction,
        source,
        destination,
        sourceUv0: vertexUv(uv1, source.vertex0),
        sourceUv1: vertexUv(uv1, source.vertex1),
      };
      edge.entryMatrix = directionalFrame(mesh, uv1, pair, pairIndex, direction, 1).matrix;
      edge.destinationUv = [vertexUv(uv1, destination.vertex0), vertexUv(uv1, destination.vertex1)];
      edge.destinationTriangleUv = [...mesh.indices.subarray(destination.triangleIndex * 3, destination.triangleIndex * 3 + 3)]
        .map((vertex) => ({ vertex, uv: vertexUv(uv1, vertex) }));
      edges.push(edge); byChart[source.chartId].push(edge);
    }
  });
  return { edges, byChart };
}

function assignNearestBoundary(mask, placement, edges, fieldSize, gutterTexels) {
  const edgeIds = new Uint32Array(mask.authoritative.length);
  const edgeFractions = new Float32Array(mask.authoritative.length);
  const distances = new Float32Array(mask.authoritative.length).fill(Infinity);
  const alignments = new Float32Array(mask.authoritative.length).fill(-Infinity);
  for (const edge of edges) {
    const start = edge.sourceUv0.map((value) => value * fieldSize);
    const end = edge.sourceUv1.map((value) => value * fieldSize);
    const radius = gutterTexels + 2;
    const minX = Math.max(placement.x, Math.floor(Math.min(start[0], end[0]) - radius));
    const maxX = Math.min(placement.x + mask.width - 1, Math.ceil(Math.max(start[0], end[0]) + radius));
    const minY = Math.max(placement.y, Math.floor(Math.min(start[1], end[1]) - radius));
    const maxY = Math.min(placement.y + mask.height - 1, Math.ceil(Math.max(start[1], end[1]) + radius));
    for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
      const localIndex = (y - placement.y) * mask.width + x - placement.x;
      if (!mask.dilated[localIndex] || mask.authoritative[localIndex]) continue;
      const closest = closestPointOnSegment([x + 0.5, y + 0.5], start, end);
      const offset = subtract2([x + 0.5, y + 0.5], closest.point);
      const alignment = (closest.t <= 1e-7 || closest.t >= 1 - 1e-7)
        ? entryConeScore(edge, closest.t, offset) : 0;
      const better = closest.distanceSquared < distances[localIndex] - 1e-7
        || (Math.abs(closest.distanceSquared - distances[localIndex]) <= 1e-7 && (
          alignment > alignments[localIndex] + 1e-7
          || (Math.abs(alignment - alignments[localIndex]) <= 1e-7 && edge.id < edgeIds[localIndex])
        ));
      if (better) {
        distances[localIndex] = closest.distanceSquared;
        alignments[localIndex] = alignment;
        edgeIds[localIndex] = edge.id;
        edgeFractions[localIndex] = closest.t;
      }
    }
  }
  return { edgeIds, edgeFractions, distances };
}

function entryConeScore(edge, fraction, sourceOffset) {
  const mapped = [
    edge.entryMatrix.m00 * sourceOffset[0] + edge.entryMatrix.m01 * sourceOffset[1],
    edge.entryMatrix.m10 * sourceOffset[0] + edge.entryMatrix.m11 * sourceOffset[1],
  ];
  const endpointVertex = fraction <= 1e-7 ? edge.destination.vertex0 : edge.destination.vertex1;
  const endpointUv = fraction <= 1e-7 ? edge.destinationUv[0] : edge.destinationUv[1];
  const rays = edge.destinationTriangleUv.filter(({ vertex }) => vertex !== endpointVertex)
    .map(({ uv }) => subtract2(uv, endpointUv));
  if (rays.length !== 2) return -Infinity;
  const determinant = cross2(rays[0], rays[1]);
  if (Math.abs(determinant) < 1e-20) return -Infinity;
  const first = cross2(mapped, rays[1]) / determinant;
  const second = cross2(rays[0], mapped) / determinant;
  return Math.min(first, second) / (Math.abs(first) + Math.abs(second) + 1e-20);
}

function writeGatheredMap(recordIndex, texelIndex, tapIndices, weights, worldPos, tangentFrame) {
  for (let axis = 0; axis < 3; axis += 1) {
    worldPos[texelIndex * 3 + axis] = gatherAxis(recordIndex, axis, 3, tapIndices, weights, worldPos);
  }
  for (let axis = 0; axis < 6; axis += 1) {
    tangentFrame[texelIndex * 6 + axis] = gatherAxis(recordIndex, axis, 6, tapIndices, weights, tangentFrame);
  }
  normalizeInPlace(tangentFrame, texelIndex * 6);
  normalizeInPlace(tangentFrame, texelIndex * 6 + 3);
}

function gatherAxis(recordIndex, axis, stride, tapIndices, weights, values) {
  let result = 0;
  for (let tap = 0; tap < 4; tap += 1) result += weights[recordIndex * 4 + tap] * values[tapIndices[recordIndex * 4 + tap] * stride + axis];
  return result;
}

function uvBarycentric(mesh, uv, triangleIndex, point) {
  const vertices = [...mesh.indices.subarray(triangleIndex * 3, triangleIndex * 3 + 3)];
  const a = vertexUv(uv, vertices[0]); const b = vertexUv(uv, vertices[1]); const c = vertexUv(uv, vertices[2]);
  const denominator = cross2(subtract2(b, a), subtract2(c, a));
  const bWeight = cross2(subtract2(point, a), subtract2(c, a)) / denominator;
  const cWeight = cross2(subtract2(b, a), subtract2(point, a)) / denominator;
  return [1 - bWeight - cWeight, bWeight, cWeight];
}

function interpolateTriangle(values, indices, triangleIndex, barycentric, output, outputOffset, width) {
  for (let axis = 0; axis < width; axis += 1) {
    output[outputOffset + axis] = barycentric.reduce((sum, weight, corner) => (
      sum + weight * values[indices[triangleIndex * 3 + corner] * width + axis]
    ), 0);
  }
}

function vertexUv(uv, vertex) { return [uv[vertex * 2], uv[vertex * 2 + 1]]; }
function lerp2(a, b, t) { return [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t]; }
function subtract2(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function cross2(a, b) { return a[0] * b[1] - a[1] * b[0]; }
function normalize3(value) { const length = Math.hypot(...value); return value.map((axis) => axis / length); }
function normalizeInPlace(values, offset) { const length = Math.hypot(values[offset], values[offset + 1], values[offset + 2]); if (length > 0) for (let axis = 0; axis < 3; axis += 1) values[offset + axis] /= length; }
