import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preprocessWgsl } from '../../src/gpu/wgsl.js';

const renderDirectory = fileURLToPath(new URL('../../src/render/', import.meta.url));
const shaderNames = [
  'display-history.wgsl',
  'max-food-history.wgsl',
  'sample-view.wgsl',
  'slime.wgsl',
  'gold.wgsl',
];

test('F2 WGSL sources preprocess and retain readable kernel contracts', async () => {
  for (const shaderName of shaderNames) {
    const sourcePath = resolve(renderDirectory, shaderName);
    const source = await readFile(sourcePath, 'utf8');
    assert.match(source, /^\/\/ .+\(F2 material-look lane/);
    const expanded = await preprocessWgsl(source, {
      sourceName: sourcePath,
      resolveInclude: async (includePath, parentPath) => {
        const includedPath = resolve(dirname(parentPath), includePath);
        return { source: await readFile(includedPath, 'utf8'), sourceName: includedPath };
      },
    });
    assert.doesNotMatch(expanded, /\/\/#include|\$\{/);
    assertNoMixedBitwiseArithmetic(expanded, shaderName);
  }
});

test('material shaders preserve F2 sampling and layering contracts statically', async () => {
  const slime = await expandedShader('slime.wgsl');
  const gold = await expandedShader('gold.wgsl');
  const maximum = await expandedShader('max-food-history.wgsl');
  assert.match(slime, /upperLeft[\s\S]+upperRight[\s\S]+lowerLeft[\s\S]+lowerRight/);
  assert.match(slime, /surface\.lightRig\.z > 0\.5/);
  assert.match(slime, /microfacetSpecular/);
  assert.match(slime, /outputAlpha/);
  assert.equal((gold.match(/textureSample\(goldResponseLut/g) || []).length, 1);
  assert.match(gold, /goldBodyFilmThicknessNm\(rememberedFood\)/);
  assert.match(maximum, /max\(currentValue, rememberedValue\)/);
});

async function expandedShader(shaderName) {
  const sourcePath = resolve(renderDirectory, shaderName);
  return preprocessWgsl(await readFile(sourcePath, 'utf8'), {
    sourceName: sourcePath,
    resolveInclude: async (includePath, parentPath) => {
      const includedPath = resolve(dirname(parentPath), includePath);
      return { source: await readFile(includedPath, 'utf8'), sourceName: includedPath };
    },
  });
}

function assertNoMixedBitwiseArithmetic(source, shaderName) {
  const bitwise = /\^|(^|[^&])&(?!&)|(^|[^|])\|(?!\|)/;
  const arithmetic = /[+*/%]|(^|[^-])->|-(?!>)/;
  for (const [lineIndex, line] of source.split('\n').entries()) {
    if (bitwise.test(line) && arithmetic.test(line)) {
      assert.fail(`${shaderName}:${lineIndex + 1} mixes bitwise and arithmetic operators: ${line.trim()}`);
    }
  }
}
