#!/usr/bin/env python3
"""Install the Mind adapter into a pinned local OmniMemEval checkout."""
from pathlib import Path
import shutil
import sys

upstream = Path(sys.argv[1])
here = Path(__file__).resolve().parent
factory = upstream / "scripts/client_factory"
shutil.copy2(here / "mind_client.py", factory / "mind_client.py")
registry = factory / "registry.py"
source = registry.read_text()
marker = '    "memos":       ("memos_client",       "MemosClient"),'
assert marker in source, "Upstream registry layout changed"
registry.write_text(source.replace(marker, marker + '\n    "mind":        ("mind_client",        "MindClient"),'))
search = upstream / "scripts/utils/search_helpers.py"
source = search.read_text()
marker = '    "memos": generic_text_search,'
assert marker in source, "Upstream search dispatch changed"
search.write_text(source.replace(marker, marker + '\n    "mind": generic_text_search,'))
# OmniMemEval hardcodes temperature=0 for both the answerer and judge.
# Reasoning models reject that setting. Keep its prompts/scorer unchanged;
# switch only the request parameters to OpenRouter's documented Luna LOW mode.
def configure_luna_low(path: Path) -> None:
    source = path.read_text()
    original = "            temperature=0,"
    # Answer and judge have different indentation. Preserve the original one.
    import re
    matches = re.findall(r"(?m)^([ ]*)temperature=0,", source)
    if len(matches) != 1:
        raise RuntimeError(f"Expected exactly one pinned temperature argument: {path}")
    indentation = matches[0]
    updated = source.replace(
        f"{indentation}temperature=0,",
        f'{indentation}extra_body={{"reasoning": {{"effort": "low"}}}},',
    )
    path.write_text(updated)


for target in ("lme_responses.py", "lme_eval.py"):
    configure_luna_low(upstream / "scripts" / "longmemeval" / target)

print("Mind adapter registered; answer and judge configured for GPT-6 Luna LOW")
