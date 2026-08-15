import { MAX_PACKING_DEMAND, atlasTarget } from './atlas-constants.mjs';
import { packMasks } from './mask-packer.mjs';
import { buildChartMasks } from './raster-masks.mjs';

const DESKTOP_WORLD_TEXEL_RATIO_LIMIT = 1.15;

export function repackAtlas(splitMesh, fieldSize, overrides = {}) {
  const target = atlasTarget(fieldSize, overrides);
  const raster = buildChartMasks(splitMesh, target);
  if (target.role === 'mobile' && raster.measuredDemandRatio > MAX_PACKING_DEMAND) {
    throw new Error(
      `repack: mobile demand ${(raster.measuredDemandRatio * 100).toFixed(2)}% exceeds `
      + `${(MAX_PACKING_DEMAND * 100).toFixed(0)}%; use the 1280 fallback decision`,
    );
  }
  const packing = packMasks(raster.masks, fieldSize);
  if (packing.occupiedCount !== raster.dilatedTexelDemand) {
    throw new Error('repack: packed masks overlap despite collision proof');
  }
  const uv1 = buildUv1(splitMesh, raster.masks, packing.placements, fieldSize);
  const chartTable = buildChartTable(raster, packing.placements, fieldSize);
  const clearance = proveClearance(raster.masks, packing.placements, fieldSize, target.gutterTexels);
  // M1 re-derives the audited legacy atlas occupancy (mesh-report.md); it is the density baseline.
  const legacyWorldAreaPerTexel = totalWorldArea(splitMesh) / (0.523679082 * fieldSize ** 2);
  const meanWorldTexelWidthRatio = Math.sqrt(raster.meanWorldAreaPerTexel / legacyWorldAreaPerTexel);
  if (target.role === 'desktop' && meanWorldTexelWidthRatio > DESKTOP_WORLD_TEXEL_RATIO_LIMIT) {
    throw new Error(`repack: desktop mean world texel width ratio ${meanWorldTexelWidthRatio} exceeds 1.15`);
  }
  return {
    fieldSize,
    target,
    uv1,
    chartTable,
    masks: raster.masks,
    placements: packing.placements,
    clearance,
    stats: {
      authoritativeTexelCount: raster.authoritativeTexelCount,
      dilatedTexelDemand: raster.dilatedTexelDemand,
      measuredDemandRatio: raster.measuredDemandRatio,
      achievedOccupancyRatio: packing.occupancyRatio,
      minChartUpscaleCount: raster.minChartUpscaleCount,
      meanWorldAreaPerTexel: raster.meanWorldAreaPerTexel,
      meanWorldTexelWidthRatio,
      densityScale: target.densityScale,
      parameterConversions: densityConversions(target.densityScale),
    },
  };
}

export function proveClearance(masks, placements, fieldSize, gutterTexels) {
  const authoritativeOwner = new Uint32Array(fieldSize * fieldSize);
  const dilatedOwner = new Uint32Array(fieldSize * fieldSize);
  for (let index = 0; index < masks.length; index += 1) {
    const mask = masks[index];
    const placement = placements[index];
    writeRows(mask.dilatedRows, placement, fieldSize, (texelIndex) => {
      if (dilatedOwner[texelIndex]) throw new Error('repack: two closed gutter dilations intersect');
      dilatedOwner[texelIndex] = mask.chart.id;
    });
    writeRows(mask.authoritativeRows, placement, fieldSize, (texelIndex, x, y) => {
      if (x < gutterTexels || y < gutterTexels || x >= fieldSize - gutterTexels || y >= fieldSize - gutterTexels) {
        throw new Error(`repack: chart ${mask.chart.id} violates the atlas border margin`);
      }
      if (authoritativeOwner[texelIndex]) throw new Error('repack: authoritative chart masks intersect');
      authoritativeOwner[texelIndex] = mask.chart.id;
    });
  }
  const minimumDistance = directChebyshevDistance(authoritativeOwner, fieldSize, gutterTexels * 2);
  if (minimumDistance < gutterTexels * 2 + 1) {
    throw new Error(`repack: chart distance ${minimumDistance} is below ${gutterTexels * 2 + 1}`);
  }
  return { authoritativeOwner, dilatedOwner, minimumChebyshevDistance: minimumDistance };
}

function buildUv1(splitMesh, masks, placements, fieldSize) {
  const uv1 = new Float32Array(splitMesh.uv0.length);
  const chartByVertex = new Uint32Array(splitMesh.positions.length / 3);
  for (let triangleIndex = 0; triangleIndex < splitMesh.triangleChartIds.length; triangleIndex += 1) {
    const chartId = splitMesh.triangleChartIds[triangleIndex];
    for (let corner = 0; corner < 3; corner += 1) chartByVertex[splitMesh.indices[triangleIndex * 3 + corner]] = chartId;
  }
  for (let vertex = 0; vertex < chartByVertex.length; vertex += 1) {
    const chartIndex = chartByVertex[vertex] - 1;
    const mask = masks[chartIndex];
    const placement = placements[chartIndex];
    uv1[vertex * 2] = splitMesh.uv0[vertex * 2] * mask.chartScale
      + (placement.x - mask.baseTexelX) / fieldSize;
    uv1[vertex * 2 + 1] = splitMesh.uv0[vertex * 2 + 1] * mask.chartScale
      + (placement.y - mask.baseTexelY) / fieldSize;
  }
  return uv1;
}

function buildChartTable(raster, placements, fieldSize) {
  return raster.masks.map((mask, index) => ({
    chartId: mask.chart.id,
    originalChartId: mask.chart.originalChartId,
    scale: mask.chartScale,
    translateUv: [
      (placements[index].x - mask.baseTexelX) / fieldSize,
      (placements[index].y - mask.baseTexelY) / fieldSize,
    ],
    authoritativeTexelCount: mask.authoritativeCount,
    worldAreaPerTexel: mask.worldAreaPerTexel,
    texelDensityFactor: mask.texelDensityFactor,
    minChartUpscaled: mask.minChartUpscaled,
  }));
}

function directChebyshevDistance(owner, fieldSize, searchRadius) {
  let minimum = Infinity;
  for (let y = 0; y < fieldSize; y += 1) {
    for (let x = 0; x < fieldSize; x += 1) {
      const chartId = owner[y * fieldSize + x];
      if (!chartId) continue;
      for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
        const otherY = y + dy;
        if (otherY < 0 || otherY >= fieldSize) continue;
        for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          if (!distance || distance >= minimum) continue;
          const otherX = x + dx;
          if (otherX < 0 || otherX >= fieldSize) continue;
          const otherChart = owner[otherY * fieldSize + otherX];
          if (otherChart && otherChart !== chartId) minimum = distance;
        }
      }
    }
  }
  return Number.isFinite(minimum) ? minimum : searchRadius + 1;
}

function writeRows(rows, placement, fieldSize, visit) {
  for (let localY = 0; localY < rows.length; localY += 1) {
    const y = placement.y + localY;
    for (const [start, end] of rows[localY]) {
      for (let localX = start; localX <= end; localX += 1) {
        const x = placement.x + localX;
        visit(y * fieldSize + x, x, y);
      }
    }
  }
}

function densityConversions(densityScale) {
  return Object.freeze({
    sensorDistance: densityScale,
    stepSize: densityScale,
    childOffset: densityScale,
    repelUvGroup: densityScale,
    crowdKernelRadius: densityScale,
    foodDepositSprite: 1,
    diffusionPerTexel: 1,
  });
}

function totalWorldArea(splitMesh) {
  return splitMesh.charts.reduce((sum, chart) => sum + chart.worldArea, 0);
}
