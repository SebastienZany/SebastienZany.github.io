import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readGlb } from '../../tools/glb.mjs';
import {
  buildChartSegmentation,
  countSubTexelCharts,
  extractSeamEdges,
} from '../../tools/mesh.mjs';

const meshPath = fileURLToPath(new URL('../../../luyvwj-fwgyww.glb', import.meta.url));

test('mesh topology reproduces the independently audited chart and seam ground truth', async () => {
  const mesh = await readGlb(meshPath);
  const segmentation = buildChartSegmentation(mesh.uv0, mesh.indices);
  assert.equal(segmentation.charts.length, 1_233);
  assert.equal(segmentation.triangleChartIds.length, 501_428);
  assert.equal(segmentation.boundarySides.length, 60_068);
  assert.equal(segmentation.nonManifoldEdgeCount, 0);
  assert.ok(segmentation.triangleChartIds.every((chartId) => chartId < segmentation.charts.length));
  assert.equal(
    segmentation.charts.reduce((sum, chart) => sum + chart.triangleCount, 0),
    501_428,
  );

  const seams = extractSeamEdges(mesh.positions, mesh.uv0, mesh.indices, segmentation);
  assert.equal(seams.seamPairs.length, 30_034);
  assert.equal(seams.directionalSideCount, 60_068);
  assert.equal(seams.seamPairs.filter((pair) => pair.isSlit).length, 3_592);
  assert.equal(seams.slitComponents.length, 630);
  assert.equal(seams.endpointGroupedSlitComponentCount, 570);
  assert.equal(Math.max(...seams.slitComponents.map((component) => component.edgeCount)), 87);
  assert.deepEqual(seams.endpointGroupStats, {
    componentCount: 570,
    branchingComponentCount: 19,
    branchVertexCount: 21,
    closedLoopCount: 5,
    multiChartGroupCount: 53,
  });
  assert.deepEqual(seams.chartLocalComponentStats, {
    componentCount: 630,
    branchingComponentCount: 18,
    branchVertexCount: 19,
    closedLoopCount: 0,
  });
  assert.ok(seams.seamPairs.every((pair) => pair.coincidenceError <= seams.positionEpsilon));

  const degrees = 180 / Math.PI;
  assert.equal(seams.seamPairs.filter((pair) => pair.foldAngleRadians * degrees > 60).length, 3_718);
  assert.equal(seams.seamPairs.filter((pair) => pair.foldAngleRadians * degrees > 80).length, 1_318);
  assert.equal(seams.seamPairs.filter((pair) => pair.foldAngleRadians * degrees > 89).length, 147);

  assert.equal(seams.cornerCensus.byChartCount[3], 2_167);
  assert.equal(seams.cornerCensus.byChartCount[4], 164);
  assert.equal(seams.cornerCensus.byChartCount[5], 12);
  assert.deepEqual(seams.cornerCensus.angleDefects, { positive: 181, negative: 1_358, flat: 804 });

  const altitudesAt1536 = seams.seamPairs
    .flatMap((pair) => pair.sides.map((side) => side.uvAltitude * 1536))
    .sort((left, right) => left - right);
  assert.equal(altitudesAt1536.length, 60_068);
  assert.equal(altitudesAt1536.filter((altitude) => altitude < 4).length, 59_215);
  assert.ok(Math.abs(altitudesAt1536[Math.floor(altitudesAt1536.length / 2)] - 1.49) <= 0.01);

  assert.equal(
    countSubTexelCharts(mesh.uv0, mesh.indices, segmentation.triangleChartIds, 1_233, 1536).length,
    12,
  );
  assert.equal(
    countSubTexelCharts(mesh.uv0, mesh.indices, segmentation.triangleChartIds, 1_233, 1024).length,
    14,
  );
});
