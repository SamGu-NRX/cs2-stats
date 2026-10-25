"""Pin schema v1 output on real fixture demos: tables, dtypes, row counts and column checksums.

The fixtures are private (HLTV demos stay in the data folder), so this skips
loudly when they are absent. Fails if any table, column, dtype or value changes.
After an intended change, regenerate with UPDATE_SNAPSHOTS=1 and review the diff.
"""

import hashlib
import json
import os
import sys
from pathlib import Path

import polars as pl
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import extract as ex  # noqa: E402

DATA = Path(os.environ.get("CS2_STATS_DATA", r"C:\Users\sgu07\Programming Projects\cs2-stats-data"))
FIXTURES = DATA / "fixtures"
MAPDATA = DATA / "mapdata" / "2000935"
SNAPSHOTS = HERE / "snapshots"
# Values that legitimately change between runs.
VOLATILE = {("match", "parsed_at_utc")}
CASES = sorted(p.stem for p in SNAPSHOTS.glob("*.json"))


def column_checksum(s: pl.Series) -> str:
    h = hashlib.sha256()
    for v in s.to_list():
        h.update(repr(v).encode())
        h.update(b"\x1f")
    return h.hexdigest()[:16]


def snapshot_of(out: Path) -> dict:
    tables = {}
    for f in sorted(out.glob("*.parquet")):
        df = pl.read_parquet(f)
        tables[f.stem] = dict(rows=df.height, columns={
            c: [str(df.schema[c]), None if (f.stem, c) in VOLATILE else column_checksum(df[c])] for c in df.columns})
    return tables


@pytest.mark.parametrize("case", CASES)
def test_schema_v1_snapshot(case, tmp_path):
    expected = json.loads((SNAPSHOTS / f"{case}.json").read_text(encoding="utf-8"))
    dem = FIXTURES / f"{case}.dem"
    if not dem.exists() or not MAPDATA.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {dem} or {MAPDATA}; schema v1 is not being checked")
    assert ex.file_sha256(dem) == expected["demo_sha256"], "fixture demo differs from the one snapshotted"
    res = ex.extract_demo(dem, tmp_path / "out", source="hltv", mapdata=MAPDATA, archive="fixture")
    assert res["ok"], res["errors"]
    got = snapshot_of(ex.resolve_map_dir(tmp_path / "out"))
    if os.environ.get("UPDATE_SNAPSHOTS") == "1":
        expected["tables"] = got
        (SNAPSHOTS / f"{case}.json").write_text(json.dumps(expected, indent=1, sort_keys=True) + "\n",
                                                encoding="utf-8")
    assert got == expected["tables"]


def test_a_truncated_demo_is_extracted_through_its_last_complete_round(tmp_path):
    # Ten HLTV demos were cut off mid-file; awpy refuses them. A copy of fixture B (Ancient) cut at
    # 185 MB ends just after round 13 starts, so rounds 1-12 are complete and must validate exactly.
    src = FIXTURES / "fixture-b.dem"
    if not src.exists() or not MAPDATA.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {src}; truncated-demo handling is not being checked")
    cut = tmp_path / "fixture-b.dem"
    with open(src, "rb") as f, open(cut, "wb") as g:
        g.write(f.read(185_000_000))
    res = ex.extract_demo(cut, tmp_path / "out", source="hltv", mapdata=MAPDATA, archive="fixture")
    assert res["ok"], res["errors"]
    match = pl.read_parquet(ex.resolve_map_dir(tmp_path / "out") / "match.parquet").row(0, named=True)
    assert (match["truncated"], match["velocity_source"], match["n_rounds"], match["tick_rate"]) == (
        True, "position_diff", 12, 64.0)
