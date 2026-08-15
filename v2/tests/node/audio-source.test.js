import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { CLIPS } from '../../src/audio/clips.js';

const AUDIO_MODULES = [
  'audio-param.js',
  'buffer-store.js',
  'clips.js',
  'clip-settings.js',
  'engine.js',
  'one-shots.js',
  'platform.js',
  'schedulers.js',
  'spatial.js',
  'timestamp.js',
  'voice-pool.js',
];

test('audio modules use the injected clock and contain no DOM or GPU dependencies', async () => {
  for (const moduleName of AUDIO_MODULES) {
    const source = await readFile(new URL(`../../src/audio/${moduleName}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /performance\.now\s*\(|Date\.now\s*\(/, moduleName);
    assert.doesNotMatch(source, /\b(?:window|document)\s*\./, moduleName);
    assert.doesNotMatch(source, /navigator\.gpu|GPUDevice|\.wgsl\b/, moduleName);
  }
});

test('every shipped clip resolves to a real sound-pack file or the expected env fallback', async () => {
  const soundPage = new URL('../../sound.html', import.meta.url);
  for (const clip of CLIPS) {
    const path = clip.id === 'env' ? clip.fallbackPath : clip.path;
    await access(new URL(path, soundPage));
  }
});

test('sound check exposes graph state and builds all rows from the clip table', async () => {
  const source = await readFile(new URL('../../sound.html', import.meta.url), 'utf8');
  assert.match(source, /for \(const clip of CLIPS\)/);
  assert.match(source, /window\.__v2\.audio/);
  assert.match(source, /getState: engine\.getState/);
  assert.match(source, /dataset\.compressorParam/);
});
