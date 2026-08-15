import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  PerspectiveCamera,
  Ray,
  Vector3,
} from '../../vendor/three.module.js';
import { OrbitControls } from '../../vendor/controls/OrbitControls.js';
import { MeshBVH } from '../../vendor/three-mesh-bvh.module.js';

test('vendored camera and controls construct without a DOM or renderer', () => {
  const camera = new PerspectiveCamera(42.8571, 4 / 3, 0.04, 1200);
  const documentStub = eventTargetStub();
  const elementStub = {
    ...eventTargetStub(),
    style: {},
    ownerDocument: documentStub,
    clientWidth: 800,
    clientHeight: 600,
    getRootNode: () => documentStub,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  const controls = new OrbitControls(camera, elementStub);
  assert.equal(camera.isPerspectiveCamera, true);
  assert.equal(controls.object, camera);
  controls.dispose();
});

test('vendored MeshBVH raycasts a two-triangle geometry', () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([
    -1, -1, 0,
    1, -1, 0,
    -1, 1, 0,
    1, 1, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  const bvh = new MeshBVH(geometry);
  const ray = new Ray(new Vector3(0, 0, 1), new Vector3(0, 0, -1));
  const hits = bvh.raycast(ray, DoubleSide);
  assert.ok(hits.length > 0);
  assert.ok(Math.abs(hits[0].point.z) < 1e-8);
  geometry.dispose();
});

function eventTargetStub() {
  return {
    addEventListener() {},
    removeEventListener() {},
  };
}
