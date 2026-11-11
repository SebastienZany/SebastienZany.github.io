// Loads the body mesh and normalises it: centred on the origin, longest side
// `worldSize` units long. Everything downstream (camera distances, light
// radius, the organism's speeds) is authored against that size.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * The geometry must carry `uv` (the simulation atlas). `uv1`, when present, is
 * the UV set the sculpt's normal map was baked against.
 * Node transforms in the file are ignored on purpose: the vertices themselves
 * must already be in the pose the game shows.
 */
export async function loadBodyGeometry(url, { worldSize, onProgress } = {}) {
  const gltf = await new GLTFLoader().loadAsync(url, (event) => {
    if (onProgress && event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
  });

  let source = null;
  gltf.scene.traverse((object) => {
    if (!source && object.isMesh) source = object;
  });
  if (!source) throw new Error(`${url} contains no mesh.`);

  const geometry = source.geometry;
  if (!geometry.attributes.uv) throw new Error(`${url} has no UV coordinates; the slime needs an atlas to live in.`);
  if (!geometry.index) {
    const count = geometry.attributes.position.count;
    geometry.setIndex(Array.from({ length: count }, (_, i) => i));
  }
  if (!geometry.attributes.normal) geometry.computeVertexNormals();

  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const scale = worldSize / Math.max(size.x, size.y, size.z);
  geometry.translate(-centre.x, -centre.y, -centre.z);
  geometry.scale(scale, scale, scale);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // The file's own material and textures are never used.
  for (const material of [].concat(source.material ?? [])) {
    for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
    material.dispose?.();
  }
  return geometry;
}
