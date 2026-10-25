"""Reproducible balanced sampling of the original LongMemEval-S questions."""
import hashlib
import json
import sys
from collections import defaultdict
from pathlib import Path

path = Path(sys.argv[1])
count = int(sys.argv[2])
if count not in {20, 60, 120, 500}:
    raise SystemExit("sample_size must be 20, 60, 120 or 500")
questions = json.loads(path.read_text())
if len(questions) != 500:
    raise RuntimeError("Expected 500 official LongMemEval-S questions")
if count == 500:
    print("Full dataset: 500 official questions in original order")
    raise SystemExit(0)

by_category = defaultdict(list)
for row in questions:
    by_category[row["question_type"]].append(row)
if len(by_category) != 6:
    raise RuntimeError("Unexpected LongMemEval-S category count")
per_category = count // 6
groups = []
for category, rows in sorted(by_category.items()):
    ranked = sorted(
        rows,
        key=lambda row: hashlib.sha256(
            ("mind-omnimemeval-v1:" + str(row["question_id"])).encode()
        ).hexdigest(),
    )
    groups.append(ranked[:per_category])
sample = [group[index] for index in range(per_category) for group in groups]
assert len(sample) == count
path.write_text(json.dumps(sample, ensure_ascii=False))
print("Stratified:", count, "questions,", per_category, "per category")
