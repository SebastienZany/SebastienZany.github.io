// The Surface: the body as the slime and the game see it.
//
// It owns the mesh, answers "what is under this pixel" and "where is this
// atlas point in the world", and bakes the two atlas textures every shader that
// works in the atlas needs:
//
//   metric  rgb = E, F, G (see atlas.js): world distance of a uv step.
//           a   = world area of this texel relative to the atlas mean,
//                 and 0 where the texel is not on the body at all.
//   seam    the similarity (alphaRe, alphaIm, betaX, betaY) of the nearest cut:
//           uv -> alpha * uv + beta carries a point beyond that cut to where it
//           really is. Zeros mean "no way across from here".
//
// surface-glsl.js is the shader-side half of this file.

import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { measureAtlas, findSeamEdges, rasteriseSeamMaps } from './atlas.js';
import { SURFACE_GLSL } from './surface-glsl.js';

// How far from a cut, in texels of a 1536 atlas, the seam map is defined. It
// must exceed the longest reach of anything that samples across a cut (the
// organism's sensors, the display blur).
const SEAM_BAND_TEXELS_AT_1536 = 24;
const MIN_SEAM_BAND_TEXELS = 8;
// A point on the skin is not hidden by the skin it sits on: hits this close to it do not count.
const OCCLUSION_MARGIN_WORLD = 0.048;

const METRIC_VERTEX = /* glsl */ `
in vec2 a_atlasUv;
in vec4 a_metric;
out vec4 v_metric;
void main() {
  v_metric = a_metric;
  gl_Position = vec4(a_atlasUv * 2.0 - 1.0, 0.0, 1.0);
}
`;
const METRIC_FRAGMENT = /* glsl */ `
precision highp float;
in vec4 v_metric;
out vec4 outColor;
void main() { outColor = v_metric; }
`;
const PAD_FRAGMENT = /* glsl */ `
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_source;
${SURFACE_GLSL}
void main() {
  if (onSurface(v_uv)) {
    outColor = texture(u_source, v_uv);
    return;
  }
  vec2 across;
  outColor = seamImage(v_uv, v_uv, across) ? texture(u_source, across) : vec4(0.0);
}
`;

