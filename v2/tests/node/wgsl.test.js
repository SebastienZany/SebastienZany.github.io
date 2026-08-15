import assert from 'node:assert/strict';
import test from 'node:test';
import { preprocessWgsl } from '../../src/gpu/wgsl.js';

test('WGSL preprocessor expands nested includes', async () => {
  const files = new Map([
    ['math.wgsl', '//#include "constants.wgsl"\nfn twice(v: f32) -> f32 { return v * TWO; }'],
    ['constants.wgsl', 'const TWO = 2.0;'],
  ]);
  const result = await preprocessWgsl('//#include "math.wgsl"\n@compute fn main() {}', {
    resolveInclude: (name) => files.get(name),
  });
  assert.match(result, /const TWO = 2\.0;/);
  assert.match(result, /fn twice/);
});

test('WGSL preprocessor injects constants from a plain object', async () => {
  const source = await preprocessWgsl('const WG = ${WORKGROUP_SIZE};\nconst ENABLED = ${ENABLED};', {
    constants: { WORKGROUP_SIZE: 64, ENABLED: true },
  });
  assert.equal(source, 'const WG = 64;\nconst ENABLED = true;');
});

test('WGSL preprocessor reports a missing include with its parent', async () => {
  await assert.rejects(
    preprocessWgsl('//#include "absent.wgsl"', {
      sourceName: 'entry.wgsl',
      resolveInclude: () => undefined,
    }),
    /Missing WGSL include "absent\.wgsl" from entry\.wgsl/,
  );
});
