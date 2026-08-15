import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIXTURE_FORMAT = 'surface-fixture@2';

export function buildFixtureSet() {
  return {
    'seam-quad': seamQuad(),
    'folded-quad-45': foldedQuad(45),
    'folded-quad-80': foldedQuad(80),
    cylinder: cylinder(),
    'two-chart-sphere': twoChartSphere(),
    'three-chart-corner': threeChartCorner(),
    'thin-sheet': thinSheet(),
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

function foldedQuad(angleDegrees) {
  const angle = angleDegrees * Math.PI / 180;
  const destinationTop = [0, -Math.cos(angle), Math.sin(angle)];
  const destinationFarTop = [1, -Math.cos(angle), Math.sin(angle)];
  return fixture(`folded-quad-${angleDegrees}`, {
    purpose: `An analytic hinge whose two chart planes meet at ${angleDegrees} degrees.`,
    positions: [
      0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0,
      0, 0, 0, 1, 0, 0, ...destinationTop, ...destinationFarTop,
    ],
    uv: [
      0.08, 0.08, 0.42, 0.08, 0.08, 0.42, 0.42, 0.42,
      0.58, 0.08, 0.92, 0.08, 0.58, 0.42, 0.92, 0.42,
    ],
    indices: [0, 1, 2, 2, 1, 3, 5, 4, 6, 5, 6, 7],
    triangleChartIds: [0, 0, 1, 1],
    seams: [{ chartA: 0, edgeA: [0, 1], chartB: 1, edgeB: [4, 5], foldAngleDegrees: angleDegrees }],
  });
}

function threeChartCorner() {
  return fixture('three-chart-corner', {
    purpose: 'Three independently parameterized charts meet at one cone vertex.',
    positions: [
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0, 0, 1, 0, 0, 0, 1,
      0, 0, 0, 0, 0, 1, 1, 0, 0,
    ],
    uv: [
      0.08, 0.08, 0.4, 0.08, 0.08, 0.4,
      0.58, 0.08, 0.9, 0.08, 0.58, 0.4,
      0.33, 0.58, 0.65, 0.58, 0.33, 0.9,
    ],
    indices: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    triangleChartIds: [0, 1, 2],
    seams: [
      { chartA: 0, edgeA: [0, 2], chartB: 1, edgeB: [3, 4] },
      { chartA: 1, edgeA: [3, 5], chartB: 2, edgeB: [6, 7] },
      { chartA: 2, edgeA: [6, 8], chartB: 0, edgeB: [0, 1] },
    ],
  });
}

function thinSheet() {
  return fixture('thin-sheet', {
    purpose: 'Two parallel surface patches are close in world space but disconnected geodesically.',
    positions: [
      -1, -1, -0.01, 1, -1, -0.01, -1, 1, -0.01, 1, 1, -0.01,
      -1, -1, 0.01, 1, -1, 0.01, -1, 1, 0.01, 1, 1, 0.01,
    ],
    uv: [
      0.05, 0.05, 0.45, 0.05, 0.05, 0.95, 0.45, 0.95,
      0.55, 0.05, 0.95, 0.05, 0.55, 0.95, 0.95, 0.95,
    ],
    indices: [0, 1, 2, 2, 1, 3, 4, 6, 5, 6, 7, 5],
    triangleChartIds: [0, 0, 1, 1],
    seams: [{ disconnectedNearPair: [0, 1], worldGap: 0.02 }],
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
    metadata: { purpose: mesh.purpose, handBuiltFor: 'M2' },
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
