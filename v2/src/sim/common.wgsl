// Shared simulation ABI and deterministic helpers.
// Inputs: binding 0 Params UBO, packed by params-layout.js.
// Units: positions are UV-space; field addresses are texel-space.
// Invariants: Agent array stride is 32 B; RNG keys never contain a storage slot.
// Anchors: M3 fixes 3/5 and PLAN §2 formats.

struct Agent {
  uvPos: vec2<f32>,
  heading: f32,
  reserve: f32,
  idLo: u32,
  idHi: u32,
  flags: u32,
  padding: u32,
}

struct AtomicCount { value: atomic<u32> }
struct PlainCount { value: u32 }
// u32 lanes preserve every host bit pattern; float parameters are explicitly
// reinterpreted. This avoids routing a large stepIndex through a NaN f32 value.
struct SimulationParams { slots: array<vec4<u32>, ${PARAM_SLOT_COUNT}> }

@group(0) @binding(0) var<uniform> parameters: SimulationParams;

fn parameterFloat(slot: u32, lane: u32) -> f32 {
  return bitcast<f32>(parameters.slots[slot][lane]);
}

fn parameterUint(slot: u32, lane: u32) -> u32 {
  return parameters.slots[slot][lane];
}

fn fieldSize() -> u32 { return parameterUint(${PARAM_SLOT_FRAME}u, 0u); }
fn capacity() -> u32 { return parameterUint(${PARAM_SLOT_FRAME}u, 1u); }
fn stepIndex() -> u32 { return parameterUint(${PARAM_SLOT_FRAME}u, 2u); }
fn parameterFlags() -> u32 { return parameterUint(${PARAM_SLOT_FRAME}u, 3u); }
fn flagEnabled(flag: u32) -> bool { return (parameterFlags() & flag) != 0u; }

fn wrapUv(uvPos: vec2<f32>) -> vec2<f32> {
  return fract(uvPos);
}

fn wrapTexel(texelPos: vec2<i32>) -> vec2<i32> {
  let size = i32(fieldSize());
  return ((texelPos % vec2<i32>(size)) + vec2<i32>(size)) % vec2<i32>(size);
}

fn texelFromUv(uvPos: vec2<f32>) -> vec2<i32> {
  return vec2<i32>(floor(wrapUv(uvPos) * f32(fieldSize())));
}

fn rotateLeft32(value: u32, shift: u32) -> u32 {
  return (value << shift) | (value >> (32u - shift));
}

fn pcgHash32(input: u32) -> u32 {
  let state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn counterRandom(idLo: u32, idHi: u32, streamId: u32) -> f32 {
  // Keep the 64-bit identity in two lanes until the final output mix. Folding
  // idLo/idHi first would give colliding identities the same entire RNG stream.
  let loLane = pcgHash32(idLo ^ (stepIndex() * 0x9e3779b9u) ^ (streamId * 0x85ebca6bu));
  let hiLane = pcgHash32(idHi ^ (stepIndex() * 0x7f4a7c15u) ^ (streamId * 0xc2b2ae35u));
  let randomBits = pcgHash32(loLane ^ rotateLeft32(hiLane, 16u));
  return f32(randomBits >> 8u) * (1.0 / 16777216.0);
}

fn childIdentity(parent: Agent, childIndex: u32) -> vec2<u32> {
  let childKey = (childIndex + 1u) * 0xd1b54a35u;
  let lo = pcgHash32(parent.idLo ^ rotateLeft32(parent.idHi, 13u)
    ^ (stepIndex() * 0x9e3779b9u) ^ childKey);
  let hi = pcgHash32(parent.idHi ^ rotateLeft32(parent.idLo, 7u)
    ^ (stepIndex() * 0x7f4a7c15u) ^ rotateLeft32(childKey, 11u));
  return vec2<u32>(lo, hi);
}

fn roundedFixedPoint(amount: f32, scale: f32) -> u32 {
  return u32(floor(max(amount, 0.0) * scale + 0.5));
}
