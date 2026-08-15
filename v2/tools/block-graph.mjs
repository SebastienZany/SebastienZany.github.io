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
  for (const node of nodes) node.worldCenter = node.worldSum.map((value) => value / node.texelCount);

  const edges = Array.from({ length: nodes.length }, () => new Map());
  nodes.forEach((node, nodeIndex) => {
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const targetX = node.blockX + dx; const targetY = node.blockY + dy;
      if (targetX >= blocksPerAxis || targetY >= blocksPerAxis) continue;
      const targetKey = node.chartId * blockCount + targetY * blocksPerAxis + targetX;
      const targetIndex = nodeByChartBlock.get(targetKey);
      if (targetIndex !== undefined) connect(edges, nodes, nodeIndex, targetIndex, distance3(nodes[nodeIndex].worldCenter, nodes[targetIndex].worldCenter));
    }
  });
  for (const pair of splitMesh.seamPairs) {
    const nodeIndices = pair.sides.map((side) => nodeForSide(side, repack, nodeByChartBlock, blocksPerAxis, blockCount, blockTexels));
    if (nodeIndices.some((index) => index === undefined) || nodeIndices[0] === nodeIndices[1]) continue;
    const midpoint = [0, 1, 2].map((axis) => (
      splitMesh.positions[pair.sides[0].vertex0 * 3 + axis] + splitMesh.positions[pair.sides[0].vertex1 * 3 + axis]
    ) * 0.5);
    const weight = distance3(nodes[nodeIndices[0]].worldCenter, midpoint) + distance3(midpoint, nodes[nodeIndices[1]].worldCenter);
    connect(edges, nodes, nodeIndices[0], nodeIndices[1], weight);
  }
  return encodeGraph(nodes, edges, blocksPerAxis, blockTexels);
}

export function dijkstraBlockGraph(graph, sourceNode) {
  const distance = new Float64Array(graph.nodeCount).fill(Infinity);
  const visited = new Uint8Array(graph.nodeCount);
  distance[sourceNode] = 0;
  for (let iteration = 0; iteration < graph.nodeCount; iteration += 1) {
    let node = -1; let best = Infinity;
    for (let candidate = 0; candidate < graph.nodeCount; candidate += 1) {
      if (!visited[candidate] && distance[candidate] < best) { best = distance[candidate]; node = candidate; }
    }
    if (node < 0) break;
    visited[node] = 1;
    for (let edge = graph.offsets[node]; edge < graph.offsets[node + 1]; edge += 1) {
      const target = graph.targets[edge];
      distance[target] = Math.min(distance[target], distance[node] + graph.weights[edge]);
    }
  }
  return distance;
}

function nodeForSide(side, repack, nodeByChartBlock, blocksPerAxis, blockCount, blockTexels) {
  const u = (repack.uv1[side.vertex0 * 2] + repack.uv1[side.vertex1 * 2]) * 0.5;
  const v = (repack.uv1[side.vertex0 * 2 + 1] + repack.uv1[side.vertex1 * 2 + 1]) * 0.5;
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
    nodes: nodes.map(({ chartId, blockX, blockY, worldCenter, texelCount }) => ({ chartId, blockX, blockY, worldCenter, texelCount })),
    offsets,
    targets,
    weights,
    blocksPerAxis,
    blockTexels,
  };
}

function distance3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
