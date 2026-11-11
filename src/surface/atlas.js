// CPU analysis of the body's UV atlas.
//
// The slime lives in the atlas, so two facts about the unwrap have to be known
// everywhere: how big a piece of skin each bit of the atlas covers (the
// "metric"), and what lies across each cut (the "seams"). This file measures
// both from the mesh. Nothing here touches the GPU.

/**
 * Per-face metric: for a small uv step (du, dv) on a face, the world distance
 * covered is sqrt(E du^2 + 2F du dv + G dv^2). E, F, G are the dot products of
 * the face's dWorld/du and dWorld/dv.
 *
 * @returns {{
 *   faceMetric: Float32Array,      // E, F, G per face (0,0,0 for faces with no uv area)
 *   faceUvArea: Float32Array,      // signed; negative means the face is mirrored in the atlas
 *   worldArea: number, uvArea: number,
 *   worldPerUv: number,            // mean world length of one atlas unit
 * }}
 */
export function measureAtlas(geometry) {
  const position = geometry.attributes.position.array;
  const uv = geometry.attributes.uv.array;
  const index = geometry.index.array;
  const faceCount = index.length / 3;
  const faceMetric = new Float32Array(faceCount * 3);
  const faceUvArea = new Float32Array(faceCount);
  let worldArea = 0;
  let uvArea = 0;

  for (let face = 0; face < faceCount; face++) {
    const a = index[face * 3], b = index[face * 3 + 1], c = index[face * 3 + 2];
    const e1x = position[b * 3] - position[a * 3], e1y = position[b * 3 + 1] - position[a * 3 + 1], e1z = position[b * 3 + 2] - position[a * 3 + 2];
    const e2x = position[c * 3] - position[a * 3], e2y = position[c * 3 + 1] - position[a * 3 + 1], e2z = position[c * 3 + 2] - position[a * 3 + 2];
    const du1 = uv[b * 2] - uv[a * 2], dv1 = uv[b * 2 + 1] - uv[a * 2 + 1];
    const du2 = uv[c * 2] - uv[a * 2], dv2 = uv[c * 2 + 1] - uv[a * 2 + 1];

    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    const faceWorldArea = 0.5 * Math.hypot(cx, cy, cz);
    const det = du1 * dv2 - du2 * dv1;
    faceUvArea[face] = 0.5 * det;
    worldArea += faceWorldArea;
    uvArea += Math.abs(0.5 * det);
    if (Math.abs(det) < 1e-14) continue;

    // Solve [e1 e2] = J [duv1 duv2] for J's columns dWorld/du and dWorld/dv.
    const ux = (e1x * dv2 - e2x * dv1) / det, uy = (e1y * dv2 - e2y * dv1) / det, uz = (e1z * dv2 - e2z * dv1) / det;
    const vx = (e2x * du1 - e1x * du2) / det, vy = (e2y * du1 - e1y * du2) / det, vz = (e2z * du1 - e1z * du2) / det;
    faceMetric[face * 3] = ux * ux + uy * uy + uz * uz;
    faceMetric[face * 3 + 1] = ux * vx + uy * vy + uz * vz;
    faceMetric[face * 3 + 2] = vx * vx + vy * vy + vz * vz;
  }
  return { faceMetric, faceUvArea, worldArea, uvArea, worldPerUv: Math.sqrt(worldArea / uvArea) };
}

/**
 * Finds the edges where the atlas is cut and, for each, the map that carries a
 * point just beyond the edge to where that point really is on the body.
 *
 * Two triangles that share an edge on the body but not in the atlas meet at a
 * seam. Seen from one side, the far side is the near side's edge moved, turned
 * and scaled, so the map is a similarity: z -> alpha * z + beta, with uv points
 * read as complex numbers. An edge with nothing on the far side (a hole in the
 * mesh) is a wall.
 *
 * @returns {Array<{ ax, ay, bx, by, alphaRe, alphaIm, betaX, betaY, paired: boolean }>}
 *   one entry per boundary edge, endpoints in uv.
 */
