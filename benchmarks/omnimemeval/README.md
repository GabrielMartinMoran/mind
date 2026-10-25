# OmniMemEval (official LongMemEval-S benchmark)

This integration pins the third-party **MemTensor/OmniMemEval** evaluation
framework at commit `f7476c5502115542eca9971195bf8c5ca97b6256`.
Its original add/search/answer/judge/report pipeline and official prompts are
used unchanged. Only a small Mind backend adapter is added at runtime.

The local bridge delegates to Mind's `createSqliteStore` production API and
stores one dated memory per conversation session; one isolated space is used per
benchmark subject. The full session text is stored, not pre-extracted facts.
Search requests top-20 with `MIND_RAG=false`. No model participates in ingestion.
The index is erased between subjects through OmniMemEval's streaming mode.

The current push workflow is a **20-question smoke/pilot**, not a 500-question
leaderboard result. A full run can be requested using workflow_dispatch
`end_idx=499` *after* the pilot and cost/accuracy behavior are verified.

Answer and judge models match the published model families
(`openai/gpt-4.1-mini` and `openai/gpt-4o-mini`), but here run through
OpenRouter, whereas published OmniMemEval numbers use OpenAI. As a result,
even a complete 500-case result must be labeled an approximation to the public
comparison, not an identical provider execution.

GitHub Environment `Develop` must contain `OPENROUTER_API_KEY`. Do not commit
credentials or dataset. This is a paid workflow.
