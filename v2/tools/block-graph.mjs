import { BLOCK_TEXELS } from './atlas-constants.mjs';

export function buildBlockGraph(splitMesh, repack, raster, blockTexels = BLOCK_TEXELS) {
  const blocksPerAxis = Math.ceil(repack.fieldSize / blockTexels);
  const blockCount = blocksPerAxis ** 2;
  const nodeByChartBlock = new Map();
  const nodes = [];
  for (let texelIndex = 0; texelIndex < raster.authoritativeOwner.length; texelIndex += 1) {
    const chartId = raster.authoritativeOwner[texelIndex];
    if (!chartId) continue;
    const x = texelIndex % repack.fieldSize; const y = Math.floor(texelIndex / repack.fieldSize);
    const blockX = Math.floor(x / blockTexels); const blockY = Math.floor(y / blockTexels);
    const blockIndex = blockY * blocksPerAxis + blockX;
    const key = chartId * blockCount + blockIndex;
    let nodeIndex = nodeByChartBlock.get(key);
    if (nodeIndex === undefined) {
      nodeIndex = nodes.length;
      nodeByChartBlock.set(key, nodeIndex);
      nodes.push({ chartId, blockX, blockY, worldSum: [0, 0, 0], texelCount: 0 });
    }
    const node = nodes[nodeIndex];
    for (let axis = 0; axis < 3; axis += 1) node.worldSum[axis] += raster.worldPos[texelIndex * 3 + axis];
    node.texelCount += 1;
  }
  for (const node of nodes) {
    node.meanWorldPos = node.worldSum.map((value) => value / node.texelCount);
    node.representativeDistanceSquared = Infinity;
  }
  // A mean of curved surface samples can lie off the mesh. Keep the closest real texel as the
  // graph anchor so its emitted position has an unambiguous surface/geodesic meaning.
  for (let texelIndex = 0; texelIndex < raster.authoritativeOwner.length; texelIndex += 1) {
    const chartId = raster.authoritativeOwner[texelIndex];
    if (!chartId) continue;
    const x = texelIndex % repack.fieldSize; const y = Math.floor(texelIndex / repack.fieldSize);
    const blockX = Math.floor(x / blockTexels); const blockY = Math.floor(y / blockTexels);
    const nodeIndex = nodeByChartBlock.get(chartId * blockCount + blockY * blocksPerAxis + blockX);
    const node = nodes[nodeIndex];
    const triangleIndex = raster.triangleMap[texelIndex];
    const anchor = closestSurfaceAnchor(splitMesh, repack, triangleIndex, [x + 0.5, y + 0.5]);
    const position = anchor.worldPos;
    const distanceSquared = squaredDistance3(position, node.meanWorldPos);
    if (distanceSquared < node.representativeDistanceSquared || (
      distanceSquared === node.representativeDistanceSquared && texelIndex < node.representativeTexel
    )) {
      node.representativeDistanceSquared = distanceSquared;
      node.representativeTexel = texelIndex;
      node.representativeTriangle = triangleIndex;
      node.worldCenter = position;
      node.atlasCenter = anchor.atlasPos;
    }
  }

  const edges = Array.from({ length: nodes.length }, () => new Map());
  nodes.forEach((node, nodeIndex) => {
    for (const [dx, dy] of [[1, -1], [1, 0], [1, 1], [0, 1]]) {
      const targetX = node.blockX + dx; const targetY = node.blockY + dy;
      if (targetX < 0 || targetY < 0 || targetX >= blocksPerAxis || targetY >= blocksPerAxis) continue;
      const targetKey = node.chartId * blockCount + targetY * blocksPerAxis + targetX;
      const targetIndex = nodeByChartBlock.get(targetKey);
      if (targetIndex !== undefined) connect(edges, nodes, nodeIndex, targetIndex, distance3(nodes[nodeIndex].worldCenter, nodes[targetIndex].worldCenter));
    }
  });
  for (const pair of splitMesh.seamPairs) {
    for (const fraction of seamBlockIntervalMidpoints(pair, repack, blockTexels)) {
      const nodeIndices = pair.sides.map((side) => nodeForSide(
        side,
        fraction,
        repack,
        nodeByChartBlock,
        blocksPerAxis,
        blockCount,
        blockTexels,
      ));
      if (nodeIndices.some((index) => index === undefined) || nodeIndices[0] === nodeIndices[1]) continue;
      const surfacePoint = [0, 1, 2].map((axis) => (
        splitMesh.positions[pair.sides[0].vertex0 * 3 + axis] * (1 - fraction)
        + splitMesh.positions[pair.sides[0].vertex1 * 3 + axis] * fraction
      ));
      const weight = distance3(nodes[nodeIndices[0]].worldCenter, surfacePoint)
        + distance3(surfacePoint, nodes[nodeIndices[1]].worldCenter);
      connect(edges, nodes, nodeIndices[0], nodeIndices[1], weight);
    }
  }
  return encodeGraph(nodes, edges, blocksPerAxis, blockTexels);
}