export function findSeamEdges(geometry, faceUvArea) {
  const position = geometry.attributes.position.array;
  const uv = geometry.attributes.uv.array;
  const index = geometry.index.array;
  const vertexCount = geometry.attributes.position.count;

  // Vertices are duplicated along seams; weld them by position to recognise
  // the two sides of a cut as the same place.
  const weldIds = new Map();
  const weld = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const key = `${position[v * 3]},${position[v * 3 + 1]},${position[v * 3 + 2]}`;
    let id = weldIds.get(key);
    if (id === undefined) {
      id = weldIds.size;
      weldIds.set(key, id);
    }
    weld[v] = id;
  }

  // An edge a->b belongs to the atlas interior when some other face runs b->a.
  const directed = new Map();
  const edgeKey = (a, b) => a * vertexCount + b;
  for (let i = 0; i < index.length; i += 3) {
    const face = i / 3;
    for (let side = 0; side < 3; side++) {
      directed.set(edgeKey(index[i + side], index[i + (side + 1) % 3]), face);
    }
  }
  const boundary = [];
  for (const [key, face] of directed) {
    const a = Math.floor(key / vertexCount);
    const b = key - a * vertexCount;
    if (!directed.has(edgeKey(b, a))) boundary.push({ a, b, face });
  }

  // Which way round most faces are wound in the atlas (it depends on the file
  // format's v axis, not on the mesh).
  let signedArea = 0;
  for (const area of faceUvArea) signedArea += area;
  const winding = Math.sign(signedArea) || 1;

  // The far side of a cut runs between the same two welded points, in the
  // opposite direction.
  const byWeldedEnds = new Map();
  for (const edge of boundary) byWeldedEnds.set(`${weld[edge.a]}:${weld[edge.b]}`, edge);

  return boundary.map((edge) => {
    const ax = uv[edge.a * 2], ay = uv[edge.a * 2 + 1];
    const bx = uv[edge.b * 2], by = uv[edge.b * 2 + 1];
    const wall = { ax, ay, bx, by, alphaRe: 0, alphaIm: 0, betaX: 0, betaY: 0, paired: false };
    const twin = byWeldedEnds.get(`${weld[edge.b]}:${weld[edge.a]}`);
    // A face wound the other way from the rest of the atlas is mirrored. The
    // map below would send "just outside" such a face to "just outside" the
    // far side too, so its edges are walls rather than ways off the body.
    const mirrored = (face) => faceUvArea[face] * winding <= 0;
    if (!twin || twin === edge || mirrored(edge.face) || mirrored(twin.face)) return wall;

    // The twin runs k->l with k at b's place and l at a's place: a -> l, b -> k.
    const lx = uv[twin.b * 2], ly = uv[twin.b * 2 + 1];
    const kx = uv[twin.a * 2], ky = uv[twin.a * 2 + 1];
    const ex = bx - ax, ey = by - ay;
    const fx = kx - lx, fy = ky - ly;
    const lengthSq = ex * ex + ey * ey;
    if (lengthSq < 1e-20) return wall;
    const alphaRe = (fx * ex + fy * ey) / lengthSq;
    const alphaIm = (fy * ex - fx * ey) / lengthSq;
    return {
      ax, ay, bx, by, alphaRe, alphaIm,
      betaX: lx - (alphaRe * ax - alphaIm * ay),
      betaY: ly - (alphaIm * ax + alphaRe * ay),
      paired: true,
    };
  });
}

/**
 * Paints each atlas texel within `bandTexels` of a boundary edge with the map
 * of its nearest edge: (alphaRe, alphaIm, betaX, betaY), or zeros for a wall
 * and for texels far from any edge.
 */
export function rasteriseSeamMaps(edges, size, bandTexels) {
  const maps = new Float32Array(size * size * 4);
  const nearest = new Float32Array(size * size).fill(Infinity);
  for (const edge of edges) {
    const ax = edge.ax * size, ay = edge.ay * size, bx = edge.bx * size, by = edge.by * size;
    const ex = bx - ax, ey = by - ay;
    const lengthSq = Math.max(ex * ex + ey * ey, 1e-12);
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - bandTexels));
    const x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + bandTexels));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - bandTexels));
    const y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by) + bandTexels));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - ax, py = y + 0.5 - ay;
        const t = Math.min(1, Math.max(0, (px * ex + py * ey) / lengthSq));
        const distance = Math.hypot(px - ex * t, py - ey * t);
        const texel = y * size + x;
        if (distance > bandTexels || distance >= nearest[texel]) continue;
        nearest[texel] = distance;
        maps[texel * 4] = edge.alphaRe;
        maps[texel * 4 + 1] = edge.alphaIm;
        maps[texel * 4 + 2] = edge.betaX;
        maps[texel * 4 + 3] = edge.betaY;
      }
    }
  }
  return maps;
}
