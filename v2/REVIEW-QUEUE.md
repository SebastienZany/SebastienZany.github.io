# Review queue — items awaiting the artist (newest first)

> Async-review mode (PLAN §5): nothing here blocks the pipeline except cutover. Each item says
> what to look at, what was provisionally decided, and how to override. Add feedback inline or
> just tell Claude.

## Open

- **[M0] iPhone probe now actionable** — M0 is merged and pushed; open
  `https://bestiaryofvanishings.com/v2/probe.html` on the phone, run the 60 s rehearsal at 1024,
  copy JSON, paste to Claude or into `v2/reference/probe-results.md`. Mac Safari at 1536 likewise
  if convenient. *Provisional while pending:* conservative device assumptions stand. ~5 min.


- **[M0] iPhone + Mac-Safari probe runs** — when M0 lands and is pushed, open
  `https://bestiaryofvanishings.com/v2/probe.html` on the phone and run the 60-second rehearsal
  at 1024; on Mac Safari, open the local page and run it at 1536. Tap "copy JSON" and paste both
  reports back to Claude (or into `v2/reference/probe-results.md`). Also run `npm run test:gpu`
  from an ordinary local shell so system Chrome can access its Crashpad directory; this managed
  session could not launch Chrome. *Provisional:* pipeline proceeds on conservative
  assumptions (staging-fallback fill, no tier1, rgba16float display). Phone data can only
  upgrade these. ~5 minutes, no deadline.

## Decided provisionally (informational)

- **M2 mobile policy** (pre-set with the artist, 2026-08-15): combined levers (G3 +
  density-as-needed) if measured post-split conservative demand ≤ 85%, else 1280 fallback.
- **Codex effort per milestone**: xhigh for M0/M1 dispatches, ultra/max for M2+ (global config
  untouched).

## Resolved

- **M0 accepted** (gate review 2026-08-15, bound to the merge SHA recorded in git): 11 Codex
  commits + 2 gate amendments (test-glob spec fix; Chrome probe results from Claude's shell —
  Codex's sandbox cannot launch Chrome, so GPU suites are gate-run by Claude as standing
  procedure). Node 21/21, GPU 2/2, hardware adapter apple/metal-3, all optional capabilities
  present on desktop. Readability review: pass (CONVENTIONS/GLOSSARY exemplary).
