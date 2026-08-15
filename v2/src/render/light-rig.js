// Semantic data from main.js:1611-1655. Geometry is expressed as named data so
// the renderer never has to rediscover which icosahedron convention legacy used.
export const ICOSA_VERTEX_COORDINATES = Object.freeze([
  [0, 1, goldenRatio()], [0, -1, goldenRatio()],
  [0, 1, -goldenRatio()], [0, -1, -goldenRatio()],
  [1, goldenRatio(), 0], [-1, goldenRatio(), 0],
  [1, -goldenRatio(), 0], [-1, -goldenRatio(), 0],
  [goldenRatio(), 0, 1], [-goldenRatio(), 0, 1],
  [goldenRatio(), 0, -1], [-goldenRatio(), 0, -1],
].map(freezeVector));

export const ICOSA_FACE_VERTEX_INDICES = Object.freeze([
  [0, 1, 8], [0, 1, 9], [0, 4, 5], [0, 4, 8], [0, 5, 9],
  [1, 6, 7], [1, 6, 8], [1, 7, 9], [2, 3, 10], [2, 3, 11],
  [2, 4, 5], [2, 4, 10], [2, 5, 11], [3, 6, 7], [3, 6, 10],
  [3, 7, 11], [4, 8, 10], [5, 9, 11], [6, 8, 10], [7, 9, 11],
].map(freezeVector));

export const ICOSA_LIGHT_CONSTANTS = Object.freeze({
  surfaceWorldSize: 9.6, // main.js:159
  radiusMultiplier: 1.85, // main.js:1615
  vertexCount: 12,
  faceCount: 20,
  fullCount: 32,
});

const LIGHT_RADIUS_WORLD = ICOSA_LIGHT_CONSTANTS.surfaceWorldSize
  * ICOSA_LIGHT_CONSTANTS.radiusMultiplier;
const vertexWorldPositions = ICOSA_VERTEX_COORDINATES.map((coordinate) => (
  scaleVector(normalizeVector(coordinate), LIGHT_RADIUS_WORLD)
));

export const ICOSA_LIGHTS = Object.freeze([
  ...vertexWorldPositions.map((worldPosition, vertexIndex) => lightRecord({
    kind: 'vertex',
    sourceIndices: [vertexIndex],
    worldPosition,
  })),
  ...ICOSA_FACE_VERTEX_INDICES.map((sourceIndices) => lightRecord({
    kind: 'face-centre',
    sourceIndices,
    worldPosition: averageVectors(sourceIndices.map((index) => vertexWorldPositions[index])),
  })),
]);

export const ICOSA_LIGHT_VARIANTS = Object.freeze({
  vertices: Object.freeze({ activeCount: 12, radianceScale: 1 }),
  verticesAndFaces: Object.freeze({ activeCount: 32, radianceScale: 12 / 32 }),
});

export function selectIcosaLightVariant(useFaceLights) {
  return useFaceLights ? ICOSA_LIGHT_VARIANTS.verticesAndFaces : ICOSA_LIGHT_VARIANTS.vertices;
}

export function makeIcosaLightUniformData() {
  const values = new Float32Array(ICOSA_LIGHTS.length * 4);
  for (let index = 0; index < ICOSA_LIGHTS.length; index += 1) {
    values.set(ICOSA_LIGHTS[index].worldPosition, index * 4);
    values[index * 4 + 3] = 1;
  }
  return values;
}

function lightRecord({ kind, sourceIndices, worldPosition }) {
  return Object.freeze({
    kind,
    sourceIndices: Object.freeze([...sourceIndices]),
    worldPosition: freezeVector(worldPosition),
    unitDirection: freezeVector(normalizeVector(worldPosition)),
    baseRadiance: 1,
  });
}

function goldenRatio() {
  return (1 + Math.sqrt(5)) / 2;
}

function averageVectors(vectors) {
  const sum = vectors.reduce(
    (result, vector) => result.map((value, axis) => value + vector[axis]),
    [0, 0, 0],
  );
  return sum.map((value) => value / vectors.length);
}

function normalizeVector(vector) {
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

function scaleVector(vector, scale) {
  return vector.map((value) => value * scale);
}

function freezeVector(vector) {
  return Object.freeze([...vector]);
}
