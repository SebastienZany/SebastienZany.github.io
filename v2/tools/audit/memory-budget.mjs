// Memory-budget calculator referenced by PLAN §2 (hand addition failed twice; scripts don't).
const MB = (b) => b / 2 ** 20;
function total(N, mapsF16, displayRGBA16F) {
  const T = N * N, A = (N / 2) ** 2;
  const rows = {
    fieldOatDensityPingPong: 3 * 2 * T * 4,   // r32f x2 each: food, oat, density
    depositExposureI32: 2 * T * 4,
    agents: 2 * A * 32,
    worldPosTangentMaps: T * (mapsF16 ? 16 : 32),
    ownershipAndBoundaryIndex: 2 * T * 4,
    // r32float EMA history (legacy desktop parity) + 16-bit sample view(s) + r16f max-food history
    displayHistoryR32F: T * 4,
    displaySampleViews: displayRGBA16F ? 2 * T * 8 : 2 * T * 2,
    maxFoodHistory: T * 2,
    // Measured gutter fractions (dilated demand minus authoritative occupancy; mesh-audit):
    // ~30% of texels at 1536, ~47% at 1024. Stencil donor record: 4 taps x (u32 idx + u16 w) = 24B.
    // NOTE: fractions are pre-split texel-center lower bounds; the bake re-measures post-split
    gutterTables: T * (N >= 1536 ? 0.30 : 0.47) * 28,
  };
  const fixed = { meshBuffers: 15e6, framesCorners: 6e6, lutMisc: 2e6, staging: 10e6 };
  // Load-time transient peak (compressed + inflated + upload staging coexist briefly):
  const transientLoadPeak = T * (N >= 1536 ? 0.30 : 0.47) * 24 * 2.5;
  const sum = [...Object.values(rows), ...Object.values(fixed)].reduce((a, b) => a + b, 0);
  return { rows, fixed, sum, transientLoadPeak };
}
for (const [N, tag] of [[1536, 'desktop'], [1024, 'mobile']]) {
  for (const f16 of [false, true]) for (const rgba of [false, true]) {
    const t = total(N, f16, rgba);
    console.log(`${N} ${tag} mapsF16=${f16} displayRGBA16F=${rgba}: ${MB(t.sum).toFixed(0)} MB steady (+ canvas depth/swapchain; load peak +${MB(t.transientLoadPeak).toFixed(0)} MB transient)`);
  }
}
const d = total(1536, false, false);
console.log('detail 1536 f32/r16f:', Object.fromEntries(Object.entries(d.rows).map(([k, v]) => [k, MB(v).toFixed(1) + 'MB'])));
