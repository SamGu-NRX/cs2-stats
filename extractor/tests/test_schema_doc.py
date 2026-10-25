"""SCHEMA-v1.md is the contract the TS engine codes against; it must state exactly what the writer enforces."""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from schema_v1 import KEYS, NULLABLE, TYPES  # noqa: E402


def test_schema_doc_matches_the_enforced_types_nullability_and_keys():
    types, nullable, keys, table = {}, {}, {}, None
    for line in (ROOT / "SCHEMA-v1.md").read_text(encoding="utf-8").splitlines():
        if m := re.match(r"^### `(\w+)`", line):
            table = m[1]
            types[table], nullable[table] = {}, []
        elif table and "Key: " in line and not line.startswith("|"):
            k = line.split("Key: ", 1)[1].rstrip(".")
            if "row order" not in k:
                keys[table] = [c.strip(" `()") for c in re.split(r",|\+", k)]
        elif table and (m := re.match(r"^\| `([^`]+)` \| ([^|]+?) \| (yes|no) \|", line)):
            types[table][m[1]] = m[2]
            if m[3] == "yes":
                nullable[table].append(m[1])
    assert types == TYPES
    assert {t: sorted(c) for t, c in nullable.items()} == {t: sorted(c) for t, c in NULLABLE.items()}
    assert keys == KEYS


def test_no_key_column_may_hold_nulls():
    # engagement_ticks declared its key (engagement_id, tick) nullable, so the writer would have let a row
    # with no engagement or no tick through even though the duplicate-key check relies on both.
    nullable_keys = {t: sorted(set(k) & set(NULLABLE.get(t, []))) for t, k in KEYS.items()}
    assert {t: c for t, c in nullable_keys.items() if c} == {}
