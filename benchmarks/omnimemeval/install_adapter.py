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
print("Mind client registered in pinned OmniMemEval checkout")
