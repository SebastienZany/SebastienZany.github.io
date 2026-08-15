# M0 capability probe results

## Harness notes

- Automated browser: system Chrome channel, starting headless with no added launch flags.
- Every browser test asserts `adapter.info.isFallbackAdapter === false` before exercising a page;
  vendor and description strings are retained only as secondary diagnostics.
- The automated rehearsal runs for five seconds with a 180-second explicit test timeout. It
  includes the maximum legal crowd radius × eight simulation steps plus maximum display
  smoothing on the device's actual fill path.
- The manual device protocol is 60 seconds. Use 1536 on desktop and 1024 on phones, then copy the
  page JSON into the matching section below.
- Managed-session launch attempt (2026-08-15): headless system Chrome 151 aborted with `SIGABRT`
  before page creation. The headed fallback also aborted because Crashpad could not read its
  application-support directory under the filesystem sandbox. A third headless attempt with
  `--disable-crashpad --disable-crash-reporter --crash-dumps-dir=/private/tmp/v2-chrome-crashes`
  behaved identically, so those ineffective flags are not part of the committed config. There is
  no working browser configuration to record from this restricted session; see `../BLOCKERS.md`.

<!-- mac-chrome:start -->
## Mac Chrome — pending automated run

No result recorded yet.
<!-- mac-chrome:end -->

## Mac Safari — pending user run

Open local `/v2/probe.html`, run the 60-second rehearsal at 1536, and copy the JSON here.

## iPhone Safari — pending deployment and user run

Open `https://bestiaryofvanishings.com/v2/probe.html`, run the 60-second rehearsal at 1024, and
copy the JSON here. Record the phone model, iOS version, battery/charging state, and whether the
tab was backgrounded.
