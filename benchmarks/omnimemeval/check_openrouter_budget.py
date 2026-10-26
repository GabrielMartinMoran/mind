"""Fail early if the OpenRouter key cannot cover an OmniMemEval run.

Never logs credentials or the full key metadata. Remaining credit is a
preflight indicator, not a hard upper bound on total benchmark spend.
"""
import json
import os
import sys
from urllib.request import Request, urlopen

# Conservative startup minimums, not strict spending caps. Luna's base prices
# are lower than the former answer/judge models; actual usage varies with
# prompt caching, output length, reasoning tokens and optional embeddings.
MINIMUM_USD = {"60": 1.5, "120": 3.0, "500": 12.0}


def check_budget(sample_size: str) -> None:
    if sample_size not in MINIMUM_USD:
        raise ValueError("Unsupported OmniMemEval sample size")
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise RuntimeError("Develop environment has no OPENROUTER_API_KEY")

    request = Request(
        "https://openrouter.ai/api/v1/key",
        headers={"Authorization": f"Bearer {key}"},
    )
    with urlopen(request, timeout=30) as response:
        data = json.load(response)["data"]

    remaining = [
        float(value)
        for value in (
            data.get("limit_remaining"),
            (data.get("effective_budget") or {}).get("remaining_usd"),
        )
        if isinstance(value, (int, float))
    ]
    threshold = MINIMUM_USD[sample_size]
    if not remaining:
        raise RuntimeError("Cannot verify available OpenRouter credit; no spend performed")
    actual = min(remaining)
    print(f"OpenRouter key: remaining limit ${actual:.2f}, preflight threshold ${threshold:.2f}")
    if actual < threshold:
        raise RuntimeError(
            "Insufficient OpenRouter budget for a reliable benchmark run. "
            "No paid model or embedding calls were made."
        )


if __name__ == "__main__":
    check_budget(sys.argv[1])
