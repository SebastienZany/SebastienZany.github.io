// A stand-in for 'three' so smoke-test.mjs can run under plain Node (the real
// one comes from the browser's import map). Only what the flow touches.
// The fake camera is the simplest possible: NDC = world / 10 on every axis,
// camera-up = world +y.

const VIEW_HALF_EXTENT_WORLD = 10;

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s) { return this.set(s, s, s); }
  clone() { return new Vector3(this.x, this.y, this.z); }
  copy(v) { return this.set(v.x, v.y, v.z); }
  add(v) { return this.set(this.x + v.x, this.y + v.y, this.z + v.z); }
  addScaledVector(v, s) { return this.set(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s); }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  normalize() {
    const length = Math.sqrt(this.lengthSq()) || 1;
    return this.set(this.x / length, this.y / length, this.z / length);
  }
  lerpVectors(a, b, t) {
    return this.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  }
  project() { return this.set(this.x / VIEW_HALF_EXTENT_WORLD, this.y / VIEW_HALF_EXTENT_WORLD, this.z / VIEW_HALF_EXTENT_WORLD); }
  unproject() { return this.set(this.x * VIEW_HALF_EXTENT_WORLD, this.y * VIEW_HALF_EXTENT_WORLD, this.z * VIEW_HALF_EXTENT_WORLD); }
  setFromMatrixColumn() { return this.set(0, 1, 0); }
}

export class SpriteMaterial {
  constructor(options) { Object.assign(this, options); this.disposed = false; }
  dispose() { this.disposed = true; }
}

export class Sprite {
  constructor(material) {
    this.material = material;
    this.position = new Vector3();
    this.scale = new Vector3(1, 1, 1);
    this.renderOrder = 0;
  }
}

export class CanvasTexture {
  constructor(canvas) { this.image = canvas; }
  dispose() {}
}

export const AdditiveBlending = 'AdditiveBlending';
export const ClampToEdgeWrapping = 'ClampToEdgeWrapping';
export const LinearFilter = 'LinearFilter';
export const SRGBColorSpace = 'srgb';
