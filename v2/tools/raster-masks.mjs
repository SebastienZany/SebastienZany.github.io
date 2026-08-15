import { MIN_CHART_TEXELS } from './atlas-constants.mjs';

// Packing uses closed triangle/square intersection. A center-only raster would understate the
// exact clearance needed by triangles that merely clip the edge of a texel.
export function buildChartMasks(splitMesh, target) {
  const masks = splitMesh.charts.map((chart) => buildOneChartMask(splitMesh, chart, target));
  const authoritativeTexelCount = masks.reduce((sum, mask) => sum + mask.authoritativeCount, 0);
  const dilatedTexelDemand = masks.reduce((sum, mask) => sum + mask.dilatedCount, 0);
  const totalWorldArea = splitMesh.charts.reduce((sum, chart) => sum + chart.worldArea, 0);
  const meanWorldAreaPerTexel = totalWorldArea / authoritativeTexelCount;
  for (const mask of masks) {
    mask.worldAreaPerTexel = mask.chart.worldArea / mask.authoritativeCount;
    mask.texelDensityFactor = mask.worldAreaPerTexel / meanWorldAreaPerTexel;
  }
  return {
    masks,
    authoritativeTexelCount,
    dilatedTexelDemand,
    measuredDemandRatio: dilatedTexelDemand / (target.fieldSize ** 2),
    meanWorldAreaPerTexel,
    minChartUpscaleCount: masks.filter((mask) => mask.minChartUpscaled).length,
  };
}

export function rasterizeTriangleMask(points, width, height) {
  const mask = new Uint8Array(width * height);
  const minX = Math.max(0, Math.floor(Math.min(...points.map((point) => point[0]))) - 1);
  const maxX = Math.min(width - 1, Math.floor(Math.max(...points.map((point) => point[0]))));
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point[1]))) - 1);
  const maxY = Math.min(height - 1, Math.floor(Math.max(...points.map((point) => point[1]))));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (triangleTouchesSquare(points, x, y)) mask[y * width + x] = 1;
    }
  }
  return mask;
}

export function dilateChebyshev(source, width, height, radius) {
  const horizontal = new Uint8Array(source.length);
  const output = new Uint8Array(source.length);
  for (let y = 0; y < height; y += 1) {
    let count = 0;
    for (let sampleX = 0; sampleX <= Math.min(width - 1, radius); sampleX += 1) {
      count += source[y * width + sampleX];
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] = count > 0 ? 1 : 0;
      if (x + radius + 1 < width) count += source[y * width + x + radius + 1];
      if (x - radius >= 0) count -= source[y * width + x - radius];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let count = 0;
    for (let sampleY = 0; sampleY <= Math.min(height - 1, radius); sampleY += 1) {
      count += horizontal[sampleY * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = count > 0 ? 1 : 0;
      if (y + radius + 1 < height) count += horizontal[(y + radius + 1) * width + x];
      if (y - radius >= 0) count -= horizontal[(y - radius) * width + x];
    }
  }
  return output;
}

export function maskIntervals(mask, width, height) {
  const rows = Array.from({ length: height }, () => []);
  for (let y = 0; y < height; y += 1) {
    let start = -1;
    for (let x = 0; x <= width; x += 1) {
      const occupied = x < width && mask[y * width + x] !== 0;
      if (occupied && start < 0) start = x;
      if (!occupied && start >= 0) {
        rows[y].push([start, x - 1]);
        start = -1;
      }
    }
  }
  return rows;
}

function buildOneChartMask(splitMesh, chart, target) {
  let chartScale = target.densityScale;
  let raster;
  let minChartUpscaled = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    raster = rasterChart(splitMesh, chart, target, chartScale);
    const [footprintWidth, footprintHeight] = occupiedExtents(raster.authoritative, raster.width, raster.height);
    if (footprintWidth >= MIN_CHART_TEXELS && footprintHeight >= MIN_CHART_TEXELS) break;
    minChartUpscaled = true;
    chartScale *= Math.max(
      MIN_CHART_TEXELS / Math.max(footprintWidth, 1),
      MIN_CHART_TEXELS / Math.max(footprintHeight, 1),
    ) * 1.01;
  }
  const [footprintWidth, footprintHeight] = occupiedExtents(raster.authoritative, raster.width, raster.height);
  if (footprintWidth < MIN_CHART_TEXELS || footprintHeight < MIN_CHART_TEXELS) {
    throw new Error(`repack: chart ${chart.id} cannot reach the minimum footprint`);
  }
  const dilated = dilateChebyshev(
    raster.authoritative,
    raster.width,
    raster.height,
    target.gutterTexels,
  );
  const authoritativeCount = countMask(raster.authoritative);
  const dilatedCount = countMask(dilated);
  return {
    chart,
    chartScale,
    minChartUpscaled,
    ...raster,
    authoritativeCount,
    dilated,
    dilatedCount,
    authoritativeRows: maskIntervals(raster.authoritative, raster.width, raster.height),
    dilatedRows: maskIntervals(dilated, raster.width, raster.height),
  };
}

