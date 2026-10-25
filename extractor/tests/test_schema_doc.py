"""SCHEMA-v1.md is the contract the TS engine codes against; it must list exactly the types the writer enforces."""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from schema_v1 import TYPES  # noqa: E402


def test_schema_doc_matches_the_enforced_types():
    doc, table = {}, None
    for line in (ROOT / "SCHEMA-v1.md").read_text(encoding="utf-8").splitlines():
        if m := re.match(r"^### `(\w+)`", line):
            table = doc.setdefault(m[1], {})
        elif table is not None and (m := re.match(r"^\| `([^`]+)` \| ([^|]+?) \| (yes|no) \|", line)):
            table[m[1]] = m[2]
    assert doc == TYPES
