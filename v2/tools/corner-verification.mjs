import { fillGutters } from '../src/atlas/fill.js';
import { GUTTER_RECORD_OFFSET } from './atlas-constants.mjs';
import { smoothWorldField } from './seam-verification.mjs';

const POSITION_EPSILON = 1e-5;

export function measureCornerContinuity(mesh, repack, raster) {
  const corners = physicalCorners(mesh, repack.uv1).filter((corner) => corner.charts.size >= 3);
  const source = new Float32Array(raster.authoritativeOwner.length);
  for (let texel = 0; texel < source.length; texel += 1) {
    if (raster.authoritativeOwner[texel]) source[texel] = smoothWorldField(raster.worldPos.subarray(texel * 3, texel * 3 + 3));
  }
  const filled = fillGutters(source, raster.gutter);
  let uncoveredCornerCount = 0; let sampledRecordCount = 0;
  const rows = [];
  for (const corner of corners) {
    const recordIds = cornerRecords(corner, repack, raster);
    if (!recordIds.size) uncoveredCornerCount += 1;
    sampledRecordCount += recordIds.size;
    const samples = [...recordIds].map((record) => cornerSample(record, corner, mesh, repack, raster, filled));
    const byTexel = new Map(samples.map((sample) => [sample.texel, sample]));
    let maxCrossBisectorExcess = 0; let crossBisectorPairCount = 0;
    for (const sample of samples) {
      const x = sample.texel % repack.fieldSize; const y = Math.floor(sample.texel / repack.fieldSize);
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
        const neighbor = byTexel.get((y + dy) * repack.fieldSize + x + dx);
        if (!neighbor || neighbor.edgeId === sample.edgeId) continue;
        const actualDelta = sample.value - neighbor.value;
        const referenceDelta = sample.reference - neighbor.reference;
        maxCrossBisectorExcess = Math.max(maxCrossBisectorExcess, Math.abs(actualDelta - referenceDelta));
        crossBisectorPairCount += 1;
      }
    }
    rows.push({
      worldPos: corner.worldPos,
      chartCount: corner.charts.size,
      defectRadians: 2 * Math.PI - corner.angleSum,
      recordCount: recordIds.size,
      crossBisectorPairCount,
      maxCrossBisectorExcess,
      maxDonorValueError: maximum(samples.map(({ valueError }) => valueError)),
      maxErrorRadiusTexels: maximum(samples.filter(({ valueError }) => valueError > 2e-4).map(({ radiusTexels }) => radiusTexels)),
    });
  }
  rows.sort((left, right) => (
    Math.max(right.maxCrossBisectorExcess, right.maxDonorValueError)
    - Math.max(left.maxCrossBisectorExcess, left.maxDonorValueError)
  ));
  return {
    cornerCount: corners.length,
    uncoveredCornerCount,
    sampledRecordCount,
    maxCrossBisectorExcess: maximum(rows.map(({ maxCrossBisectorExcess }) => maxCrossBisectorExcess)),
    maxDonorValueError: maximum(rows.map(({ maxDonorValueError }) => maxDonorValueError)),
    maxErrorRadiusTexels: maximum(rows.map(({ maxErrorRadiusTexels }) => maxErrorRadiusTexels)),
    worst: rows.slice(0, 20),
  };
}

function physicalCorners(mesh, uv) {
  const groups = new Map();
  for (let triangle = 0; triangle < mesh.triangleChartIds.length; triangle += 1) {
    const vertices = [...mesh.indices.subarray(triangle * 3, triangle * 3 + 3)];
    vertices.forEach((vertex, cornerIndex) => {
      const key = positionKey(mesh.positions, vertex);
      let row = groups.get(key);
      if (!row) groups.set(key, row = { worldPos: vertex3(mesh.positions, vertex), charts: new Map(), angleSum: 0 });
      row.charts.set(mesh.triangleChartIds[triangle], vertex2(uv, vertex));
      row.angleSum += cornerAngle(mesh.positions, vertices, cornerIndex);
    });
  }
  return [...groups.values()];
}

