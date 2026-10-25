# LongMemEval-S — Mind retrieval + QA (OpenRouter pilot)

Date: 2026-10-25.

Source: repository `GabrielMartinMoran/mind`, branch `benchmark/longmemeval-20261025` (based on `develop@105935c885aecf4a4be82a80869929663deb22ca`).
Official cleaned LongMemEval-S dataset SHA-256: `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.

**These are NOT official LongMemEval leaderboard scores.** This is a controlled, forced-retrieval experiment with one memory per complete conversation session. Memory acquisition, automatic agent tool selection, promotion, consolidation, and agentic memory use are not evaluated.

## Reproducible runs

- [3-question initial pilot, both RAG states and QA](https://github.com/GabrielMartinMoran/mind/actions/runs/40204531009)
- [12-question retrieval with confirmed embeddings](https://github.com/GabrielMartinMoran/mind/actions/runs/40204826616)
- [12-question full paired QA, reusing the same retrieval artifacts](https://github.com/GabrielMartinMoran/mind/actions/runs/40205334241)

The original 12-question combined run only performed QA for three cases due to an input fallback bug. The QA-only run above **corrected this** and asserts 12 judge verdicts in each arm. The now-manual full workflow also has the corrected count fallback.

## Answering: 12 questions, all four arms

Reader: `deepseek/deepseek-v4.1-flash-1017`, OpenRouter, reasoning effort low, temperature 0.
Independent (but not independently calibrated) judge: `openai/gpt-4o-mini`, task-specific yes/no rubric.

| Condition | Correct | Accuracy |
|---|---:|---:|
| Mind, semantic OFF | 5/12 | 41.7% |
| Mind, semantic ON | 6/12 | 50.0% |
| SQLite FTS5 BM25 baseline | 7/12 | 58.3% |
| No memory | 1/12 | 8.3% |

The observed net benefit of embeddings was **one question out of 12**. This sample is too small to establish a reliable model ranking or statistically meaningful improvement. The fixed context policy selected up to five sessions, each excerpting up to 3,000 characters with lexical turn selection, identical for Mind and BM25.

**Answerer + judge API cost:** $0.02121273 in the validated 12-question run. **Embedding API cost is separate** and was not included in this number. The QA software budget was $0.25, not a hard OpenRouter billing cap.

## Retrieval: 12 questions, 11 with scored evidence

All 12 cases were confirmed embedded before running the semantic ON arm, and the semantic channel executed in all 12 cases.

| Retrieval metric | Mind OFF | Mind ON | BM25 |
|---|---:|---:|---:|
| Hit@20 | 81.8% | 90.9% | 100% |
| All evidence @20 | 63.6% | 72.7% | 90.9% |
| Evidence recall @20 | 71.2% | 80.3% | 93.9% |
| MRR@20 | 0.689 | 0.803 | 0.877 |
| P50 search latency | 162 ms | 353 ms | 0.99 ms |

Caveats: data access and runner setup differ from independently published implementations. BM25 is a strong, simple **retrieval baseline**, not a deployment replacement. It is deliberately computed over exactly the same in-test SQLite corpus, and has no external model cost.

## Interpreting results

1. Mind benefits from memory versus no memory in this small sample.
2. Semantic ON improved retrieval and net answer correctness here, but did **not** beat the simple BM25 baseline.
3. Further work should increase the stratified sample and audit examples with the gold-evidence sessions, rather than optimize against the judge on only twelve examples.
4. The experiment does not indicate how often an agent would autonomously write or recall memories in the actual product.

## Secrets and invocation

The GitHub Action `LongMemEval OpenRouter RAG A/B (manual)` uses GitHub Environment `Develop` with its environment-scoped secret `OPENROUTER_API_KEY`; it never writes secrets to result files. The complete workflow is manual-only, preventing unintended paid reruns on commits.

The one-shot `LongMemEval OpenRouter QA-only 12` workflow reuses the 12-question RAG retrieval artifact to avoid re-embedding and will only run on changes to its own workflow file or manual dispatch.
