// Smoke test for the DOM-free parts of the story system.
// Run: node src/game/stories/smoke-test.mjs

import assert from 'node:assert/strict';
import { STORY_LIBRARY, STORY_TRIGGER, LINE_WIPE_END_PERCENT } from './stories.config.js';
import { createStoryLibrary, parseStories } from './story-library.js';
import { createTriggerPoller } from './trigger-poller.js';
import { buildStoryTimeline, envelopeAt, scrollOffsetAt, lineProgressAt } from './story-timeline.js';
import { wrapText, createGraphemeSplitter } from './text-layout.js';
import { placeBox, tailFor } from './box-placement.js';
import { defaultParams, cssVarsFor } from './params.js';

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));
const near = (actual, expected, what) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: ${actual} != ${expected}`);

// --- library: hand-out order, wrap-around, failure ---
{
  const data = { stories: [{ title: 'A', text: ' one  two \r\n\n\n\nthree' }, { title: 'only title' }, { title: 'C', text: 'c' }, { text: '  ' }] };
  assert.deepEqual(parseStories(data), ['one two\n\nthree', 'only title', 'c']);

  const library = createStoryLibrary({ fetchJson: async () => data });
  assert.equal(library.next(), STORY_LIBRARY.placeholderText, 'placeholder before load');
  await library.load();
  assert.deepEqual([library.next(), library.next(), library.next(), library.next()],
    ['one two\n\nthree', 'only title', 'c', 'one two\n\nthree'], 'file order, then wraps');
  library.rewind();
  assert.equal(library.next(), 'one two\n\nthree', 'rewind starts over');

  const logged = [];
  const broken = createStoryLibrary({
    fetchJson: async () => { throw new Error('HTTP 404'); },
    log: (tag, detail) => logged.push(detail),
  });
  await broken.load(); // must not reject
  assert.equal(broken.next(), STORY_LIBRARY.placeholderText);
  assert.equal(broken.next(), STORY_LIBRARY.placeholderText);
  assert.match(logged[0], /HTTP 404/);
}

// --- trigger poller: cadence, per-pass limit, round-robin, staleness ---
{
  const makeEntry = (id, initial = false) => ({ oat: { id, uv: { x: id / 100, y: 0.5 }, initial }, waiting: !initial });
  const entries = [makeEntry(0, true), ...[1, 2, 3, 4, 5, 6].map((id) => makeEntry(id))];
  const requests = [];
  const scoreOf = new Map();
  const crossed = [];
  const poller = createTriggerPoller({
    entries,
    coverageNear: async (uvs) => {
      requests.push(uvs.map((uv) => Math.round(uv.x * 100)));
      return uvs.map((uv) => scoreOf.get(Math.round(uv.x * 100)) ?? 0);
    },
    onCrossed: (entry, now) => { entry.waiting = false; crossed.push([entry.oat.id, now]); },
  });
  const on = { enabled: true, threshold: 0.05 };
  const interval = STORY_TRIGGER.pollIntervalMs;

  poller.update(1000, on);
  assert.deepEqual(requests, [[1, 2, 3, 4]], 'first pass: 4 waiting oats, initial skipped');
  poller.update(1005, on); // answer not landed, interval not elapsed
  assert.equal(requests.length, 1);
  await flushPromises();
  poller.update(1016, on); // answer landed: acted on at once, nothing crossed
  assert.deepEqual(crossed, []);
  poller.update(1016 + interval - 1, on);
  assert.equal(requests.length, 1, 'no new request before the interval');
  scoreOf.set(5, 0.05); // exactly at the threshold counts
  scoreOf.set(6, 0.049);
  poller.update(1016 + interval, on);
  assert.deepEqual(requests[1], [5, 6, 1, 2], 'round-robin continues and wraps');
  await flushPromises();
  poller.update(1300, on);
  assert.deepEqual(crossed, [[5, 1300]]);

  // An oat placed while a request is in flight discards that answer.
  scoreOf.set(3, 1);
  poller.update(1300 + interval, on);
  assert.deepEqual(requests[2], [3, 4, 6, 1]);
  entries.push(makeEntry(7));
  poller.invalidate();
  await flushPromises();
  poller.update(1300 + interval + 16, on);
  assert.equal(crossed.length, 1, 'stale answer ignored');

  // Disabled: no requests, and nothing triggers.
  const before = requests.length;
  poller.update(5000, { enabled: false, threshold: 0.05 });
  poller.update(5000 + interval - 1, on);
  assert.equal(requests.length, before, 'waits a full interval after re-enabling');
  poller.update(5000 + interval, on);
  assert.equal(requests.length, before + 1);

  // A failing coverage query is survived.
  const failing = createTriggerPoller({
    entries: [makeEntry(1)],
    coverageNear: () => { throw new Error('gpu lost'); },
    onCrossed: () => assert.fail('must not trigger'),
  });
  failing.update(0, on);
  await flushPromises();
  failing.update(interval, on);
}

// --- timeline: the numbers of one story box ---
{
  near(LINE_WIPE_END_PERCENT, 15.5, 'wipe end percent');
  const timeline = buildStoryTimeline({ lineGraphemeCounts: [10, 0, 20], lineHeightPx: 25, viewportHeightPx: 100, textFadePx: 28 });
  const d0 = (10 * 190 + 1560) * 0.845;
  const d1 = 1560 * 0.845;
  const d2 = (20 * 190 + 1560) * 0.845;
  near(timeline.lines[0].durationMs, d0, 'line 0 duration');
  near(timeline.lines[1].startMs, d0 * 2 / 3, 'line 1 starts at 2/3 of line 0');
  near(timeline.lines[2].startMs, (d0 + d1) * 2 / 3, 'line 2 start');
  const reveal = (d0 + d1) * 2 / 3 + d2;
  const exit = Math.max(2400, (d0 + d1 + d2) / 3 * 5);
  near(timeline.textEndMs, 2600 + reveal + exit, 'text end');
  near(timeline.totalMs, 2600 + reveal + exit + 2600, 'total');

  assert.deepEqual(envelopeAt(timeline, 0), { glass: 0, text: 0 });
  near(envelopeAt(timeline, 1300).glass, 0.5, 'glass half way in');
  assert.equal(envelopeAt(timeline, 2599).text, 0);
  assert.deepEqual(envelopeAt(timeline, 2600), { glass: 1, text: 1 });
  near(envelopeAt(timeline, timeline.textEndMs + 1300).text, 0.5, 'text half way out');
  assert.deepEqual(envelopeAt(timeline, timeline.totalMs), { glass: 0, text: 0 });

  near(scrollOffsetAt(timeline, 0), 72, 'roll waits at viewport - fade');
  near(scrollOffsetAt(timeline, 2600), 72, 'roll holds during glass fade-in');
  near(scrollOffsetAt(timeline, 2600 + timeline.lines[1].startMs), 72 - 25, 'up one line as line 1 starts');
  near(scrollOffsetAt(timeline, 2600 + reveal), 72 - 75, 'up three lines when reveal ends');
  near(scrollOffsetAt(timeline, timeline.textEndMs), -100, 'gone at text end');
  near(lineProgressAt(timeline, 0, 2600 + d0 / 2), 0.5, 'line wipe half way');
  assert.equal(lineProgressAt(timeline, 2, 2600), 0);
}

// --- wrapping ---
{
  const splitGraphemes = createGraphemeSplitter();
  const options = { measureWidth: (s) => splitGraphemes(s).length * 10, availableWidthPx: 100, splitGraphemes };
  assert.deepEqual(wrapText('aaa bbb ccc ddd', options), ['aaa bbb', 'ccc ddd']);
  assert.deepEqual(wrapText('one\n\ntwo', options), ['one', '', '', '', 'two'], 'paragraph gap is three empty lines');
  assert.deepEqual(wrapText('x abcdefghijklmnopqrstuvwxy z', options), ['x', 'abcdefghij', 'klmnopqrst', 'uvwxy z']);
  assert.deepEqual(wrapText('   ', options), ['']);
  assert.equal(splitGraphemes('éa').length, 2, 'combining accent is one grapheme');
}

// --- placement ---
{
  const viewport = { widthPx: 1000, heightPx: 800 };
  assert.deepEqual(placeBox({ x: 500, y: 400 }, viewport, 0.15), { left: 385, top: 154, width: 230, height: 126 });
  assert.equal(placeBox({ x: 5, y: 400 }, viewport, 0.15).left, 14, 'clamped to the left margin');
  assert.equal(placeBox({ x: 500, y: 20 }, viewport, 0.15).top, 14, 'clamped to the top margin');
  assert.equal(placeBox({ x: 500, y: 400 }, viewport, 0).top, 400 - 126 - 8, 'never closer than the minimum gap');
  assert.equal(placeBox({ x: 100, y: 400 }, { widthPx: 200, heightPx: 800 }, 0.15).width, 172, 'narrow screens shrink the box');

  const box = { left: 385, top: 154, width: 230, height: 126 };
  assert.equal(tailFor(box, { x: 500, y: 200 }), null, 'no tail when the oat is under the box');
  const tail = tailFor(box, { x: 500, y: 400 });
  near(tail.lengthPx, 120 + 2, 'tail length');
  near(tail.angleRad, Math.PI / 2, 'tail points down');
}

// --- params ---
{
  const params = defaultParams();
  assert.equal(params.triggerThreshold, 0.05);
  assert.equal(params.tailLengthVh, 0.15);
  const vars = cssVarsFor(params, '#ffffff');
  assert.equal(vars['--story-edge-feather-outset'], '42.0px');
  assert.equal(vars['--story-edge-feather-mask'], '62.4px');
  assert.equal(vars['--story-tint-rgb'], '0, 0, 0');
  assert.equal(vars['--story-text-rgb'], '255, 255, 255');
}

console.log('stories smoke test: ok');