function cornerRecords(corner, repack, raster) {
  const records = new Set(); const radius = repack.target.gutterTexels;
  for (const uv of corner.charts.values()) {
    const center = uv.map((value) => value * repack.fieldSize);
    for (let y = Math.floor(center[1] - radius - 1); y <= Math.ceil(center[1] + radius + 1); y += 1) {
      if (y < 0 || y >= repack.fieldSize) continue;
      for (let x = Math.floor(center[0] - radius - 1); x <= Math.ceil(center[0] + radius + 1); x += 1) {
        if (x < 0 || x >= repack.fieldSize || Math.hypot(x + 0.5 - center[0], y + 0.5 - center[1]) > radius + 0.75) continue;
        const owner = raster.ownership[y * repack.fieldSize + x];
        if (owner >= GUTTER_RECORD_OFFSET) records.add(owner - GUTTER_RECORD_OFFSET);
      }
    }
  }
  return records;
}

function cornerSample(record, corner, mesh, repack, raster, filled) {
  const texel = raster.gutter.coords[record];
  const triangle = raster.gutter.walkTriangles[record];
  const uv = raster.gutter.walkEndpointUv.subarray(record * 2, record * 2 + 2);
  const referenceWorld = triangleWorldAtUv(mesh, repack.uv1, triangle, uv);
  const reference = smoothWorldField(referenceWorld); const value = filled[texel];
  const x = texel % repack.fieldSize; const y = Math.floor(texel / repack.fieldSize);
  const radiusTexels = Math.min(...[...corner.charts.values()].map((cornerUv) => Math.hypot(
    x + 0.5 - cornerUv[0] * repack.fieldSize,
    y + 0.5 - cornerUv[1] * repack.fieldSize,
  )));
  return {
    texel,
    edgeId: raster.gutter.walkBoundaryEdgeIds[record],
    value,
    reference,
    valueError: Math.abs(value - reference),
    radiusTexels,
  };
}

function triangleWorldAtUv(mesh, uv, triangle, point) {
  const vertices = [...mesh.indices.subarray(triangle * 3, triangle * 3 + 3)];
  const a = vertex2(uv, vertices[0]); const b = vertex2(uv, vertices[1]); const c = vertex2(uv, vertices[2]);
  const denominator = cross2(subtract2(b, a), subtract2(c, a));
  const bWeight = cross2(subtract2(point, a), subtract2(c, a)) / denominator;
  const cWeight = cross2(subtract2(b, a), subtract2(point, a)) / denominator;
  const weights = [1 - bWeight - cWeight, bWeight, cWeight];
  return [0, 1, 2].map((axis) => weights.reduce((sum, weight, index) => sum + weight * mesh.positions[vertices[index] * 3 + axis], 0));
}

function cornerAngle(positions, vertices, corner) {
  const center = vertex3(positions, vertices[corner]);
  const first = subtract3(vertex3(positions, vertices[(corner + 1) % 3]), center);
  const second = subtract3(vertex3(positions, vertices[(corner + 2) % 3]), center);
  return Math.acos(clamp(dot3(first, second) / (Math.hypot(...first) * Math.hypot(...second)), -1, 1));
}

function maximum(values) { return values.length ? Math.max(...values) : 0; }
function positionKey(positions, vertex) { return [0, 1, 2].map((axis) => Math.round(positions[vertex * 3 + axis] / POSITION_EPSILON)).join(':'); }
function vertex2(values, vertex) { return [values[vertex * 2], values[vertex * 2 + 1]]; }
function vertex3(values, vertex) { return [values[vertex * 3], values[vertex * 3 + 1], values[vertex * 3 + 2]]; }
function subtract2(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function subtract3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross2(a, b) { return a[0] * b[1] - a[1] * b[0]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
