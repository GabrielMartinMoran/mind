# LongMemEval-S end-to-end QA: experimental

Status: **no valid end-to-end score** as of 2026-10-25.

The deterministic session-retrieval benchmark is operational. The QA comparison
(Mind vs BM25 vs no-memory) has not finished a valid paired run.

## What was verified

- OpenCode CLI runs `opencode/deepseek-v4.1-flash-free` on an ephemeral GitHub
  Actions runner without an API key (smoke run #40199246864, successful).
- Real LongMemEval-S (500 questions) is fetched and Mind/BM25 retrieval works.
- Direct `opencode run` is **not equivalent to direct LLM inference**. The
  default OpenCode agent attempted tool calls during a LongMemEval question,
  including filesystem inspection. This invalidates naive comparisons.
- Attempts to run a no-tools QA harness timed out on the first case; no
  answer-accuracy metric was obtained (runs #40199426935, #40200796122).
- The QA workflow is **manual-only** until the no-tools model invocation is
  fixed and verified. It must not be used as a published leaderboard result.

## Required next validation

1. Use an OpenCode session/SDK invocation with tools demonstrably unavailable.
   Inspect events to prove there were no tool calls, network/file access, or
   access to the answer key.
2. Test a single real LongMemEval question end-to-end and compare judge
   decisions to an independent judge on several examples.
3. Run a paired pilot under identical model/context budgets, then the 500-case
   full evaluation, reporting abstentions and the exact model/judge.
4. Keep direct-retrieval quality distinct from autonomous agent write/read
   performance. The session-as-memory ingest in this harness is not the same
   as normal Mind extraction or memory consolidation.

This branch is experimental. No changes were made to `develop`.
