// dispatch-codex.mjs — Claude's milestone dispatcher for the v2 rewrite.
// Runs one Codex thread against a brief, streams events to a JSONL log, appends a ledger row,
// and prints a structured final report. Resumable via thread id.
//
// Usage:
//   node dispatch-codex.mjs --brief ../../briefs/M0-scaffold.md --label M0 [--effort xhigh]
//   node dispatch-codex.mjs --resume <threadId> --label M0-fix --prompt "tests X fail: ..."
//
// Contract: Codex works in the repo worktree (workspace-write sandbox, never-ask approvals),
// commits on the current branch in small steps, and must return the structured report.
// Claude (not Codex) merges/pushes after gate review.

import { Codex } from '@openai/codex-sdk';
import { readFileSync, appendFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WORKTREE = resolve(here, '../../..'); // repo worktree root
const LOG_DIR = resolve(here, 'dispatch-logs');
mkdirSync(LOG_DIR, { recursive: true });

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : null)).filter(Boolean),
);
const label = args.label ?? 'run';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = `${LOG_DIR}/${label}-${stamp}.jsonl`;
const log = createWriteStream(logPath, { flags: 'a' });

const PREAMBLE = `You are Codex executing one milestone brief of the v2 WebGPU rewrite.
Working directory is the repo worktree root. Standing rules (non-negotiable):
- Read v2/PLAN.md sections 0-5 FIRST (the three artist mandates: every line new / parity-first /
  written to be read), then the brief in full, then the reference docs it names.
- Never modify anything outside v2/ (legacy files are reference only). Never weaken a test.
- The anchored legacy code is the spec for semantics; your code expression is always fresh,
  named per src/shared/GLOSSARY.md, readable per src/CONVENTIONS.md (create both in M0).
- Commit on the current branch in small steps with clear messages.
- If reality contradicts the brief, STOP that thread of work and write v2/BLOCKERS.md with the
  specifics; finish what is unaffected.
- Finish by running the brief's acceptance commands yourself and reporting honestly.`;

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'acceptance', 'commits', 'blockers', 'notable_decisions', 'review_queue_items'],
  properties: {
    status: { type: 'string', enum: ['complete', 'partial', 'blocked'] },
    acceptance: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'result', 'evidence'],
        properties: {
          item: { type: 'string' },
          result: { type: 'string', enum: ['pass', 'fail', 'skipped'] },
          evidence: { type: 'string' },
        },
      },
    },
    commits: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    notable_decisions: { type: 'array', items: { type: 'string' } },
    review_queue_items: { type: 'array', items: { type: 'string' } },
  },
};

async function main() {
  const codex = new Codex({
    config: args.effort ? { model_reasoning_effort: args.effort } : {},
  });
  const threadOpts = {
    workingDirectory: WORKTREE,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    networkAccessEnabled: true,
    skipGitRepoCheck: false,
    additionalDirectories: [resolve(WORKTREE, '../../../.git')], // worktree git objects live in the main repo
  };
  const thread = args.resume ? codex.resumeThread(args.resume, threadOpts) : codex.startThread(threadOpts);

  let prompt;
  if (args.resume && args.prompt) {
    prompt = args.prompt;
  } else {
    const briefPath = resolve(here, args.brief);
    const brief = readFileSync(briefPath, 'utf8');
    prompt = `${PREAMBLE}\n\n=== THE BRIEF (${args.brief}) ===\n\n${brief}\n\nExecute it now.`;
  }

  const { events } = await thread.runStreamed(prompt, { outputSchema: REPORT_SCHEMA });
  let finalText = '';
  let usage = null;
  for await (const ev of events) {
    log.write(JSON.stringify(ev) + '\n');
    if (ev.type === 'item.completed' && ev.item.type === 'agent_message') finalText = ev.item.text;
    if (ev.type === 'item.completed' && ev.item.type === 'command_execution') {
      // one-line progress to stdout so the background task log stays scannable
      console.log(`[cmd exit=${ev.item.exit_code}] ${ev.item.command.slice(0, 160)}`);
    }
    if (ev.type === 'turn.completed') usage = ev.usage;
    if (ev.type === 'turn.failed') {
      console.error('TURN FAILED:', JSON.stringify(ev.error));
      process.exitCode = 1;
    }
  }

  const ledgerRow = {
    ts: new Date().toISOString(),
    label,
    threadId: thread.id,
    brief: args.brief ?? null,
    resumedFrom: args.resume ?? null,
    effort: args.effort ?? 'config-default',
    usage,
    log: logPath,
  };
  appendFileSync(`${LOG_DIR}/ledger.ndjson`, JSON.stringify(ledgerRow) + '\n');

  console.log('\n=== THREAD ' + thread.id + ' ===');
  console.log('=== USAGE ' + JSON.stringify(usage) + ' ===');
  console.log('=== FINAL REPORT ===');
  console.log(finalText);
}

main().catch((e) => {
  console.error('DISPATCH ERROR:', e?.stack ?? e);
  process.exit(1);
});
