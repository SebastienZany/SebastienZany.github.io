import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const GAME_MODULES = ['panel.js', 'stats.js', 'hotkeys.js'];

test('U1 modules stay readable and independent of GPU and simulation code', async () => {
  for (const fileName of GAME_MODULES) {
    const source = await readFile(new URL(`../../src/game/${fileName}`, import.meta.url), 'utf8');
    assert.ok(source.split('\n').length - 1 <= 400, `${fileName} exceeds 400 lines`);
    assert.doesNotMatch(source, /from ['"]\.\.\/(?:gpu|sim)\//, `${fileName} imports a forbidden runtime lane`);
  }
});

test('panel harness is standalone DOM with its own dark-glass stylesheet', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../../panel.html', import.meta.url), 'utf8'),
    readFile(new URL('../../panel.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="app" data-panels-visible="true"/);
  assert.match(html, /src="src\/game\/panel-harness\.js"/);
  assert.match(html, /href="panel\.css"/);
  assert.doesNotMatch(html, /styles\.css/);
  assert.match(css, /width: min\(460px,/);
  assert.match(css, /backdrop-filter: blur\(/);
  assert.match(css, /min-width: 64px/);
  assert.match(css, /min-height: 64px/);
});
