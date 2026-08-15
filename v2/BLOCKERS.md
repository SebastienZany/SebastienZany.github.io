# Blockers

## M0 — mandated Node test directory command

Observed 2026-08-15 on the acceptance machine with Node v24.13.0:

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

