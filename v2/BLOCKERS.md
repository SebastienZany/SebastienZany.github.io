# Blockers

## M2 — degraded donor weights cannot be represented by the mandated record

Observed 2026-08-15 while specifying the M2 gutter-table encoder. The brief requires degraded
stencils to relax nonnegativity and use bounded weights `|w| <= 2`, but mandates each tap weight
as `u16` and requires the quantized weights to sum to 65,535. Interpreting the stored value as
`q / 65535`, as that exact-sum rule requires, can represent only `[0, 1]`; it cannot represent a
negative extrapolation weight. A signed fixed-point representation could encode the degraded
case, but would need a different scale and exact-sum target (for example, signed q15 summing to
32,767), which contradicts the specified deployed layout.

The same section asks the transpose test to scatter a unit through the adjoint and gather it back
with the stencil as a unit-valued round trip. For a nontrivial bilinear stencil this produces
`sum(w_i^2)`, not 1 (four equal weights produce 0.25), so that assertion cannot hold even before
quantization. The valid adjoint test is the inner-product identity
`dot(G x, y) == dot(x, G^T y)`; conservation is separately established by `sum(w_i) == 1`.

Impact: exact geodesic walks, floating-point stencil construction, nonnegative u16 stencils, and
the CPU gather/scatter oracle are unaffected. Emitting the required degraded records and writing
the requested deployed-data test are stopped rather than silently changing the format or
weakening the assertion.

Resolution needed: choose a signed deployed weight encoding and its exact-sum rule (or prohibit
negative deployed weights), and replace “scatter then gather equals one” with the transpose
inner-product identity plus a separate conservation assertion.

## M1 — slit branch/loop counts describe the wrong component graph

Observed 2026-08-15 by the fresh M1 topology implementation against
`luyvwj-fwgyww.glb`. The required primary counts reproduce exactly: 1,233 charts, 30,034 seam
pairs, 3,592 same-chart slit pairs, 570 endpoint-only slit groups, and 630 chart-local slit
components.

The brief then requires each of the 630 chart-local components to carry branch and closed-loop
metadata, with 19 components expected to branch and 5 expected to be closed loops. Those two
expected counts belong to the earlier 570-component graph, before the required chart-local
split:

| Graph | Components | Multi-chart groups | Branching components | Branch vertices | Closed loops |
|---|---:|---:|---:|---:|---:|
| Physical endpoints only | 570 | 53 | 19 | 21 | 5 |
| Physical endpoint + `chartOf` | 630 | 0 | 18 | 19 | 0 |

The independent audit recorded in `reviews/mesh-audit-results.md` verifies the 570 endpoint-only
count but does not contain the later branch/loop or 630-component checks. Recomputing the global
graph also reproduces review #3's otherwise-unpublished diagnostics exactly (53 groups span
charts, 19 branch, 5 loop), which identifies the graph mismatch rather than a pairing error.

Impact: M1 can classify all seam pairs and emit the 630 chart-local work units, but cannot both
record chart-local topology and assert the brief's 19/5 counts. More importantly, M2 says closed
chart-local loops need a seed cut; the measured chart-local graph has no loops, while the five
global loops cross chart boundaries and become open paths after partitioning. Choosing the wrong
graph would change splitter behavior.

Resolution needed: amend M1/M2 to distinguish the diagnostic global endpoint groups
(570 / 53 multi-chart / 19 branching / 5 loops) from splitter work units
(630 / 18 branching / 19 branch vertices / 0 closed loops), or specify a different graph whose
membership and degree rules reproduce 630 together with 19/5.

## M0 — mandated Node test directory command

Observed 2026-08-15 on the acceptance machine with Node v24.13.0 and again through npm with
Node v26.5.0:

```text
$ node --test tests/node/
Error: Cannot find module '.../v2/tests/node'
code: MODULE_NOT_FOUND
```

The M0 brief requires the exact package script `test:node` → `node --test tests/node/`, but this
Node release treats the directory argument as a module path rather than discovering the test
files below it. The fixture generator completed before this failure. `node --test
tests/node/*.test.js` is the smallest working command, but substituting it would contradict the
brief, so the mandated package script remains unchanged pending a spec decision.

Impact: the node test files can be executed and verified individually, but `npm test` cannot be
green with the exact required script on this machine.

Resolution needed: authorize the explicit `tests/node/*.test.js` glob (or change the brief to
plain `node --test`, whose recursive discovery scope would need separate review).

## M0 — system Chrome cannot launch inside the managed session

The required system Chrome 151 process aborts before Playwright can create a page. Headless exits
with `SIGABRT`. The brief-directed headed fallback exposes the filesystem cause:

```text
bootstrap_check_in org.chromium.crashpad.child_port_handshake... Permission denied (1100)
open ~/Library/Application Support/Google/Chrome/Crashpad/settings.dat: Operation not permitted
```

The managed task sandbox allows writes only in the worktree and temporary directories. A third
headless attempt added `--disable-crashpad`, `--disable-crash-reporter`, and a `/private/tmp`
crash-dump directory; Chrome still aborted. Those ineffective flags were removed from the config.
No adapter was created, so this is a browser-process launch blocker rather than a WebGPU failure.

Impact: neither `probe.spec.js` nor `dev.spec.js` can run in this session, the Mac probe JSON
cannot be honestly recorded, and `npm test` cannot reach its GPU half. The test configuration and
specs remain ready for an ordinary local shell where Chrome can access its own support directory.

Resolution needed: run `npm run test:gpu` outside the managed filesystem sandbox, or provide a
browser execution environment that can launch the system Chrome binary with hardware WebGPU.
