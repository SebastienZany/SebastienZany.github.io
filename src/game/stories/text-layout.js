// Breaking a story into lines that fit the story box. The box reveals text
// line by line, so the browser cannot be left to wrap it: every line must be
// its own element, and its length in graphemes sets how long its wipe takes.
//
// measureWidth(text) -> px is passed in (a Canvas2D measureText with the
// box's real font), which keeps this file free of the DOM.

// Split into what a reader sees as characters, so an emoji or an accented
// letter built from several code points counts (and breaks) as one.
export function createGraphemeSplitter() {
  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
  if (!segmenter) return (text) => Array.from(String(text)); // code points: close enough
  return (text) => Array.from(segmenter.segment(String(text)), (part) => part.segment);
}

// Returns the story as an array of lines. Every newline in the text becomes
// an empty line, and an empty paragraph is itself an empty line, so the usual
// blank line between two paragraphs comes out as three empty lines: a long
// breath in the reveal.
export function wrapText(text, { measureWidth, availableWidthPx, splitGraphemes }) {
  const normalised = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!normalised.trim()) return [''];
  const fits = (candidate) => measureWidth(candidate) <= availableWidthPx;
  const lines = [];
  for (const paragraph of normalised.split('\n')) {
    if (lines.length) lines.push('');
    lines.push(...wrapParagraph(paragraph, fits, splitGraphemes));
  }
  return lines;
}

// Greedy word wrap. A single word wider than the box is broken mid-word.
function wrapParagraph(paragraph, fits, splitGraphemes) {
  const words = paragraph.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || fits(candidate)) {
      current = candidate;
      continue;
    }
    lines.push(current);
    if (fits(word)) {
      current = word;
      continue;
    }
    const pieces = breakLongWord(word, fits, splitGraphemes);
    current = pieces.pop() ?? '';
    lines.push(...pieces);
  }
  if (current) lines.push(current);
  return lines;
}

function breakLongWord(word, fits, splitGraphemes) {
  const pieces = [];
  let current = '';
  for (const grapheme of splitGraphemes(word)) {
    const candidate = current + grapheme;
    if (!current || fits(candidate)) {
      current = candidate;
      continue;
    }
    pieces.push(current);
    current = grapheme;
  }
  if (current) pieces.push(current);
  return pieces;
}
