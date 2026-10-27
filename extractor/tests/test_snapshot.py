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

DATA = Path(os.environ.get("CS2_STATS_DATA") or HERE.parents[2] / "cs2-stats-data")
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
    # The validation result carries the hit-table gap as a warning with exactly the HP the match row stores.
    hp = pl.read_parquet(ex.resolve_map_dir(tmp_path / "out") / "match.parquet")["unattributed_damage_hp"][0]
    warn = [c for c in res["validation"]["nonfatal_failed"] if c["check"] == "damage_events_incomplete"]
    assert [c["actual"] for c in warn] == ([hp] if hp else [])
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


def test_a_dropped_attempt_and_an_excluded_coach_leave_no_trace(tmp_path):
    # Fixture C (an HLTV Nuke map, 19 rounds): round 3 was restored after a long attempt (11516-57971), and one
    # team fielded a coach in a sixth slot, spawned every round and killed by his own hit from no weapon.
    src = FIXTURES / "fixture-c.dem"
    if not src.exists() or not MAPDATA.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {src}; dropped attempts and the coach exclusion are not being checked")
    res = ex.extract_demo(src, tmp_path / "out", source="hltv", mapdata=MAPDATA, archive="fixture")
    assert res["ok"], res["errors"]
    d = ex.resolve_map_dir(tmp_path / "out")
    match = pl.read_parquet(d / "match.parquet").row(0, named=True)
    coach = {int(x["steamid"]) for x in json.loads(match["excluded_players"])}
    dropped = json.loads(match["dropped_attempts"])
    assert len(coach) == 1 and [(x["round"], x["from_tick"], x["to_tick"]) for x in dropped] == [(3, 11516, 57971)]
    for f in d.glob("*.parquet"):
        df = pl.read_parquet(f)
        for c in [c for c in df.columns if c == "steamid" or c.endswith("_steamid")]:
            assert not df[c].is_in(list(coach)).any(), (f.name, c)
    pos = pl.read_parquet(d / "positions.parquet")
    assert not any(set(v) & coach for v in pos["spotted_by"].to_list())
    eng_ids = set(pl.read_parquet(d / "engagements.parquet")["engagement_id"].to_list())
    assert set(pl.read_parquet(d / "engagement_ticks.parquet")["engagement_id"].to_list()) <= eng_ids
    sides = pl.read_parquet(d / "player_rounds.parquet").group_by(["round", "side"]).len()["len"]
    assert sides.min() == sides.max() == 5
    rounds = pl.read_parquet(d / "rounds.parquet")
    assert rounds["round"].to_list() == list(range(1, 20)) and rounds["winner_side"].null_count() == 0
