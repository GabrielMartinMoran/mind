# OmniMemEval — LongMemEval-S answer-quality benchmark

Mind uses the official
[MemTensor/OmniMemEval](https://github.com/MemTensor/OmniMemEval)
LongMemEval-S harness, pinned at
[`f7476c5502115542eca9971195bf8c5ca97b6256`](https://github.com/MemTensor/OmniMemEval/tree/f7476c5502115542eca9971195bf8c5ca97b6256).
The Mind adapter only maps OmniMemEval's memory `add`, `search`, and `delete`
operations to the production SQLite store. The official answer and judge
prompts and scoring pipeline are not modified.

## Recorded results

| Run            | Scope                           |     Answer accuracy | Context tokens / question | Evidence                                                                               |
| -------------- | ------------------------------- | ------------------: | ------------------------: | -------------------------------------------------------------------------------------- |
| Balanced pilot | 120 questions (20 per category) | **81.67% (98/120)** |                    50,882 | [Actions run](https://github.com/GabrielMartinMoran/mind/actions/runs/40211788895)     |
| Full attempt   | 500 questions                   |      **Not scored** |                         — | [Interrupted run](https://github.com/GabrielMartinMoran/mind/actions/runs/40212406024) |

The full attempt ingested and searched the dataset, but 78 of 500 answer
generations failed when the OpenRouter key reached its **US$10 monthly limit**.
Because the official judge did not complete, it has **no valid 500-question
accuracy score**. Never treat the 120-question figure as an official rank.

The pilot uses one full, timestamped conversation session per T3 memory,
separate SQLite spaces for benchmark users, `MIND_RAG=false`, top-20 search,
GPT-4.1 mini for answers, and GPT-4o mini for grading. The two models were
accessed through **OpenRouter**; OmniMemEval's published runs use varying
provider and model configurations. The resulting scores are useful context
but not strictly equivalent. See
[OmniMemEval's reproduced LongMemEval results](https://github.com/MemTensor/OmniMemEval/blob/f7476c5502115542eca9971195bf8c5ca97b6256/docs/user_memory/results.md#longmemeval)
for peer measurements.

## Run manually

The paid workflow is deliberately **`workflow_dispatch` only**: no push,
pull request, schedule, or routine test triggers it.

1. In GitHub, open **Actions → OmniMemEval LongMemEval-S (manual)**.
2. Select **Run workflow** and the branch containing the adapter.
3. Choose `sample_size`: **60**, **120** (default), or **500** (full dataset).
4. Inspect the resulting report and artifacts in that Actions run.

The workflow requires an `OPENROUTER_API_KEY` secret in the GitHub
`Develop` environment. It downloads the dataset at runtime and does not
commit source conversations, generated answers, or credentials. CI still runs
free tests for the independent
[agent-memory benchmark](../agent-memory/README.md); these tests do not call
OpenRouter.

**Cost warning:** the key's previous US$10 monthly cap was exhausted during
the 500-question run. If it remains unchanged, a full run cannot finish.
OmniMemEval currently has **no built-in spend ceiling** in this adapter:
check your OpenRouter budget and key limits before explicitly starting it.

## Implementation

- [`bridge.ts`](bridge.ts) — Bun HTTP adapter using Mind's production store.
- [`mind_client.py`](mind_client.py) — OmniMemEval client implementation.
- [`install_adapter.py`](install_adapter.py) — registers the client in the
  pinned upstream checkout at runtime.
- [`stratify.py`](stratify.py) — deterministic category-balanced pilots.
- [`omnimemeval-mind.yml`](../../.github/workflows/omnimemeval-mind.yml) —
  manual-only hosted evaluation.
