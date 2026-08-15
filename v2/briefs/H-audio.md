# H — Audio engine (lane brief; clock-injected, zero GPU)

**Objective:** the complete WebAudio engine, written fresh to the parity contract, with every
scheduler a pure clock-injected module and every constant an anchored data table. The most
isolated subsystem in the game — node-testable end to end with a fake clock.

**Read first:** PLAN §0 mandates; `reference/parity-checklist.md` **§3 in full** (the audio
graph and every behavior line is the contract — this brief deliberately does not restate it);
key anchors: graph wiring main.js:9074-9118/8772-8779/9463-9481/8842-8855, env scheduler
9266-9321, tumble crop/loop 9037-9170, spatial sync 8614-8721 (position = power-weighted oat
centroid w/ overrides), one-shots + voice steal 9413-9454, `getOutputTimestamp` mapping
8736-8770, clip table 255-267, compressor 222-236/8842-8876, unlock-in-gesture 6092-6100,
preload staging 8988-9011.

## Deliverables
1. `src/audio/clips.js` — the clip table as DATA (ids, paths incl. env fallback, gains,
   maxGains, fades, loop metadata) with per-row legacy anchors.
2. `src/audio/schedulers.js` — env overlap-crossfade + tumble crop-loop schedulers as pure
   functions of (clock, clipDuration, params) → scheduled source plan; no AudioContext inside.
3. `src/audio/engine.js` — context lifecycle (lazy, webkit fallback, unlock-in-gesture rule
   documented), node-graph construction per checklist §3 (one-shot pool with steal, env chain,
   tumble spatial chain: HRTF panner constants, distance lowpass, procedural stereo IR reverb —
   port the IR generator semantics from main.js:9059-9072), compressor toggle rewiring, ramp
   discipline (setTargetAtTime 0.035), spatial sync (≤15 Hz, epsilon-gated) consuming a
   position-provider interface (the sim wires it later in M7 — here a stub provider).
4. `v2/sound.html` — a minimal sound-check page (per-clip play/stop/vol/loop/fades rows built
   from the clip table, compressor section) against the real `../shen-soundpack/` files —
   Claude gate-tests audibly-adjacent behavior via page automation (no audio assertions, just
   graph/state ones exposed on `window.__v2.audio`).

## Tests (node, fake clock throughout)
Env scheduler: exact source start/stop/crossfade times over a simulated 10-minute run incl.
lookahead pumping; tumble: crop offset, loop points, crossfade overlap; voice pool: 16-cap +
oldest-steal order; ramp helper: value trajectories; clip table completeness vs checklist
(every used-in-game clip present with matching gains); position provider: centroid math with
override precedence (intro sprite > oats > initial hit > target).

## Forbidden
No `performance.now`/`Date.now` (clock.js only). No GPU. No DOM outside sound.html. No new
deps. No copying legacy code — semantics from anchors, expression fresh.