export function dijkstraBlockGraph(graph, sourceNode) {
  const distance = new Float64Array(graph.nodeCount).fill(Infinity);
  const queue = new MinimumQueue();
  distance[sourceNode] = 0;
  queue.push(sourceNode, 0);
  while (queue.length) {
    const { node, priority } = queue.pop();
    if (priority !== distance[node]) continue;
    for (let edge = graph.offsets[node]; edge < graph.offsets[node + 1]; edge += 1) {
      const target = graph.targets[edge];
      const candidate = distance[node] + graph.weights[edge];
      if (candidate < distance[target]) {
        distance[target] = candidate;
        queue.push(target, candidate);
      }
    }
  }
  return distance;
}

export function interpolateBlockDistances(graph, distances, chartId, atlasX, atlasY) {
  const gridX = atlasX / graph.blockTexels - 0.5;
  const gridY = atlasY / graph.blockTexels - 0.5;
  const x0 = Math.floor(gridX); const y0 = Math.floor(gridY);
  const fractionX = gridX - x0; const fractionY = gridY - y0;
  const lookup = graphNodeLookup(graph);
  const corners = [
    [x0, y0, (1 - fractionX) * (1 - fractionY)],
    [x0 + 1, y0, fractionX * (1 - fractionY)],
    [x0, y0 + 1, (1 - fractionX) * fractionY],
    [x0 + 1, y0 + 1, fractionX * fractionY],
  ];
  let value = 0; let weightSum = 0;
  for (const [blockX, blockY, weight] of corners) {
    const node = lookup.get(nodeKey(chartId, blockX, blockY));
    if (node === undefined || !Number.isFinite(distances[node])) continue;
    value += distances[node] * weight;
    weightSum += weight;
  }
  if (weightSum > 1e-12) return value / weightSum;
  let nearest = Infinity; let nearestDistanceSquared = Infinity;
  graph.nodes.forEach((node, nodeIndex) => {
    if (node.chartId !== chartId || !Number.isFinite(distances[nodeIndex])) return;
    const distanceSquared = (node.atlasCenter[0] - atlasX) ** 2 + (node.atlasCenter[1] - atlasY) ** 2;
    if (distanceSquared < nearestDistanceSquared) {
      nearestDistanceSquared = distanceSquared;
      nearest = distances[nodeIndex];
    }
  });
  return nearest;
}

function nodeForSide(side, fraction, repack, nodeByChartBlock, blocksPerAxis, blockCount, blockTexels) {
  const u = repack.uv1[side.vertex0 * 2] * (1 - fraction) + repack.uv1[side.vertex1 * 2] * fraction;
  const v = repack.uv1[side.vertex0 * 2 + 1] * (1 - fraction) + repack.uv1[side.vertex1 * 2 + 1] * fraction;
  const blockX = clamp(Math.floor(u * repack.fieldSize / blockTexels), 0, blocksPerAxis - 1);
  const blockY = clamp(Math.floor(v * repack.fieldSize / blockTexels), 0, blocksPerAxis - 1);
  const direct = nodeByChartBlock.get(side.chartId * blockCount + blockY * blocksPerAxis + blockX);
  if (direct !== undefined) return direct;
  for (let radius = 1; radius < blocksPerAxis; radius += 1) {
    for (let y = Math.max(0, blockY - radius); y <= Math.min(blocksPerAxis - 1, blockY + radius); y += 1) {
      for (let x = Math.max(0, blockX - radius); x <= Math.min(blocksPerAxis - 1, blockX + radius); x += 1) {
        if (Math.max(Math.abs(x - blockX), Math.abs(y - blockY)) !== radius) continue;
        const candidate = nodeByChartBlock.get(side.chartId * blockCount + y * blocksPerAxis + x);
        if (candidate !== undefined) return candidate;
      }
    }
  }
  return undefined;
}

function seamBlockIntervalMidpoints(pair, repack, blockTexels) {
  const fractions = [0, 1];
  for (const side of pair.sides) {
    for (let axis = 0; axis < 2; axis += 1) {
      const start = repack.uv1[side.vertex0 * 2 + axis] * repack.fieldSize;
      const end = repack.uv1[side.vertex1 * 2 + axis] * repack.fieldSize;
      const minimum = Math.min(start, end); const maximum = Math.max(start, end);
      for (let boundary = Math.floor(minimum / blockTexels) + 1; boundary * blockTexels < maximum; boundary += 1) {
        const fraction = (boundary * blockTexels - start) / (end - start);
        if (fraction > 1e-9 && fraction < 1 - 1e-9) fractions.push(fraction);
      }
    }
  }
  fractions.sort((left, right) => left - right);
  const unique = fractions.filter((value, index) => index === 0 || value - fractions[index - 1] > 1e-9);
  return unique.slice(0, -1).map((value, index) => (value + unique[index + 1]) * 0.5);
}

