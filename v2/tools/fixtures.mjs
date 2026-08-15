import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIXTURE_FORMAT = 'packed-asset-stub@1';

export function buildFixtureSet() {
  return {
    'seam-quad': seamQuad(),
    cylinder: cylinder(),
    'two-chart-sphere': twoChartSphere(),
  };
}

function seamQuad() {
  return fixture('seam-quad', {
    purpose: 'A planar seam with deliberately different chart scale on each side.',
    positions: [
      -1, -1, 0, 0, -1, 0, -1, 1, 0, 0, 1, 0,
      0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0,
    ],
    uv: [0.08, 0.08, 0.42, 0.08, 0.08, 0.92, 0.42, 0.92,
      0.58, 0.2, 0.92, 0.2, 0.58, 0.8, 0.92, 0.8],
    indices: [0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7],
    triangleChartIds: [0, 0, 1, 1],
    seams: [{ chartA: 0, edgeA: [1, 3], chartB: 1, edgeB: [4, 6] }],
  });
}

function cylinder(segmentCount = 16) {
  const positions = [];
  const uv = [];
  const indices = [];
  const triangleChartIds = [];
  for (let segment = 0; segment <= segmentCount; segment += 1) {
    const angle = (segment / segmentCount) * Math.PI * 2;
    for (const height of [-1, 1]) {
      positions.push(Math.cos(angle), height, Math.sin(angle));
      uv.push(0.05 + 0.9 * segment / segmentCount, height < 0 ? 0.12 : 0.88);
    }
  }
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const lower = segment * 2;
    indices.push(lower, lower + 2, lower + 1, lower + 1, lower + 2, lower + 3);
    triangleChartIds.push(segment < segmentCount / 2 ? 0 : 1, segment < segmentCount / 2 ? 0 : 1);
  }
  return fixture('cylinder', {
    purpose: 'A curved surface with two longitudinal charts and a closed seam.',
    positions,
    uv,
    indices,
    triangleChartIds,
    seams: [
      { chartA: 0, edgeA: [0, 1], chartB: 1, edgeB: [segmentCount * 2, segmentCount * 2 + 1] },
      { chartA: 0, edgeA: [segmentCount, segmentCount + 1], chartB: 1, edgeB: [segmentCount, segmentCount + 1] },
    ],
  });
}

function twoChartSphere(longitudeCount = 16, latitudeCount = 8) {
  const positions = [];
  const uv = [];
  const indices = [];
  const triangleChartIds = [];
  for (let latitude = 0; latitude <= latitudeCount; latitude += 1) {
    const polar = latitude / latitudeCount * Math.PI;
    for (let longitude = 0; longitude <= longitudeCount; longitude += 1) {
      const azimuth = longitude / longitudeCount * Math.PI * 2;
      positions.push(
        Math.sin(polar) * Math.cos(azimuth),
        Math.cos(polar),
        Math.sin(polar) * Math.sin(azimuth),
      );
      uv.push(0.04 + 0.92 * longitude / longitudeCount, 0.04 + 0.92 * latitude / latitudeCount);
    }
  }
  const row = longitudeCount + 1;
  for (let latitude = 0; latitude < latitudeCount; latitude += 1) {
    for (let longitude = 0; longitude < longitudeCount; longitude += 1) {
      const corner = latitude * row + longitude;
      indices.push(corner, corner + row, corner + 1, corner + 1, corner + row, corner + row + 1);
      const chartId = longitude < longitudeCount / 2 ? 0 : 1;
      triangleChartIds.push(chartId, chartId);
    }
  }
  const seamVertices = Array.from({ length: latitudeCount + 1 }, (_, latitude) => latitude * row + longitudeCount / 2);
  return fixture('two-chart-sphere', {
    purpose: 'A folded two-chart surface with pole convergence.',
    positions,
    uv,
    indices,
    triangleChartIds,
    seams: [{ chartA: 0, chartB: 1, polyline: seamVertices }],
  });
}

function fixture(name, mesh) {
  return {
    format: FIXTURE_FORMAT,
    name,
    units: { positions: 'surface-space', uv: 'UV-space' },
    attributes: { positions: mesh.positions, uv: mesh.uv },
    indices: mesh.indices,
    triangleChartIds: mesh.triangleChartIds,
    seams: mesh.seams,
    metadata: { purpose: mesh.purpose, handBuiltFor: 'M0' },
  };
}

export async function writeFixtures(outputDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures')) {
  await mkdir(outputDirectory, { recursive: true });
  for (const [name, data] of Object.entries(buildFixtureSet())) {
    await writeFile(resolve(outputDirectory, `${name}.json`), `${JSON.stringify(data)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeFixtures();
}
