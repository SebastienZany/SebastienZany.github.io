# Audio

`engine.js` is the public WebAudio surface. It owns the single lazy context, master routing,
loop transports, one-shots, clip settings, and the clock-gated spatial update. Its supporting
modules keep clip constants, schedule planning, buffer loading, voice admission, timestamp
mapping, and spatial math independently Node-testable.

Call `unlockFromGesture()` directly in Begin's event handler before its first `await`. Preloading
may create a suspended context for decoding, but never resumes it. The later sim integration
supplies the small position-provider interface currently represented by
`createStubPositionProvider()` in `spatial.js`.

`/v2/sound.html` is the production-graph sound check. Its automation surface is
`window.__v2.audio.getState()`.
