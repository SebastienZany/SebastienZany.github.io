// The story library: the texts from assets/stories.json and the order they are
// handed out in. Stories go out in file order, one per oat, at the moment the
// oat's story box starts; after the last story the list starts over.

import { STORY_LIBRARY } from './stories.config.js';

export function createStoryLibrary({ log = () => {}, fetchJson = fetchStoriesJson } = {}) {
  let stories = [];
  let nextIndex = 0;
  let loading = null;

  // Never rejects: with no stories, next() hands out the placeholder text.
  function load() {
    if (loading) return loading;
    loading = fetchJson(STORY_LIBRARY.url)
      .then((data) => {
        const parsed = parseStories(data);
        if (parsed.length === 0) throw new Error('no story text entries found');
        stories = parsed;
        nextIndex = 0;
        log('stories', `loaded ${parsed.length} from ${STORY_LIBRARY.url}`);
      })
      .catch((err) => {
        stories = [];
        log('stories', `load failed, using placeholder text: ${err?.message ?? err}`);
      })
      .finally(() => {
        // A failed load may be retried by calling load() again.
        if (stories.length === 0) loading = null;
      });
    return loading;
  }

  function next() {
    if (stories.length === 0) return STORY_LIBRARY.placeholderText;
    const story = stories[nextIndex % stories.length];
    nextIndex = (nextIndex + 1) % stories.length;
    return story;
  }

  // A new game starts again from the first story.
  function rewind() {
    nextIndex = 0;
  }

  return { load, next, rewind, count: () => stories.length };
}

async function fetchStoriesJson(url) {
  // no-store: the stories are edited often and must never be a stale copy.
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

// { stories: [{ title, text }] } -> [text, ...]. Only the text is shown; the
// title stands in for an entry that has no text. Empty entries are dropped.
export function parseStories(data) {
  const entries = Array.isArray(data) ? data : data?.stories;
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => tidyStoryText(typeof entry === 'string' ? entry : entry?.text ?? entry?.title))
    .filter(Boolean);
}

// Unix newlines, no stray spaces, and at most one empty line between paragraphs.
export function tidyStoryText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/[ \t]+/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
