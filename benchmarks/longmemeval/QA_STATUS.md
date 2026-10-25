# LongMemEval-S QA status

Updated: 2026-10-25.

**Valid pilot completed:** 12 paired questions were answered and independently
judged with OpenRouter (DeepSeek V4.1 Flash 1017 as reader, GPT-4o-mini as
judge). Semantic embedding coverage and channel invocation were verified.

See [OPENROUTER_RESULTS.md](OPENROUTER_RESULTS.md) for measured results,
execution URLs, limitations and costs.

The previous OpenCode-free-model tool-free QA attempts did not finish. They
have no valid accuracy results. The earlier local Qwen pilot and the newer
OpenRouter pilot use different readers and judges and must not be conflated.

Neither the local nor OpenRouter pilots measure autonomous memory writing or
voluntary agent tool use. The reported accuracy is not an official LongMemEval
leaderboard score. The complete paid workflow is manual-only.
