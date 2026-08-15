import { diffuseWithLedger } from '../src/atlas/fill.js';

export const MASS_DRIFT_RELATIVE_LIMIT = 0.005;
// The cone fixture peaks at 6.33% of its local seam-band mass on the first random-field step;
// 10% is the locked per-curve ceiling, kept separate from the much tighter global drift bar.
export const BAND_FLUX_RELATIVE_LIMIT = 0.1;
export const WRONG_TAP_RELATIVE_SENSITIVITY = 1e-6;

export function verifyDiffusionMass(repack, raster, boundaryIndex, stepCount = 100) {
  const atlas = {
    fieldSize: repack.fieldSize,
    authoritativeOwner: raster.authoritativeOwner,
    gutter: raster.gutter,
    chartTable: repack.chartTable,
  };
  let field = Float64Array.from(raster.authoritativeOwner, (owner, index) => (
    owner ? 0.55 + Math.sin(index * 12.9898 + 0.17) * 0.35 : 0
  ));
  const band = seamBand(atlas, boundaryIndex, repack.target.gutterTexels);
  const maximumRelativeFluxByGroup = new Float64Array(boundaryIndex.frameGroupCount);
  const maximumSignedFluxByGroup = new Float64Array(boundaryIndex.frameGroupCount);
  let maximumRelativeMassDrift = 0; let maximumLedgerResidual = 0;
  for (let step = 0; step < stepCount; step += 1) {
    const before = field;
    const result = diffuseWithLedger(before, atlas);
    const relativeDrift = Math.abs(result.ledger.seamFlux) / Math.max(1e-20, Math.abs(result.ledger.T_prev));
    maximumRelativeMassDrift = Math.max(maximumRelativeMassDrift, relativeDrift);
    maximumLedgerResidual = Math.max(maximumLedgerResidual, Math.abs(result.ledger.residual));
    accumulateBandFlux(before, result.field, atlas, band, maximumRelativeFluxByGroup, maximumSignedFluxByGroup);
    field = result.field;
  }

  const baseline = diffuseWithLedger(field, atlas);
  const wrongTap = diffuseWithLedger(field, atlas, { wrongTapOffset: 1 });
  const fault = compareBandFlux(field, baseline.field, wrongTap.field, atlas, band);
  const worstGroups = [...maximumRelativeFluxByGroup].map((relativeFlux, groupId) => ({
    groupId,
    relativeFlux,
    signedFlux: maximumSignedFluxByGroup[groupId],
  })).sort((left, right) => right.relativeFlux - left.relativeFlux).slice(0, 20);
  return {
    stepCount,
    bandTexelCount: band.texels.length,
    maximumRelativeMassDrift,
    maximumLedgerResidual,
    maximumRelativeBandFlux: maximum(maximumRelativeFluxByGroup),
    worstGroups,
    wrongTapGlobalFluxDelta: Math.abs(wrongTap.ledger.seamFlux - baseline.ledger.seamFlux),
    wrongTapMaximumRelativeBandDelta: fault.maximumRelativeDelta,
    wrongTapDetected: fault.maximumRelativeDelta > WRONG_TAP_RELATIVE_SENSITIVITY,
    massBoundPassed: maximumRelativeMassDrift < MASS_DRIFT_RELATIVE_LIMIT,
    bandBoundPassed: maximum(maximumRelativeFluxByGroup) < BAND_FLUX_RELATIVE_LIMIT,
  };
}

function seamBand(atlas, boundaryIndex, gutterTexels) {
  const texels = [];
  const groupIds = [];
  for (let texel = 0; texel < atlas.authoritativeOwner.length; texel += 1) {
    if (!atlas.authoritativeOwner[texel] || boundaryIndex.nearestDistanceTexels[texel] > gutterTexels) continue;
    const frameId = boundaryIndex.nearestFrame[texel];
    if (!frameId) continue;
    texels.push(texel); groupIds.push(boundaryIndex.frameGroupIds[frameId]);
  }
  return { texels: Uint32Array.from(texels), groupIds: Uint32Array.from(groupIds) };
}

function accumulateBandFlux(before, after, atlas, band, maximumRelative, maximumSigned) {
  const flux = new Float64Array(maximumRelative.length);
  const mass = new Float64Array(maximumRelative.length);
  for (let index = 0; index < band.texels.length; index += 1) {
    const texel = band.texels[index]; const group = band.groupIds[index];
    const area = atlas.chartTable[atlas.authoritativeOwner[texel] - 1].worldAreaPerTexel;
    flux[group] += (after[texel] - before[texel]) * area;
    mass[group] += Math.abs(before[texel]) * area;
  }
  for (let group = 0; group < flux.length; group += 1) {
    const relative = Math.abs(flux[group]) / Math.max(1e-20, mass[group]);
    if (relative > maximumRelative[group]) {
      maximumRelative[group] = relative;
      maximumSigned[group] = flux[group];
    }
  }
}

function compareBandFlux(before, baseline, wrong, atlas, band) {
  const baselineFlux = new Map(); const wrongFlux = new Map(); const mass = new Map();
  for (let index = 0; index < band.texels.length; index += 1) {
    const texel = band.texels[index]; const group = band.groupIds[index];
    const area = atlas.chartTable[atlas.authoritativeOwner[texel] - 1].worldAreaPerTexel;
    baselineFlux.set(group, (baselineFlux.get(group) ?? 0) + (baseline[texel] - before[texel]) * area);
    wrongFlux.set(group, (wrongFlux.get(group) ?? 0) + (wrong[texel] - before[texel]) * area);
    mass.set(group, (mass.get(group) ?? 0) + Math.abs(before[texel]) * area);
  }
  let maximumRelativeDelta = 0;
  for (const [group, scale] of mass) {
    maximumRelativeDelta = Math.max(
      maximumRelativeDelta,
      Math.abs((wrongFlux.get(group) ?? 0) - (baselineFlux.get(group) ?? 0)) / Math.max(1e-20, scale),
    );
  }
  return { maximumRelativeDelta };
}

function maximum(values) { let result = 0; for (const value of values) result = Math.max(result, value); return result; }