function closestSurfaceAnchor(mesh, repack, triangleIndex, atlasPos) {
  const vertices = [...mesh.indices.subarray(triangleIndex * 3, triangleIndex * 3 + 3)];
  const triangle = vertices.map((vertex) => [
    repack.uv1[vertex * 2] * repack.fieldSize,
    repack.uv1[vertex * 2 + 1] * repack.fieldSize,
  ]);
  const barycentric = barycentric2(triangle, atlasPos);
  let closest = atlasPos;
  if (barycentric.some((weight) => weight < 0)) {
    const candidates = [0, 1, 2].map((corner) => closestPoint2(
      atlasPos,
      triangle[corner],
      triangle[(corner + 1) % 3],
    ));
    candidates.sort((left, right) => left.distanceSquared - right.distanceSquared);
    closest = candidates[0].point;
  }
  const surfaceBarycentric = barycentric2(triangle, closest);
  const worldPos = [0, 1, 2].map((axis) => surfaceBarycentric.reduce((sum, weight, corner) => (
    sum + weight * mesh.positions[vertices[corner] * 3 + axis]
  ), 0));
  return { atlasPos: closest, worldPos };
}

function barycentric2([a, b, c], point) {
  const denominator = cross2(subtract2(b, a), subtract2(c, a));
  const second = cross2(subtract2(point, a), subtract2(c, a)) / denominator;
  const third = cross2(subtract2(b, a), subtract2(point, a)) / denominator;
  return [1 - second - third, second, third];
}

function closestPoint2(point, start, end) {
  const edge = subtract2(end, start);
  const denominator = dot2(edge, edge);
  const fraction = denominator > 0 ? clamp(dot2(subtract2(point, start), edge) / denominator, 0, 1) : 0;
  const closest = [start[0] + edge[0] * fraction, start[1] + edge[1] * fraction];
  return { point: closest, distanceSquared: (point[0] - closest[0]) ** 2 + (point[1] - closest[1]) ** 2 };
}

function connect(edges, nodes, first, second, weight) {
  void nodes;
  edges[first].set(second, Math.min(edges[first].get(second) ?? Infinity, weight));
  edges[second].set(first, Math.min(edges[second].get(first) ?? Infinity, weight));
}

function encodeGraph(nodes, edges, blocksPerAxis, blockTexels) {
  const offsets = new Uint32Array(nodes.length + 1);
  for (let node = 0; node < nodes.length; node += 1) offsets[node + 1] = offsets[node] + edges[node].size;
  const targets = new Uint32Array(offsets.at(-1));
  const weights = new Float32Array(offsets.at(-1));
  for (let node = 0; node < nodes.length; node += 1) {
    let output = offsets[node];
    for (const [target, weight] of [...edges[node]].sort(([left], [right]) => left - right)) {
      targets[output] = target; weights[output] = weight; output += 1;
    }
  }
  return {
    nodeCount: nodes.length,
    nodes: nodes.map(({
      chartId,
      blockX,
      blockY,
      worldCenter,
      atlasCenter,
      representativeTexel,
      representativeTriangle,
      texelCount,
    }) => ({
      chartId,
      blockX,
      blockY,
      worldCenter,
      atlasCenter,
      representativeTexel,
      representativeTriangle,
      texelCount,
    })),
    offsets,
    targets,
    weights,
    blocksPerAxis,
    blockTexels,
  };
}

const nodeLookups = new WeakMap();
function graphNodeLookup(graph) {
  let lookup = nodeLookups.get(graph);
  if (!lookup) {
    lookup = new Map(graph.nodes.map((node, index) => [nodeKey(node.chartId, node.blockX, node.blockY), index]));
    nodeLookups.set(graph, lookup);
  }
  return lookup;
}
function nodeKey(chartId, blockX, blockY) { return `${chartId}:${blockX}:${blockY}`; }

class MinimumQueue {
  constructor() { this.items = []; }
  get length() { return this.items.length; }
  push(node, priority) {
    const item = { node, priority }; this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= priority) break;
      this.items[index] = this.items[parent]; index = parent;
    }
    this.items[index] = item;
  }
  pop() {
    const result = this.items[0]; const tail = this.items.pop();
    if (this.items.length) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1; const right = left + 1;
        if (left >= this.items.length) break;
        const child = right < this.items.length && this.items[right].priority < this.items[left].priority ? right : left;
        if (this.items[child].priority >= tail.priority) break;
        this.items[index] = this.items[child]; index = child;
      }
      this.items[index] = tail;
    }
    return result;
  }
}

function distance3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function squaredDistance3(a, b) { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; }
function subtract2(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function dot2(a, b) { return a[0] * b[0] + a[1] * b[1]; }
function cross2(a, b) { return a[0] * b[1] - a[1] * b[0]; }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
