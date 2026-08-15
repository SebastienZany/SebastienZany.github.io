import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTargetSectionInputs } from '../../tools/atlas-sections.mjs';

test('section emission refuses a target containing signed degraded donors', () => {
  assert.throws(() => buildTargetSectionInputs({}, {
    repack: { fieldSize: 32 },
    raster: { gutter: { deploymentBlocked: true, census: { signedDegraded: 7 } } },
  }), /7 signed donor stencils/);
});
