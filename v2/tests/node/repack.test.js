import assert from 'node:assert/strict';
import test from 'node:test';
import { packMasks } from '../../tools/mask-packer.mjs';
import {
  dilateChebyshev,
  maskIntervals,
  rasterizeTriangleMask,
} from '../../tools/raster-masks.mjs';
import { proveClearance } from '../../tools/repack.mjs';

test('conservative rasterization includes texels touched only at an edge or corner', () => {
  const mask = rasterizeTriangleMask([[0.2, 0.2], [1.8, 0.2], [0.2, 1.8]], 3, 3);
  assert.equal(mask[0], 1);
  assert.equal(mask[1 * 3 + 1], 1, 'the triangle touches the lower-left corner of texel (1,1)');
  assert.equal(mask[2 * 3 + 2], 0);
});

test('closed Chebyshev dilation covers the full radius in both axes', () => {
  const source = new Uint8Array(25);
  source[2 * 5 + 2] = 1;
  const dilated = dilateChebyshev(source, 5, 5, 1);
  assert.equal(dilated.reduce((sum, value) => sum + value, 0), 9);
  assert.equal(dilated[1 * 5 + 1], 1);
  assert.equal(dilated[3 * 5 + 3], 1);
});

test('mask packer interlocks real mask rows and clearance has both proofs', () => {
  const masks = [makeMask(1, [
    '11100',
    '10100',
    '11100',
  ]), makeMask(2, [
    '11',
    '11',
  ])];
  const packed = packMasks(masks, 12);
  assert.equal(packed.occupiedCount, 12);
  const clearanceMasks = [makePaddedMask(1), makePaddedMask(2)];
  const clearancePacking = packMasks(clearanceMasks, 12);
  const proof = proveClearance(clearanceMasks, clearancePacking.placements, 12, 1);
  assert.ok(proof.minimumChebyshevDistance >= 3);
  assert.equal(proof.dilatedOwner.filter(Boolean).length, 18);
});

function makeMask(chartId, rows) {
  const width = rows[0].length;
  const height = rows.length;
  const dilated = Uint8Array.from(rows.join(''), (value) => Number(value));
  return {
    chart: { id: chartId },
    width,
    height,
    dilatedCount: dilated.reduce((sum, value) => sum + value, 0),
    dilatedRows: maskIntervals(dilated, width, height),
    authoritativeRows: maskIntervals(dilated, width, height),
  };
}

function makePaddedMask(chartId) {
  const dilated = Uint8Array.from('111111111', Number);
  const authoritative = Uint8Array.from('000010000', Number);
  return {
    chart: { id: chartId },
    width: 3,
    height: 3,
    dilatedCount: 9,
    dilatedRows: maskIntervals(dilated, 3, 3),
    authoritativeRows: maskIntervals(authoritative, 3, 3),
  };
}
