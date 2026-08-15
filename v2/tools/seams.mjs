// Directional frame layout (16 f32, record zero reserved):
//   0..3  srcRef.xy, dstRef.xy
//   4..7  M columns (m00,m10), (m01,m11)
//   8..11 srcChart, dstChart, sourcePairIndex, direction
//   12..15 foldRadians, anisotropy, sourceLengthTexels, diagnostic polar angle
// Frames are size-specific uv1 transport data for the runtime agent resolver. Gutter fill never
// consumes this table; its donor endpoint comes from the exact surface walk.
export const FRAME_FLOATS = 16;

export function buildDirectionalFrames(splitMesh, repack) {
  const frameCount = splitMesh.seamPairs.length * 2;
  const frameData = new Float32Array((frameCount + 1) * FRAME_FLOATS);
  const frames = [];
  for (let pairIndex = 0; pairIndex < splitMesh.seamPairs.length; pairIndex += 1) {
    const pair = splitMesh.seamPairs[pairIndex];
    for (let direction = 0; direction < 2; direction += 1) {
      const frameId = pairIndex * 2 + direction + 1;
      const frame = directionalFrame(splitMesh, repack.uv1, pair, pairIndex, direction, repack.fieldSize);
      packFrame(frameData, frameId, frame);
      frames.push({ id: frameId, ...frame });
    }
  }
  return { frameData, frames, frameCount, frameStrideFloats: FRAME_FLOATS };
}

export function directionalFrame(mesh, uv1, pair, pairIndex, direction, fieldSize) {
  const source = pair.sides[direction];
  const destination = pair.sides[1 - direction];
  const sourceJacobian = triangleJacobian(mesh, uv1, source.triangleIndex);
  const destinationJacobian = triangleJacobian(mesh, uv1, destination.triangleIndex);
  const hinge = hingeRotation(mesh, source, destination);
  const unfoldedSourceJacobian = {
    dU: rotateVector(sourceJacobian.dU, hinge.axis, hinge.angleRadians),
    dV: rotateVector(sourceJacobian.dV, hinge.axis, hinge.angleRadians),
  };
  const matrix = projectJacobian(destinationJacobian, unfoldedSourceJacobian);
  const legacyMatrix = projectJacobian(destinationJacobian, sourceJacobian);
  const srcRef = vertexUv(uv1, source.vertex0);
  const dstRef = vertexUv(uv1, destination.vertex0);
  const sourceEdge = subtract2(vertexUv(uv1, source.vertex1), srcRef);
  const mappedEdge = applyMatrix(matrix, sourceEdge);
  const destinationEdge = subtract2(vertexUv(uv1, destination.vertex1), dstRef);
  if (distance2(mappedEdge, destinationEdge) * fieldSize > 0.25 + 1e-4) {
    throw new Error(`seams: frame ${pairIndex}/${direction} misses its shared edge`);
  }
  return {
    srcRef,
    dstRef,
    matrix,
    legacyMatrix,
    sourceChart: source.chartId,
    destinationChart: destination.chartId,
    sourcePairIndex: pair.sourcePairIndex,
    pairIndex,
    direction,
    foldAngleRadians: pair.foldAngleRadians,
    signedHingeRadians: hinge.angleRadians,
    anisotropy: matrixAnisotropy(matrix),
    sourceLengthTexels: Math.hypot(...sourceEdge) * fieldSize,
    diagnosticPolarAngle: Math.atan2(matrix.m10, matrix.m00),
  };
}

export function applyFrame(frame, uvPos) {
  const offset = subtract2(uvPos, frame.srcRef);
  const mapped = applyMatrix(frame.matrix, offset);
  return [mapped[0] + frame.dstRef[0], mapped[1] + frame.dstRef[1]];
}

export function transportHeading(frame, uvDirection) {
  const mapped = applyMatrix(frame.matrix, uvDirection);
  const length = Math.hypot(...mapped);
  if (!(length > 0)) throw new Error('seams: affine collapsed a heading');
  return mapped.map((value) => value / length);
}

export function triangleJacobian(mesh, uv1, triangleIndex) {
  const vertices = [...mesh.indices.subarray(triangleIndex * 3, triangleIndex * 3 + 3)];
  const [vertexA, vertexB, vertexC] = vertices;
  const edge1 = worldVector(mesh.positions, vertexA, vertexB);
  const edge2 = worldVector(mesh.positions, vertexA, vertexC);
  const uvA = vertexUv(uv1, vertexA);
  const uvB = vertexUv(uv1, vertexB);
  const uvC = vertexUv(uv1, vertexC);
  const d1 = subtract2(uvB, uvA);
  const d2 = subtract2(uvC, uvA);
  const determinant = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(determinant) < 1e-20) throw new Error(`seams: triangle ${triangleIndex} has singular uv1`);
  return {
    dU: combine3(edge1, d2[1] / determinant, edge2, -d1[1] / determinant),
    dV: combine3(edge2, d1[0] / determinant, edge1, -d2[0] / determinant),
  };
}

