const TWO_CHART_SPHERE_URL = new URL('../../tests/fixtures/two-chart-sphere.json', import.meta.url);

export async function loadTwoChartSphereFixture({ device, registry, fetchImpl = fetch }) {
  const response = await fetchImpl(TWO_CHART_SPHERE_URL);
  if (!response.ok) throw new Error(`Fixture request failed with HTTP ${response.status}`);
  const fixture = await response.json();
  assertFixture(fixture);

  const positions = fixture.attributes.positions;
  const uv = fixture.attributes.uv;
  const vertexCount = positions.length / 3;
  const interleaved = new Float32Array(vertexCount * 8);
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    const positionOffset = vertexIndex * 3;
    const vertexOffset = vertexIndex * 8;
    const worldX = positions[positionOffset];
    const worldY = positions[positionOffset + 1];
    const worldZ = positions[positionOffset + 2];
    const normalLength = Math.hypot(worldX, worldY, worldZ) || 1;
    interleaved.set([
      worldX, worldY, worldZ,
      worldX / normalLength, worldY / normalLength, worldZ / normalLength,
      uv[vertexIndex * 2], uv[vertexIndex * 2 + 1],
    ], vertexOffset);
  }

  const maximumIndex = fixture.indices.reduce((maximum, index) => Math.max(maximum, index), 0);
  const IndexArray = maximumIndex <= 0xffff ? Uint16Array : Uint32Array;
  const indices = new IndexArray(fixture.indices);
  const vertexBuffer = uploadBuffer(registry, {
    label: 'look-two-chart-sphere-vertices',
    values: interleaved,
    usage: GPUBufferUsage.VERTEX,
  });
  const indexBuffer = uploadBuffer(registry, {
    label: 'look-two-chart-sphere-indices',
    values: indices,
    usage: GPUBufferUsage.INDEX,
  });

  return Object.freeze({
    name: fixture.name,
    vertexBuffer,
    indexBuffer,
    indexCount: indices.length,
    indexFormat: indices instanceof Uint16Array ? 'uint16' : 'uint32',
  });
}

function uploadBuffer(registry, { label, values, usage }) {
  const buffer = registry.createBuffer({
    label,
    size: values.byteLength,
    usage,
    mappedAtCreation: true,
  });
  new values.constructor(buffer.getMappedRange()).set(values);
  buffer.unmap();
  return buffer;
}

function assertFixture(fixture) {
  const positions = fixture?.attributes?.positions;
  const uv = fixture?.attributes?.uv;
  if (fixture?.name !== 'two-chart-sphere'
      || !Array.isArray(positions)
      || !Array.isArray(uv)
      || !Array.isArray(fixture.indices)
      || positions.length % 3 !== 0
      || uv.length / 2 !== positions.length / 3) {
    throw new Error('two-chart-sphere fixture has an invalid mesh contract');
  }
}
