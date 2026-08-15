const UINT32_RANGE = 0x1_0000_0000;

/** PCG RXS-M-XS hash, expressed only with u32 operations shared by JS and WGSL. */
export function pcgHash32(input) {
  const state = (Math.imul(input >>> 0, 747_796_405) + 2_891_336_453) >>> 0;
  const shift = ((state >>> 28) + 4) >>> 0;
  const word = Math.imul(((state >>> shift) ^ state) >>> 0, 277_803_737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

export function rotateLeft32(value, shift) {
  const amount = shift & 31;
  return ((value << amount) | (value >>> ((32 - amount) & 31))) >>> 0;
}

/** Counter RNG keyed by persistent id, step, and a named stream number. */
export function counterRandomU32(idLo, idHi, stepIndex, streamId) {
  const loLane = pcgHash32((idLo
    ^ Math.imul(stepIndex >>> 0, 0x9e37_79b9)
    ^ Math.imul(streamId >>> 0, 0x85eb_ca6b)) >>> 0);
  const hiLane = pcgHash32((idHi
    ^ Math.imul(stepIndex >>> 0, 0x7f4a_7c15)
    ^ Math.imul(streamId >>> 0, 0xc2b2_ae35)) >>> 0);
  return pcgHash32((loLane ^ rotateLeft32(hiLane, 16)) >>> 0);
}

export function counterRandomFloat(idLo, idHi, stepIndex, streamId) {
  return (counterRandomU32(idLo, idHi, stepIndex, streamId) >>> 8) / 0x1_000000;
}

/** Child identity is independent of append order and storage slots. */
export function childId64(parentLo, parentHi, stepIndex, childIndex) {
  const childKey = Math.imul((childIndex + 1) >>> 0, 0xd1b5_4a35) >>> 0;
  const stepLo = Math.imul(stepIndex >>> 0, 0x9e37_79b9) >>> 0;
  const stepHi = Math.imul(stepIndex >>> 0, 0x7f4a_7c15) >>> 0;
  return {
    lo: pcgHash32((parentLo ^ rotateLeft32(parentHi, 13) ^ stepLo ^ childKey) >>> 0),
    hi: pcgHash32((parentHi ^ rotateLeft32(parentLo, 7) ^ stepHi ^ rotateLeft32(childKey, 11)) >>> 0),
  };
}

/** Small seeded CPU stream used only to construct initial agents and their ids. */
export function createSeedStream(seed) {
  let state = pcgHash32(seed >>> 0);
  return {
    nextU32() {
      state = (Math.imul(state, 747_796_405) + 2_891_336_453) >>> 0;
      return pcgHash32(state);
    },
    nextFloat() {
      return this.nextU32() / UINT32_RANGE;
    },
  };
}