export function createSurface({ gpu, geometry, fieldSize, worldSize }) {
  const size = fieldSize;
  const atlas = measureAtlas(geometry);
  const seamEdges = findSeamEdges(geometry, atlas.faceUvArea);
  const bandTexels = Math.max(MIN_SEAM_BAND_TEXELS, Math.round(SEAM_BAND_TEXELS_AT_1536 * size / 1536));

  // --- the body mesh, with fast raycasts -----------------------------------
  // `indirect` leaves the index buffer in its original order: face numbers stay
  // those of the file, and the flattened atlas below can share the same index.
  geometry.boundsTree = new MeshBVH(geometry, { indirect: true });
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x000000 }));
  mesh.raycast = acceleratedRaycast;
  mesh.frustumCulled = false;
  mesh.updateMatrixWorld(true);

  // --- the atlas flattened into a mesh, for uv -> face lookups --------------
  const flat = new THREE.BufferGeometry();
  const uvArray = geometry.attributes.uv.array;
  const flatPositions = new Float32Array((uvArray.length / 2) * 3);
  for (let v = 0; v < uvArray.length / 2; v++) {
    flatPositions[v * 3] = uvArray[v * 2];
    flatPositions[v * 3 + 1] = uvArray[v * 2 + 1];
  }
  flat.setAttribute('position', new THREE.BufferAttribute(flatPositions, 3));
  flat.setIndex(geometry.index);
  const flatTree = new MeshBVH(flat, { indirect: true });

  // --- metric texture: draw every face into the atlas, flat-shaded ---------
  const metric = gpu.target(size, size, { type: 'float', filter: 'nearest', name: 'surface-metric' });
  {
    const index = geometry.index.array;
    const faceCount = index.length / 3;
    const meanAreaPerUv = atlas.worldPerUv * atlas.worldPerUv;
    const cornerUv = new Float32Array(faceCount * 6);
    const cornerMetric = new Float32Array(faceCount * 12);
    for (let face = 0; face < faceCount; face++) {
      const E = atlas.faceMetric[face * 3], F = atlas.faceMetric[face * 3 + 1], G = atlas.faceMetric[face * 3 + 2];
      const relativeArea = Math.max(Math.sqrt(Math.max(E * G - F * F, 0)) / meanAreaPerUv, 1e-6);
      for (let corner = 0; corner < 3; corner++) {
        const v = index[face * 3 + corner];
        cornerUv.set([uvArray[v * 2], uvArray[v * 2 + 1]], face * 6 + corner * 2);
        cornerMetric.set([E, F, G, relativeArea], face * 12 + corner * 4);
      }
    }
    const faces = new THREE.BufferGeometry();
    faces.setAttribute('a_atlasUv', new THREE.BufferAttribute(cornerUv, 2));
    faces.setAttribute('a_metric', new THREE.BufferAttribute(cornerMetric, 4));
    // three.js sizes draw calls from `position`; give it one.
    faces.setAttribute('position', new THREE.BufferAttribute(new Float32Array(faceCount * 9), 3));
    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: METRIC_VERTEX,
      fragmentShader: METRIC_FRAGMENT,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    const bakeMesh = new THREE.Mesh(faces, material);
    bakeMesh.frustumCulled = false;
    const bakeScene = new THREE.Scene();
    bakeScene.add(bakeMesh);
    gpu.draw(bakeScene, metric);
    faces.dispose();
    material.dispose();
  }

  // A CPU copy of "is this texel on the body", for validating points without a readback.
  const onBody = new Uint8Array(size * size);
  {
    const texels = gpu.readFloats(metric);
    for (let i = 0; i < onBody.length; i++) onBody[i] = texels[i * 4 + 3] > 0 ? 1 : 0;
  }

  // --- seam texture ---------------------------------------------------------
  const seam = new THREE.DataTexture(
    rasteriseSeamMaps(seamEdges, size, bandTexels), size, size, THREE.RGBAFormat, THREE.FloatType,
  );
  seam.minFilter = THREE.NearestFilter;
  seam.magFilter = THREE.NearestFilter;
  seam.needsUpdate = true;

  const uniforms = () => ({ u_surfaceMetric: metric.texture, u_surfaceSeam: seam });
  const padMaterial = gpu.material(PAD_FRAGMENT, { u_source: null, ...uniforms() });

  // --- queries --------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  const flatRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
  const scratch = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), bary: new THREE.Vector3() };

  /** The face under an atlas point and the point's barycentric weights in it, or null. */
  function locate(uv) {
    flatRay.origin.set(uv.x, uv.y, 1);
    const hit = flatTree.raycastFirst(flatRay, THREE.DoubleSide);
    if (!hit) return null;
    const { a, b, c } = hit.face;
    scratch.a.fromArray(flatPositions, a * 3);
    scratch.b.fromArray(flatPositions, b * 3);
    scratch.c.fromArray(flatPositions, c * 3);
    THREE.Triangle.getBarycoord(hit.point, scratch.a, scratch.b, scratch.c, scratch.bary);
    return { a, b, c, faceIndex: hit.faceIndex, weights: scratch.bary };
  }

  function blend(attribute, { a, b, c, weights }, target) {
    target.set(0, 0, 0);
    target.addScaledVector(scratch.a.fromBufferAttribute(attribute, a), weights.x);
    target.addScaledVector(scratch.b.fromBufferAttribute(attribute, b), weights.y);
    target.addScaledVector(scratch.c.fromBufferAttribute(attribute, c), weights.z);
    return target;
  }

  return {
    mesh,
    geometry,
    fieldSize: size,
    worldSize,
    /** Mean world length of one atlas unit, and of one texel. */
    worldPerUv: atlas.worldPerUv,
    texelWorld: atlas.worldPerUv / size,
    textures: { metric: metric.texture, seam },
    /** Uniform values every shader that includes SURFACE_GLSL needs. */
    uniforms,
    stats: {
      worldArea: atlas.worldArea,
      uvArea: atlas.uvArea,
      seamEdges: seamEdges.filter((edge) => edge.paired).length,
      wallEdges: seamEdges.filter((edge) => !edge.paired).length,
      bodyTexels: onBody.reduce((sum, value) => sum + value, 0),
    },

    /** Copy `sourceTexture` into `target`, filling texels just off the body from across the nearest cut. */
    pad(sourceTexture, target) {
      padMaterial.uniforms.u_source.value = sourceTexture;
      gpu.run(padMaterial, target);
    },

    /** Is this atlas point on a texel the slime can occupy? */
    isOnBody(uv) {
      if (!(uv.x >= 0 && uv.x < 1 && uv.y >= 0 && uv.y < 1)) return false;
      return onBody[Math.floor(uv.y * size) * size + Math.floor(uv.x * size)] === 1;
    },

    /** World position (and optionally normal) of an atlas point, or null if it is off the body. */
    uvToWorld(uv, target = new THREE.Vector3(), normalTarget = null) {
      const where = locate(uv);
      if (!where) return null;
      if (normalTarget) blend(geometry.attributes.normal, where, normalTarget).normalize();
      return blend(geometry.attributes.position, where, target);
    },

    /** World distance covered by the atlas step from `uv` to `otherUv`, measured with the metric at `uv`. */
    worldDistance(uv, otherUv) {
      const where = locate(uv);
      if (!where) return Infinity;
      const E = atlas.faceMetric[where.faceIndex * 3], F = atlas.faceMetric[where.faceIndex * 3 + 1], G = atlas.faceMetric[where.faceIndex * 3 + 2];
      const du = otherUv.x - uv.x, dv = otherUv.y - uv.y;
      return Math.sqrt(Math.max(E * du * du + 2 * F * du * dv + G * dv * dv, 0));
    },

    /** What the camera sees at a screen position (normalised device coordinates), or null. */
    raycast(ndc, camera) {
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObject(mesh, false)[0];
      if (!hit?.uv) return null;
      return {
        uv: { x: hit.uv.x, y: hit.uv.y },
        point: hit.point.clone(),
        normal: hit.face.normal.clone().transformDirection(mesh.matrixWorld),
      };
    },

    /** Does the body block the straight line from `from` to `point` (a point on its surface)? */
    isOccluded(from, point) {
      const direction = scratch.a.copy(point).sub(from);
      const distance = direction.length();
      if (distance < 1e-6) return false;
      raycaster.set(from, direction.multiplyScalar(1 / distance));
      const hit = raycaster.intersectObject(mesh, false)[0];
      // The target itself is a hit at `distance`; anything clearly nearer is in the way.
      return Boolean(hit) && hit.distance < distance - OCCLUSION_MARGIN_WORLD;
    },

    dispose() {
      metric.dispose();
      seam.dispose();
      padMaterial.dispose();
      flat.dispose();
      mesh.material.dispose();
    },
  };
}
