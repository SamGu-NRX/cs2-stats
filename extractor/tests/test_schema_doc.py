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


def test_derived_metrics_the_engine_owns_are_not_schema_columns():
    # kills.trade_kill_5s / traded_death_5s (a 5 s window) and rounds.*_buy_type (team-total bands) looked
    # like the engine's trade and buy-type metrics, which use 5.4 s and per-player bands. The buy types are
    # gone; the trade flags stay only as extractor_* columns, documented as such, for model/rating3.
    columns = {(t, c) for t, cols in TYPES.items() for c in cols}
    assert not {(t, c) for t, c in columns if c.endswith("buy_type") or c in ("trade_kill_5s", "traded_death_5s",
                                                                            "trade_window_s")}
    internal = {(t, c) for t, c in columns if c.startswith("extractor_") and c != "extractor_version"}
    assert internal == {("kills", "extractor_trade_kill_5s"), ("kills", "extractor_traded_death_5s"),
                        ("match", "extractor_trade_window_s")}
    doc = (ROOT / "SCHEMA-v1.md").read_text(encoding="utf-8")
    for _, c in internal - {("match", "extractor_trade_window_s")}:
        row = next(line for line in doc.splitlines() if line.startswith(f"| `{c}` |"))
        assert "extractor-internal" in row and "UI must not show it" in row

