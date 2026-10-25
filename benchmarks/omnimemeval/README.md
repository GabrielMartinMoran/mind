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

The initial smoke/pilot used the first 20 questions (all single-session-user),
so 20/20 is not an overall score. The first follow-up push evaluated 120 deterministic, interleaved questions
(20 per category). This push runs the full 500 original questions;
workflow_dispatch also supports 60/120 stratified pilots. Report smaller runs
as pilots. At the observed ~47k answer input tokens/question, the full run
could consume ~24 million GPT-4.1-mini tokens (~US$10 before judge/output).

Answer and judge models match the published model families
(`openai/gpt-4.1-mini` and `openai/gpt-4o-mini`), but here run through
OpenRouter, whereas published OmniMemEval numbers use OpenAI. As a result,
even a complete 500-case result must be labeled an approximation to the public
comparison, not an identical provider execution.

GitHub Environment `Develop` must contain `OPENROUTER_API_KEY`. Do not commit
credentials or dataset. This is a paid workflow.
