import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { preprocessWgsl } from '../../src/gpu/wgsl.js';
import {
  AGENT_WORKGROUP_SIZE,
  FIELD_WORKGROUP_SIZE,
  MAX_OATS,
  OAT_SUPPORT_SIGMAS,
} from '../../src/sim/constants.js';
import { PARAM_WGSL_CONSTANTS } from '../../src/sim/params-layout.js';

const simUrl = new URL('../../src/sim/', import.meta.url);

test('every simulation shader preprocesses with the shared packing constants and a readable contract', async () => {
  const names = (await readdir(simUrl)).filter((name) => name.endsWith('.wgsl') && name !== 'common.wgsl');
  const common = await readFile(new URL('common.wgsl', simUrl), 'utf8');
  for (const name of names) {
    const source = await readFile(new URL(name, simUrl), 'utf8');
    for (const label of ['Inputs:', 'Output', 'Invariants:', 'Anchors:']) {
      assert.match(source.slice(0, 700), new RegExp(label), `${name} is missing ${label}`);
    }
    const expanded = await preprocessWgsl(source, {
      sourceName: name,
      constants: {
        ...PARAM_WGSL_CONSTANTS,
        AGENT_WORKGROUP_SIZE,
        FIELD_WORKGROUP_SIZE,
        MAX_OATS,
        OAT_SUPPORT_SIGMAS,
      },
      resolveInclude: (includeName) => includeName === 'common.wgsl' ? common : undefined,
    });
    assert.doesNotMatch(expanded, /\$\{/);
    assert.match(expanded, /struct SimulationParams/);
  }
});

test('simulation sources forbid scheduler-keyed randomness and automatic layouts', async () => {
  const names = await readdir(simUrl);
  const sources = await Promise.all(names
    .filter((name) => name.endsWith('.js') || name.endsWith('.wgsl'))
    .map((name) => readFile(new URL(name, simUrl), 'utf8')));
  const joined = sources.join('\n');
  assert.doesNotMatch(joined, /Math\.random\s*\(/);
  assert.doesNotMatch(joined, /layout\s*:\s*['"]auto['"]/);
  assert.match(joined, /createBindGroupLayout/);
});

test('pass graph pins legacy ordering and density sensing stays nearest', async () => {
  const passGraph = await readFile(new URL('pass-graph.js', simUrl), 'utf8');
  const order = [
    'crowd scatter',
    'advance surviving parents',
    'dynamic field diffuse and decay',
    'food exposure scatter',
    'apply food exposure delta',
  ].map((label) => passGraph.indexOf(label));
  assert.ok(order.every((position) => position >= 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const agents = await readFile(new URL('agents.wgsl', simUrl), 'utf8');
  assert.match(agents, /textureLoad\(field/);
  assert.doesNotMatch(agents, /textureSample/);
});

test('non-finite scan uses the portable IEEE-754 exponent test', async () => {
  const source = await readFile(new URL('state-hash.wgsl', simUrl), 'utf8');
  assert.match(source, /0x7f800000u/);
  assert.doesNotMatch(source, /\bis(?:Nan|Inf|Finite)\s*\(/);
});