export function projectJacobian(destination, source) {
  const a00 = dot3(destination.dU, source.dU);
  const a01 = dot3(destination.dU, source.dV);
  const a10 = dot3(destination.dV, source.dU);
  const a11 = dot3(destination.dV, source.dV);
  const g00 = dot3(destination.dU, destination.dU);
  const g01 = dot3(destination.dU, destination.dV);
  const g11 = dot3(destination.dV, destination.dV);
  const determinant = g00 * g11 - g01 * g01;
  if (Math.abs(determinant) < 1e-20) throw new Error('seams: destination Jacobian is singular');
  const inverse = 1 / determinant;
  const i00 = g11 * inverse; const i01 = -g01 * inverse;
  const i10 = -g01 * inverse; const i11 = g00 * inverse;
  return {
    m00: i00 * a00 + i01 * a10,
    m01: i00 * a01 + i01 * a11,
    m10: i10 * a00 + i11 * a10,
    m11: i10 * a01 + i11 * a11,
  };
}

function hingeRotation(mesh, source, destination) {
  const axis = normalize3(worldVector(mesh.positions, source.vertex0, source.vertex1));
  const midpoint = [0, 1, 2].map((coordinate) => (
    mesh.positions[source.vertex0 * 3 + coordinate] + mesh.positions[source.vertex1 * 3 + coordinate]
  ) * 0.5);
  const sourceOutward = triangleInward(mesh, source.triangleIndex, midpoint, axis).map((value) => -value);
  const destinationInward = triangleInward(mesh, destination.triangleIndex, midpoint, axis);
  return {
    axis,
    angleRadians: Math.atan2(dot3(axis, cross3(sourceOutward, destinationInward)), dot3(sourceOutward, destinationInward)),
  };
}

function triangleInward(mesh, triangleIndex, edgeMidpoint, edgeAxis) {
  const vertices = [...mesh.indices.subarray(triangleIndex * 3, triangleIndex * 3 + 3)];
  const centroid = [0, 1, 2].map((coordinate) => vertices.reduce((sum, vertex) => (
    sum + mesh.positions[vertex * 3 + coordinate]
  ), 0) / 3);
  const towardCentroid = centroid.map((value, coordinate) => value - edgeMidpoint[coordinate]);
  const alongEdge = dot3(towardCentroid, edgeAxis);
  return normalize3(towardCentroid.map((value, coordinate) => value - edgeAxis[coordinate] * alongEdge));
}

function rotateVector(vector, axis, angle) {
  const cosine = Math.cos(angle); const sine = Math.sin(angle);
  const cross = cross3(axis, vector); const along = dot3(axis, vector) * (1 - cosine);
  return [0, 1, 2].map((index) => vector[index] * cosine + cross[index] * sine + axis[index] * along);
}

function matrixAnisotropy(matrix) {
  const trace = matrix.m00 ** 2 + matrix.m01 ** 2 + matrix.m10 ** 2 + matrix.m11 ** 2;
  const determinantSquared = (matrix.m00 * matrix.m11 - matrix.m01 * matrix.m10) ** 2;
  const discriminant = Math.sqrt(Math.max(0, trace ** 2 - 4 * determinantSquared));
  const largest = Math.sqrt(Math.max(0, (trace + discriminant) * 0.5));
  const smallest = Math.sqrt(Math.max(0, (trace - discriminant) * 0.5));
  return smallest > 1e-12 ? largest / smallest : Infinity;
}

function packFrame(frameData, frameId, frame) {
  const offset = frameId * FRAME_FLOATS;
  frameData.set([
    ...frame.srcRef, ...frame.dstRef,
    frame.matrix.m00, frame.matrix.m10, frame.matrix.m01, frame.matrix.m11,
    frame.sourceChart, frame.destinationChart, frame.sourcePairIndex, frame.direction,
    frame.foldAngleRadians, frame.anisotropy, frame.sourceLengthTexels, frame.diagnosticPolarAngle,
  ], offset);
}

function applyMatrix(matrix, vector) {
  return [matrix.m00 * vector[0] + matrix.m01 * vector[1], matrix.m10 * vector[0] + matrix.m11 * vector[1]];
}

function vertexUv(uv, vertex) { return [uv[vertex * 2], uv[vertex * 2 + 1]]; }
function subtract2(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function distance2(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function worldVector(positions, start, end) { return [0, 1, 2].map((axis) => positions[end * 3 + axis] - positions[start * 3 + axis]); }
function combine3(a, aScale, b, bScale) { return [0, 1, 2].map((axis) => a[axis] * aScale + b[axis] * bScale); }
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function normalize3(value) { const length = Math.hypot(...value); return value.map((axis) => axis / length); }
