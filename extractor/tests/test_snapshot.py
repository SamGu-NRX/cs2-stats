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


def test_a_finished_round_a_restore_rolled_back_is_dropped_and_the_map_validates(tmp_path):
    # Fixture E (an HLTV Ancient map, 20 rounds): round 2 ended at 20663, round 3 started, and a restore at 21912
    # loaded round 2's backup; round 2 was played again. Extractor 1.15.0 counted the first round 2 too (21 rounds,
    # one death too many for the player team-killed in it), and refused the team killer's attempt as explained
    # both ways. The recording opens on round 1's start, where the C4 pickup names nobody.
    src = FIXTURES / "fixture-e.dem"
    if not src.exists() or not MAPDATA.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {src}; rolled-back rounds are not being checked")
    res = ex.extract_demo(src, tmp_path / "out", source="hltv", mapdata=MAPDATA, archive="fixture")
    assert res["ok"], res["errors"]
    d = ex.resolve_map_dir(tmp_path / "out")
    match = pl.read_parquet(d / "match.parquet").row(0, named=True)
    dropped = json.loads(match["dropped_attempts"])
    assert match["n_rounds"] == 20 and [(x["round"], x["from_tick"], x["to_tick"]) for x in dropped] == [(2, 6571, 21912)]
    assert "rolled back" in dropped[0]["reason"]
    bomb = pl.read_parquet(d / "bomb.parquet")
    pickup = bomb.filter(pl.col("event") == "pickup").row(0, named=True)
    drop = bomb.filter(pl.col("event") == "dropped").row(0, named=True)
    # The tick-0 pickup goes to the player holding the C4 then, who is the one to drop it first.
    assert pickup["tick"] == 0 and pickup["steamid"] == drop["steamid"] and pickup["x"] is not None


def test_an_abandoned_map_is_refused_as_unplayed_instead_of_crashing(tmp_path):
    # Fixture F (an HLTV Nuke map HLTV lists no stats for): after 16 rounds, round 17 sat in freeze time for 9
    # minutes while players left, and the game gave it to the side left standing. By the next round start nobody had
    # a team, and extractor 1.15.0 crashed reading the scoreboard there ('DataFrame' object has no attribute
    # 'team_num').
    src = FIXTURES / "fixture-f.dem"
    if not src.exists() or not MAPDATA.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {src}; abandoned maps are not being checked")
    res = ex.extract_demo(src, tmp_path / "out", source="hltv", mapdata=MAPDATA, archive="fixture")
    assert not res["ok"] and res["errors"][0].startswith("RuntimeError: unplayed_round: round 17 never left freeze time")
    assert ex.resolve_map_dir(tmp_path / "out") is None


def test_blinds_after_a_detonation_the_recording_skipped_are_credited_to_that_flash(tmp_path):
    # Fixture G (an OpenCS2 Ancient map, 20 rounds): the recording skipped tick 90371, where a flashbang (entity 93)
    # detonated, and its event went with the tick. Three players' flash durations changed on 90372, and with no
    # detonation event to credit them the map failed: nulls in blinds.flash_entity_id.
    src = FIXTURES / "fixture-g.dem"
    if not src.exists() or not MAPDATA.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {src}; blinds of a skipped detonation are not being checked")
    res = ex.extract_demo(src, tmp_path / "out", source="hltv", mapdata=MAPDATA, archive="fixture")
    assert res["ok"], res["errors"]
    d = ex.resolve_map_dir(tmp_path / "out")
    blinds = pl.read_parquet(d / "blinds.parquet").filter(pl.col("tick") == 90372)
    # The throw was lost too, so no attacker is known.
    assert blinds["flash_entity_id"].to_list() == [93, 93, 93] and blinds["attacker_steamid"].null_count() == 3
    # Its detonation is added on the skipped tick, flagged, so the blinds link to it and not to an older flash 93.
    events = pl.read_parquet(d / "grenade_events.parquet")
    recovered = events.filter(pl.col("recovered")).select(["tick", "event", "entity_id", "steamid"]).rows()
    assert recovered == [(90371, "flash_detonate", 93, None)]


def test_a_player_who_left_before_his_counters_were_set_does_not_fail_the_map(tmp_path):
    # Fixture H (an OpenCS2 Ancient map, 19 rounds): a player took a T slot as round 3 started and left 4 s later,
    # with no kill, death or damage, and is not on the final scoreboard. Reading the counters of players who left
    # failed twice: the read went to a loop variable that had reused the name of the tick reader (AttributeError:
    # 'str' object has no attribute 'parse_ticks'), and his counters, never set, read null (int(NaN)). Four
    # OpenCS2 maps failed this way.
    src = FIXTURES / "fixture-h.dem"
    if not src.exists() or not MAPDATA.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {src}; players who left before the end are not being checked")
    res = ex.extract_demo(src, tmp_path / "out", source="hltv", mapdata=MAPDATA, archive="fixture")
    assert res["ok"], res["errors"]
    match = pl.read_parquet(ex.resolve_map_dir(tmp_path / "out") / "match.parquet").row(0, named=True)
    # He has no reading, so no departed row; the two who left on the last tick are on the final scoreboard.
    assert (match["n_rounds"], match["departed"]) == (19, "[]")

def test_blinds_inside_a_voided_attempt_go_with_its_detonations(tmp_path):
    # Fixture I (an OpenCS2 Ancient map, 42 rounds): a backup restore voided ticks 208751-228731. A flashbang
    # detonated on tick 210634 inside it and blinded three players there. The detonation was left out with the
    # attempt, and the blinds were credited first: no detonation on their tick, and the map failed. 26 OpenCS2
    # maps failed this way.
    src = FIXTURES / "fixture-i.dem"
    if not src.exists() or not MAPDATA.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {src}; blinds in a voided attempt are not being checked")
    res = ex.extract_demo(src, tmp_path / "out", source="hltv", mapdata=MAPDATA, archive="fixture")
    assert res["ok"], res["errors"]
    d = ex.resolve_map_dir(tmp_path / "out")
    match = pl.read_parquet(d / "match.parquet").row(0, named=True)
    assert json.loads(match["voided_windows"]) == [[208751, 228731]]
    blinds = pl.read_parquet(d / "blinds.parquet")
    assert blinds.filter((pl.col("tick") >= 208751) & (pl.col("tick") <= 228731)).height == 0
    assert pl.read_parquet(d / "grenade_events.parquet").filter(pl.col("recovered")).height == 0

def test_a_hit_on_a_rounds_start_tick_counts_in_the_round_before(tmp_path):
    # Fixture K (an OpenCS2 Mirage map, 20 rounds): a post-round hit (26 HP) landed on round 11's start tick,
    # 91619. The game committed it into the damage counter read there, round 10's game_damage; the hit table put
    # it in round 11, 26 HP over round 11's counter, and the map failed. 5 OpenCS2 maps failed this way.
    src = FIXTURES / "fixture-k.dem"
    if not src.exists() or not MAPDATA.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {src}; a hit on a round's start tick is not being checked")
    res = ex.extract_demo(src, tmp_path / "out", source="hltv", mapdata=MAPDATA, archive="fixture")
    assert res["ok"], res["errors"]
    d = ex.resolve_map_dir(tmp_path / "out")
    hits = pl.read_parquet(d / "damages.parquet").filter(pl.col("tick") == 91619)
    assert hits.select(["round", "dmg_health_capped"]).rows() == [(10, 26)]
