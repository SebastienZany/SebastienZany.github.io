// MP4 encoding for offline replay renders.
//
// Wraps Mediabunny's CanvasSource + AudioBufferSource. The caller drives the
// render loop and calls addFrame() once per output frame, in the same JS task
// as the draw — VideoFrame(canvas) snapshots at construction, and the WebGL
// drawing buffer is only cleared after it is presented to the compositor,
// which cannot happen mid-task. Verified in replay/m0-probe.html.
//
// Audio arrives *after* all video, because cue times are emergent from the sim
// pass. See ARCHITECTURE note at the bottom re: buffering.

const MEDIABUNNY_URL = 'https://cdn.jsdelivr.net/npm/mediabunny/+esm';

// H.264 High. Level 5.1 covers up to 1440p60; 4K60 needs 5.2.
export function pickAvcCodec(width, height, fps) {
  const mbPerSec = Math.ceil(width / 16) * Math.ceil(height / 16) * fps;
  return mbPerSec > 983040 ? 'avc1.640034' : 'avc1.640033';
}

// bits per pixel per frame; 0.12 is a reasonable default for this material.
export function bitrateFor(width, height, fps, bpp = 0.12) {
  return Math.round(width * height * fps * bpp);
}

export async function createMp4Encoder({
  canvas,
  fps,
  bitrate,
  codec,
  bpp = 0.12,
  withAudio = false,
  audioBitrate = 192000,
  onProgress = null,
}) {
  const mb = await import(MEDIABUNNY_URL);
  const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource } = mb;

  const width = canvas.width;
  const height = canvas.height;
  if (width % 2 || height % 2) {
    throw new Error(`encoder needs even dimensions, got ${width}x${height}`);
  }

  const videoCodec = codec ?? pickAvcCodec(width, height, fps);
  const videoBitrate = bitrate ?? bitrateFor(width, height, fps, bpp);

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: videoBitrate,
    fullCodecString: videoCodec,
    latencyMode: 'quality',
    bitrateMode: 'variable',
    keyFrameInterval: 2, // seconds
  });
  output.addVideoTrack(videoSource, { frameRate: fps });

  // Every track must exist before start() — Mediabunny throws
  // "Cannot add track after output has been started" otherwise. So the audio
  // track is DECLARED up front even though its samples arrive last, after the
  // sim pass has produced the cue times. Declaring it and never feeding it
  // would finalize a file with an empty audio track, so `withAudio` must match
  // what the caller will actually do.
  let audioSource = null;
  if (withAudio) {
    audioSource = new AudioBufferSource({ codec: 'aac', bitrate: audioBitrate });
    output.addAudioTrack(audioSource);
  }

  const state = { frames: 0, started: false, finalized: false, cancelled: false };

  return {
    get frames() { return state.frames; },
    get videoCodec() { return videoCodec; },
    get videoBitrate() { return videoBitrate; },

    async start() {
      await output.start();
      state.started = true;
    },

    // Call immediately after renderer.render(), same JS task.
    async addFrame(frameIndex) {
      const t = frameIndex / fps;
      const d = 1 / fps;
      await videoSource.add(t, d);
      state.frames++;
      if (onProgress) onProgress(state.frames);
    },

    // AudioBuffer from OfflineAudioContext.startRendering(). Samples are late
    // by design; the track itself was declared before start().
    async addAudio(audioBuffer) {
      if (!audioSource) {
        throw new Error('createMp4Encoder({ withAudio: true }) is required before addAudio()');
      }
      await audioSource.add(audioBuffer);
    },

    async finalize() {
      if (state.cancelled) throw new Error('encoder was cancelled');
      await output.finalize();
      state.finalized = true;
      return output.target.buffer; // ArrayBuffer
    },

    // Abort mid-render: finalize what exists so the partial file is valid.
    async abort() {
      state.cancelled = true;
      try {
        await output.finalize();
        return output.target.buffer;
      } catch {
        await output.cancel().catch(() => {});
        return null;
      }
    },
  };
}

// ARCHITECTURE NOTE — late audio and memory.
//
// Because audio cannot be rendered until the sim pass has produced its cue
// times, the audio track is added after all video. Mediabunny may retain video
// packets until the audio track appears, so `fastStart: 'in-memory'` is honest
// about what is happening rather than pretending a stream target bounds memory.
//
// Budget: ~0.12bpp at 1440p60 is ~26 Mbps, so ~3.3 MB/s -> a 3-minute export is
// ~590 MB held before finalize. That is survivable on desktop but is the reason
// the render panel must show projected size up front and refuse long 4K jobs.
//
// The fix, if longer exports are needed: render audio first from a cheap
// sim-only pre-pass (no display chain, no capture), then mux video against a
// known-duration audio track and stream to disk. Deferred — measure first.