function rasterChart(splitMesh, chart, target, chartScale) {
  const scaledBounds = chart.uvBounds.map((value) => value * target.fieldSize * chartScale);
  const baseTexelX = Math.floor(scaledBounds[0]) - target.gutterTexels - 1;
  const baseTexelY = Math.floor(scaledBounds[1]) - target.gutterTexels - 1;
  const width = Math.ceil(scaledBounds[2]) - baseTexelX + target.gutterTexels + 1;
  const height = Math.ceil(scaledBounds[3]) - baseTexelY + target.gutterTexels + 1;
  const authoritative = new Uint8Array(width * height);
  const triangleRefs = new Int32Array(width * height).fill(-1);
  for (const triangleIndex of chart.triangles) {
    const points = [0, 1, 2].map((corner) => {
      const vertex = splitMesh.indices[triangleIndex * 3 + corner];
      return [
        splitMesh.uv0[vertex * 2] * target.fieldSize * chartScale - baseTexelX,
        splitMesh.uv0[vertex * 2 + 1] * target.fieldSize * chartScale - baseTexelY,
      ];
    });
    const minX = Math.max(0, Math.floor(Math.min(...points.map((point) => point[0]))) - 1);
    const maxX = Math.min(width - 1, Math.floor(Math.max(...points.map((point) => point[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point[1]))) - 1);
    const maxY = Math.min(height - 1, Math.floor(Math.max(...points.map((point) => point[1]))));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (!triangleTouchesSquare(points, x, y)) continue;
        const index = y * width + x;
        authoritative[index] = 1;
        if (triangleRefs[index] < 0 || triangleIndex < triangleRefs[index]) triangleRefs[index] = triangleIndex;
      }
    }
  }
  return { width, height, baseTexelX, baseTexelY, authoritative, triangleRefs };
}

function triangleTouchesSquare(triangle, squareX, squareY) {
  const square = [
    [squareX, squareY], [squareX + 1, squareY],
    [squareX + 1, squareY + 1], [squareX, squareY + 1],
  ];
  if (triangle.some(([x, y]) => x >= squareX && x <= squareX + 1 && y >= squareY && y <= squareY + 1)) return true;
  if (square.some((point) => pointInTriangle(point, triangle))) return true;
  for (let triangleEdge = 0; triangleEdge < 3; triangleEdge += 1) {
    for (let squareEdge = 0; squareEdge < 4; squareEdge += 1) {
      if (segmentsIntersect(
        triangle[triangleEdge], triangle[(triangleEdge + 1) % 3],
        square[squareEdge], square[(squareEdge + 1) % 4],
      )) return true;
    }
  }
  return false;
}

function pointInTriangle(point, triangle) {
  const signs = [0, 1, 2].map((index) => orient(triangle[index], triangle[(index + 1) % 3], point));
  return signs.every((value) => value >= -1e-10) || signs.every((value) => value <= 1e-10);
}

function segmentsIntersect(a, b, c, d) {
  const abC = orient(a, b, c); const abD = orient(a, b, d);
  const cdA = orient(c, d, a); const cdB = orient(c, d, b);
  return Math.min(abC, abD) <= 1e-10 && Math.max(abC, abD) >= -1e-10
    && Math.min(cdA, cdB) <= 1e-10 && Math.max(cdA, cdB) >= -1e-10
    && Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) + 1e-10
    && Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1])) + 1e-10;
}

function orient(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }

function occupiedExtents(mask, width, height) {
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? [0, 0] : [maxX - minX + 1, maxY - minY + 1];
}

function countMask(mask) {
  let count = 0;
  for (const value of mask) count += value;
  return count;
}
