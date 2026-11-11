// Decides when a waiting oat's story starts: when the slime coverage score
// near the oat reaches the threshold.
//
// Reading coverage means reading back from the GPU, so it is asked for
// sparingly: one request per poll interval, for a few oats at a time, taken
// round-robin from the oats still waiting. The answer arrives some frames
// later and is acted on in the first update() after it lands.

import { STORY_TRIGGER } from './stories.config.js';

// entries: the live, ordered list of oat entries ({ oat, waiting }). The
//   poller reads it and never changes it. `waiting` means "has a story box
//   that has not been triggered yet".
// coverageNear(uvs) -> Promise<number[]>, one score per uv.
// onCrossed(entry, now): the entry's score reached the threshold.
export function createTriggerPoller({ entries, coverageNear, onCrossed, log = () => {} }) {
  let nextCheckAtMs = 0;
  let cursor = 0; // where in `entries` the next round-robin pick starts
  let requestSerial = 0; // bumping it orphans any request still in flight
  let inFlight = false;
  let arrived = null; // { picked: entry[], scores: number[] } waiting to be acted on
  let failureLogged = false;

  function update(now, { enabled, threshold }) {
    if (!enabled) {
      // While story boxes are off nothing triggers, and stale answers are dropped.
      nextCheckAtMs = now + STORY_TRIGGER.pollIntervalMs;
      invalidate();
      return;
    }
    // An answer that has landed is acted on at once, not at the next interval.
    if (arrived && now < nextCheckAtMs) nextCheckAtMs = now;
    if (entries.length === 0 || now < nextCheckAtMs) return;
    nextCheckAtMs = now + STORY_TRIGGER.pollIntervalMs;

    if (arrived) {
      const { picked, scores } = arrived;
      arrived = null;
      picked.forEach((entry, i) => {
        const score = scores?.[i];
        if (!entry.waiting || !Number.isFinite(score)) return;
        if (score >= threshold) onCrossed(entry, now);
      });
      return; // the next request goes out one interval from now
    }
    if (inFlight) return;
    const picked = pickWaiting();
    if (picked.length > 0) request(picked);
  }

  function pickWaiting() {
    const picked = [];
    const count = entries.length;
    for (let tries = 0; tries < count && picked.length < STORY_TRIGGER.maxOatsPerPass; tries++) {
      const entry = entries[cursor % count];
      cursor = (cursor + 1) % count;
      if (entry.waiting) picked.push(entry);
    }
    return picked;
  }

  function request(picked) {
    const serial = ++requestSerial;
    inFlight = true;
    const uvs = picked.map((entry) => ({ x: entry.oat.uv.x, y: entry.oat.uv.y }));
    new Promise((resolve) => resolve(coverageNear(uvs))).then(
      (scores) => {
        if (serial !== requestSerial) return; // the oat list changed meanwhile
        inFlight = false;
        arrived = { picked, scores };
      },
      (err) => {
        if (serial !== requestSerial) return;
        inFlight = false;
        if (!failureLogged) log('stories', `coverage query failed: ${err?.message ?? err}`);
        failureLogged = true;
      },
    );
  }

  // Call whenever an oat is placed or removed: scores asked for before the
  // change are thrown away rather than matched against the new list.
  function invalidate() {
    requestSerial += 1;
    inFlight = false;
    arrived = null;
  }

  function reset() {
    invalidate();
    cursor = 0;
    nextCheckAtMs = 0;
  }

  return { update, invalidate, reset };
}
