// Seamless looping by overlap: instead of source.loop (which clicks at the
// join unless the file was authored to loop), fresh copies of the same region
// are started every `intervalSec`, each one overlapping the tail of the one
// before by `crossfadeSec`.
//
//   copy 1  |==============\
//   copy 2             /===|==============\        (fadeInCopies: true)
//   copy 2             |===|==============\        (fadeInCopies: false)
//           <- interval ->
//
// WebAudio can only schedule on its own clock, so a slow timer (the "pump")
// keeps a queue of copies scheduled `lookaheadSec` into the future.

import { SILENT_GAIN } from './audio.config.js';
import { disconnectQuietly, fadeToSilence } from './param-ramps.js';

export function createLoopScheduler({
  context,
  destination,        // node every copy plays into
  buffer,
  offsetSec = 0,      // where in the buffer each copy starts
  copyDurationSec,    // how long each copy plays
  crossfadeSec,       // overlap between consecutive copies
  fadeInCopies,       // true: copies fade in and out; false: only out
  lookaheadSec,
  pumpMs,
  stopTailSec = 0.05,
}) {
  const overlapSec = Math.max(0, crossfadeSec);
  const intervalSec = Math.max(0.001, copyDurationSec - overlapSec);
  const copies = [];
  let nextStartSec = 0;
  let pumpTimer = null;

  function forget(copy) {
    if (copy.ended) return;
    copy.ended = true;
    const index = copies.indexOf(copy);
    if (index >= 0) copies.splice(index, 1);
    disconnectQuietly(copy.source);
    disconnectQuietly(copy.gain);
  }

  function scheduleCopy(startSec) {
    const endSec = startSec + copyDurationSec;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(destination);

    if (overlapSec > 0 && fadeInCopies) {
      gain.gain.setValueAtTime(SILENT_GAIN, startSec);
      gain.gain.linearRampToValueAtTime(1, Math.min(endSec, startSec + overlapSec));
      gain.gain.setValueAtTime(1, Math.max(startSec, endSec - overlapSec));
      gain.gain.linearRampToValueAtTime(SILENT_GAIN, endSec);
    } else {
      gain.gain.setValueAtTime(1, startSec);
      if (overlapSec > 0) {
        gain.gain.setValueAtTime(1, startSec + intervalSec);
        gain.gain.linearRampToValueAtTime(SILENT_GAIN, endSec);
      }
    }

    const copy = { source, gain, ended: false };
    source.addEventListener('ended', () => forget(copy), { once: true });
    source.start(startSec, offsetSec, copyDurationSec);
    source.stop(endSec + stopTailSec);
    copies.push(copy);
  }

  function pump() {
    const horizonSec = context.currentTime + lookaheadSec;
    while (pumpTimer !== null && nextStartSec <= horizonSec) {
      scheduleCopy(nextStartSec);
      nextStartSec += intervalSec;
    }
  }

  function start(startSec) {
    if (pumpTimer !== null) return;
    nextStartSec = startSec;
    pumpTimer = setInterval(pump, pumpMs);
    pump();
  }

  // fadeCopies: also fade every copy's own gain. Leave it false when the
  // caller fades a shared node downstream instead.
  function stop({ fadeSec, tailSec, fadeCopies }) {
    if (pumpTimer !== null) clearInterval(pumpTimer);
    pumpTimer = null;
    for (const copy of [...copies]) {
      if (fadeCopies) fadeToSilence(context, copy.gain.gain, fadeSec);
      try {
        copy.source.stop(context.currentTime + fadeSec + tailSec);
      } catch {
        forget(copy);
      }
    }
  }

  return {
    start,
    stop,
    isRunning: () => pumpTimer !== null,
    intervalSec,
    scheduledCount: () => copies.length,
  };
}
