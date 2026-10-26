# OmniMemEval — LongMemEval-S answer-quality benchmark

Mind uses the official
[MemTensor/OmniMemEval](https://github.com/MemTensor/OmniMemEval)
LongMemEval-S harness, pinned at
[`f7476c5502115542eca9971195bf8c5ca97b6256`](https://github.com/MemTensor/OmniMemEval/tree/f7476c5502115542eca9971195bf8c5ca97b6256).
The Mind adapter only maps OmniMemEval's memory `add`, `search`, and `delete`
operations to the production SQLite store. The official answer and judge
prompts and scoring pipeline are not modified.

## Recorded results

| Run                                           | Scope                            |        Answer accuracy | Evidence                                                                               |
| --------------------------------------------- | -------------------------------- | ---------------------: | -------------------------------------------------------------------------------------- |
| **GPT-6 Luna (low), best completed**          | 120 balanced questions           |   **86.67% (104/120)** | [Completed run](https://github.com/GabrielMartinMoran/mind/actions/runs/40320556252)   |
| GPT-6 Luna (low), manually adjusted           | 119 judged + 1 manually credited | **85.83% (103/120)\*** | [Replay](https://github.com/GabrielMartinMoran/mind/actions/runs/40347160769)          |
| Historical pilot (GPT-4.1 mini / GPT-4o mini) | 120 balanced questions           |        81.67% (98/120) | [Earlier run](https://github.com/GabrielMartinMoran/mind/actions/runs/40211788895)     |
| Historical full attempt                       | 500 questions                    |             Not scored | [Interrupted run](https://github.com/GabrielMartinMoran/mind/actions/runs/40212406024) |

\*The manually adjusted result has **102 judged correct out of 119**, plus
one answer counted correct at the user's request after its embedding request
failed. It is **not an official OmniMemEval accuracy score**. The completed
86.67% run is the strongest valid observed result for this Mind revision.

Mind's 86.67% would be third **by raw score** against
[OmniMemEval's published LongMemEval-S numbers](https://github.com/MemTensor/OmniMemEval/blob/main/docs/user_memory/results.md)
(MemOS 89.20%, LCM-X 87.00%). This is an **indicative comparison only**:
Mind's result uses a 120-question stratified subset and GPT-6 Luna (low) for
both answering and judging, whereas published systems use 500 questions and
a different model/judge setup. Mind is not ranked officially.

The new runs use the same production SQLite search, one timestamped
conversation session per T3 memory, isolated spaces, top-20 retrieval, and
OpenRouter. The best completed run uses lexical search; the manually adjusted
run also requested embeddings, with one failed ingestion. The earlier pilot
used GPT-4.1 mini for answers and GPT-4o mini for grading. The historical
full attempt was interrupted by the OpenRouter key's former US$10 limit
(78 answer-generation failures), so it produced no valid 500-question score.

## Run manually

The paid workflow is deliberately **`workflow_dispatch` only**: no push,
pull request, schedule, or routine test triggers it.

1. In GitHub, open **Actions → OmniMemEval LongMemEval-S (manual)**.
2. Select **Run workflow** and the branch containing the adapter.
3. Choose `sample_size`: **60**, **120** (default), or **500** (full dataset).
4. Choose `rag_mode`: **off** (lexical baseline) or **on** (OpenRouter `text-embedding-3-small` for writes and semantic queries).
5. Inspect the resulting report and artifacts in that Actions run.

The workflow requires an `OPENROUTER_API_KEY` secret in the GitHub
`Develop` environment. It downloads the dataset at runtime and does not
commit source conversations, generated answers, or credentials. CI still runs
free tests for the independent
[agent-memory benchmark](../agent-memory/README.md); these tests do not call
OpenRouter.

**Cost warning:** the key's previous US$10 monthly cap was exhausted during
the 500-question run. Before installing dependencies, the workflow checks the
live OpenRouter key and effective budget, and stops if the observed remaining
credit is below the minimum estimated for its selected sample size. This is
**not** a hard spending cap, since actual token use varies. An RAG-on run
also stops if embeddings cannot be created; it never silently runs as RAG-off.
Paired comparisons must use the exact same question subset, models
(GPT-6 Luna low for both answering and judging), and top-k.
The two modes have separate processes/DBs and must be reported independently.

## Implementation

- [`bridge.ts`](bridge.ts) — Bun HTTP adapter using Mind's production store.
- [`mind_client.py`](mind_client.py) — OmniMemEval client implementation.
- [`install_adapter.py`](install_adapter.py) — registers the client in the
  pinned upstream checkout at runtime.
- [`stratify.py`](stratify.py) — deterministic category-balanced pilots.
- [`omnimemeval-mind.yml`](../../.github/workflows/omnimemeval-mind.yml) —
  manual-only hosted evaluation.
