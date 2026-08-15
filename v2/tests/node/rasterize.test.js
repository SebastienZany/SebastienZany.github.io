import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBlockGraph, dijkstraBlockGraph } from '../../tools/block-graph.mjs';
import { rasterizeAtlas } from '../../tools/rasterize.mjs';
import { repackAtlasWithTarget } from '../../tools/repack.mjs';

test('closed fixture raster emits resolved walk stencils with authoritative taps', () => {
  const mesh = tetrahedronCharts();
  const repack = repackAtlasWithTarget(mesh, {
    fieldSize: 64,
    gutterTexels: 2,
    directTapClampTexels: 1,
    densityScale: 0.8,
    role: 'fixture',
  });
  const raster = rasterizeAtlas(mesh, repack);
  assert.ok(raster.gutter.recordCount > 0);
  assert.equal(raster.gutter.deadCount, 0);
  for (const tapIndex of raster.gutter.tapIndices) {
    assert.ok(raster.authoritativeOwner[tapIndex] > 0);
    assert.ok(raster.authoritativeOwner[tapIndex] < 2 ** 16);
  }
  for (const texelIndex of raster.gutter.coords) {
    assert.ok(raster.ownership[texelIndex] >= 2 ** 16);
    assert.ok(raster.worldPos.subarray(texelIndex * 3, texelIndex * 3 + 3).every(Number.isFinite));
  }
  assert.equal(
    raster.gutter.census.exactBilinear + raster.gutter.census.nonnegativeMoment + raster.gutter.census.degraded,
    raster.gutter.recordCount,
  );
  const graph = buildBlockGraph(mesh, repack, raster, 16);
  assert.ok(graph.nodeCount >= 4);
  assert.ok([...dijkstraBlockGraph(graph, 0)].every(Number.isFinite));
});

function tetrahedronCharts() {
  const physical = [[1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]];
  const faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
  const positions = [];
  const normals = [];
  const uv0 = [];
  const indices = [];
  const charts = [];
  const physicalByVertex = [];
  const origins = [[0.05, 0.05], [0.55, 0.05], [0.05, 0.55], [0.55, 0.55]];
  faces.forEach((face, chartIndex) => {
    const base = positions.length / 3;
    face.forEach((physicalVertex) => {
      positions.push(...physical[physicalVertex]);
      physicalByVertex.push(physicalVertex);
    });
    const normal = faceNormal(face.map((vertex) => physical[vertex]));
    normals.push(...normal, ...normal, ...normal);
    const [u, v] = origins[chartIndex];
    uv0.push(u, v, u + 0.35, v, u, v + 0.35);
    indices.push(base, base + 1, base + 2);
    charts.push({
      id: chartIndex + 1,
      originalChartId: chartIndex,
      triangles: [chartIndex],
      triangleCount: 1,
      uvBounds: [u, v, u + 0.35, v + 0.35],
      uvArea: 0.06125,
      worldArea: triangleArea(face.map((vertex) => physical[vertex])),
    });
  });
  const mesh = {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uv0: Float32Array.from(uv0),
    indices: Uint32Array.from(indices),
    triangleChartIds: Uint32Array.of(1, 2, 3, 4),
    charts,
  };
  mesh.seamPairs = pairPhysicalEdges(mesh, physicalByVertex);
  return mesh;
}

function pairPhysicalEdges(mesh, physicalByVertex) {
  const groups = new Map();
  for (let triangleIndex = 0; triangleIndex < mesh.indices.length / 3; triangleIndex += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex0 = mesh.indices[triangleIndex * 3 + corner];
      const vertex1 = mesh.indices[triangleIndex * 3 + ((corner + 1) % 3)];
      const p0 = physicalByVertex[vertex0]; const p1 = physicalByVertex[vertex1];
      const key = p0 < p1 ? `${p0}:${p1}` : `${p1}:${p0}`;
      let uses = groups.get(key);
      if (!uses) groups.set(key, uses = []);
      uses.push({ triangleIndex, vertex0, vertex1, chartId: triangleIndex + 1, p0, p1 });
    }
  }
  return [...groups.values()].map(([first, second], sourcePairIndex) => {
    const alignedSecond = first.p0 === second.p0
      ? second : { ...second, vertex0: second.vertex1, vertex1: second.vertex0 };
    return {
      sides: [first, alignedSecond],
      foldAngleRadians: 1,
      sourcePairIndex,
      coincidenceError: 0,
      wasSlit: false,
      isExtension: false,
    };
  });
}

function faceNormal([a, b, c]) {
  const ab = b.map((value, axis) => value - a[axis]);
  const ac = c.map((value, axis) => value - a[axis]);
  const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const length = Math.hypot(...normal);
  return normal.map((value) => value / length);
}

function triangleArea(points) {
  const [a, b, c] = points;
  const ab = b.map((value, axis) => value - a[axis]);
  const ac = c.map((value, axis) => value - a[axis]);
  return Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) * 0.5;
}
