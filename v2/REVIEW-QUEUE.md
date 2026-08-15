# Review queue — items awaiting the artist (newest first)

> Async-review mode (PLAN §5): nothing here blocks the pipeline except cutover. Each item says
> what to look at, what was provisionally decided, and how to override. Add feedback inline or
> just tell Claude.

## Open

- **[M0] iPhone + Mac-Safari probe runs** — when M0 lands and is pushed, open
  `https://bestiaryofvanishings.com/v2/probe.html` on the phone (and Safari on the Mac), run the
  workload rehearsal at 1024, tap "copy JSON", paste back to Claude (or into
  `v2/reference/probe-results.md`). *Provisional:* pipeline proceeds on conservative
  assumptions (staging-fallback fill, no tier1, rgba16float display). Phone data can only
  upgrade these. ~5 minutes, no deadline.

## Decided provisionally (informational)

- **M2 mobile policy** (pre-set with the artist, 2026-08-15): combined levers (G3 +
  density-as-needed) if measured post-split conservative demand ≤ 85%, else 1280 fallback.
- **Codex effort per milestone**: xhigh for M0/M1 dispatches, ultra/max for M2+ (global config
  untouched).

## Resolved

(nothing yet)
