"""stitch.py on synthetic parts: when a split recording joins into one map, and what the joined tables hold."""

import json
import os
import sys
from dataclasses import replace
from pathlib import Path

import polars as pl
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import schema_v1  # noqa: E402
import stitch  # noqa: E402

A1, A2, B1, B2 = 1, 2, 3, 4  # team A: A1, A2; team B: B1, B2 (two a side keeps the tables short)
IDENT = dict(map="de_nuke", tick_rate=64.0, source="hltv", archive="a-vs-b-1", team1_file="a", team2_file="b",
             map_key="m1-nuke", mp_maxrounds=4, mp_overtime_maxrounds=6)


def test_sides_swap_at_each_halftime_and_never_at_an_overtimes_start():
    assert [r for r in range(2, 41) if stitch.swaps_at(r, 24, 6)] == [13, 28, 34, 40]


@pytest.mark.parametrize("a, b, over", [(13, 11, True), (13, 12, False), (12, 12, False), (16, 13, True),
                                        (16, 12, True), (15, 12, False), (19, 16, True), (17, 16, False)])
def test_a_final_score_ends_the_match_only_as_mr12_and_its_overtimes_allow(a, b, over):
    assert stitch.match_over(a, b, 24, 6) is over


def _part(n, winners, score_start, ct_first, ct_last, start, end):
    score_end = dict(score_start)
    for w in winners:
        score_end[w] += 1
    return stitch.Part(n=n, extractor_version="1.15.0", first_round=sum(score_start.values()) + 1,
                       n_rounds=len(winners), score_start=score_start, score_end=score_end,
                       rosters={"A": frozenset({A1, A2}), "B": frozenset({B1, B2})}, ct_first=ct_first,
                       ct_last=ct_last, start=start, end=end, max_rounds=4, ot_max=6, identity=IDENT)


# An MR4 match (halftime after round 2) recorded in two parts: 1-1 at the cut, A wins 3-1. In each part A1 kills
# B2 in its first round and B1 kills A2 in its second, each with 100 damage.
ZERO = {s: (0, 0, 0, 0, 0) for s in (A1, A2, B1, B2)}
MID = {A1: (1, 0, 0, 100, 0), A2: (0, 1, 0, 0, 0), B1: (1, 0, 0, 100, 0), B2: (0, 1, 0, 0, 0)}
END = {A1: (2, 0, 0, 200, 0), A2: (0, 2, 0, 0, 0), B1: (2, 0, 0, 200, 0), B2: (0, 2, 0, 0, 0)}
P1 = _part(1, ["A", "B"], {"A": 0, "B": 0}, "A", "A", ZERO, MID)
P2 = _part(2, ["A", "A"], {"A": 1, "B": 1}, "B", "B", MID, END)


def test_two_continuous_parts_that_end_the_match_join():
    assert stitch.plan([P2, P1], "1.15.0") is None


@pytest.mark.parametrize("parts, reason", [
    ([P2], "part 1 missing"),
    ([P1], "only part 1 is here"),
    ([P1, replace(P2, n=3)], "part 2 missing"),
    ([P1, replace(P2, first_round=4)], "gap: part 2 starts at round 4"),
    ([P1, replace(P2, first_round=2)], "overlap: part 2 starts at round 2"),
    ([P1, replace(P2, score_start={"A": 2, "B": 0})], "score: part 1 ends at"),
    ([P1, replace(P2, rosters={"A": frozenset({A1, 9}), "B": frozenset({B1, B2})})], "rosters differ"),
    ([P1, replace(P2, start={**MID, A1: (2, 0, 0, 100, 0)})], "counters of 1 player(s) changed"),
    ([P1, replace(P2, start={**MID, 9: (0, 0, 0, 0, 0)})], "neither on part 1's final scoreboard nor among those who left"),
    ([P1, replace(P2, ct_first="A")], "the teams swap there"),
    ([P1, replace(P2, score_end={"A": 2, "B": 2})], "before the match does"),
    ([P1, replace(P2, extractor_version="1.14.0")], "extractor 1.14.0, 1.15.0"),
    ([P1, replace(P2, identity={**IDENT, "map": "de_mirage"})], "map differs: part 1 'de_nuke', part 2 'de_mirage'"),
    ([P1, replace(P2, identity={**IDENT, "tick_rate": 128.0})], "tick_rate differs"),
    ([P1, replace(P2, identity={**IDENT, "source": "valve"})], "source differs"),
    ([P1, replace(P2, identity={**IDENT, "archive": "a-vs-b-2"})], "archive differs"),
    ([P1, replace(P2, identity={**IDENT, "team2_file": "c"})], "team2_file differs"),
    ([P1, replace(P2, identity={**IDENT, "map_key": "m2-nuke"})], "map_key differs"),
])
def test_parts_that_do_not_provably_make_one_match_are_held(parts, reason):
    assert reason in stitch.plan(parts, "1.15.0")


def _tables(part, score_start, winners, ct, start, end, gone=(), departed=(), **match):
    """One part's tables: two rounds of 1000 ticks each; A1 kills B2 in the first and B1 kills A2 in the second,
    each with an engagement and a flashbang projectile. gone: players off the final scoreboard; departed: their
    match.departed rows."""
    other = {"A": "B", "B": "A"}
    ct_after = [int(winners[0] == ct), int(winners[0] == ct) + int(winners[1] == ct)]
    rounds = pl.DataFrame(dict(round=[1, 2], start_tick=[0, 1000], end_tick=[900, 1900], ct_team=[ct, ct],
                               t_team=[other[ct]] * 2, winner_team=winners, ct_team_score_after=ct_after,
                               t_team_score_after=[1 - ct_after[0], 2 - ct_after[1]]))
    team = {A1: "A", A2: "A", B1: "B", B2: "B"}
    side = {s: "CT" if team[s] == ct else "T" for s in team}
    pr = pl.DataFrame([dict(round=r, steamid=s, side=side[s], tick=r * 1000 - 700,
                            game_damage=100 if (r, s) in ((1, A1), (2, B1)) else 0) for r in (1, 2) for s in side])
    sb = pl.DataFrame([dict(steamid=s, team_clan_name=team[s], tick=2000, team_rounds_total_at_start=score_start[team[s]],
                            team_rounds_total=score_start[team[s]] + winners.count(team[s]),
                            **{c: end[s][i] for i, c in enumerate(stitch.CARRIED)},
                            **{f"{c}_at_start": start[s][i] for i, c in enumerate(stitch.CARRIED)})
                       for s in side if s not in gone])
    players = pl.DataFrame([dict(steamid=s, name=f"p{s}", is_bot=False, team=team[s], side_h1=None, side_h2=None,
                                 side_ot=[], rounds_present=2) for s in side],
                           schema=dict(steamid=pl.Int64, name=pl.String, is_bot=pl.Boolean, team=pl.String,
                                       side_h1=pl.String, side_h2=pl.String, side_ot=pl.List(pl.String),
                                       rounds_present=pl.Int64))
    m = dict(extractor_version="1.15.0", convars=json.dumps(dict(mp_maxrounds="4")), map_key=f"m1-nuke-p{part}",
             dem_file=f"x-m1-nuke-p{part}.dem", demo_sha256=str(part) * 64, dem_bytes=10, final_tick=2000,
             playback_ticks=2100, team_ct_start=ct, team_t_start=other[ct], score_ct_start=0, score_t_start=0,
             match_start_tick=0, truncated=False, extra="{}", unattributed_damage_hp=0, n_rounds=2,
             voided_windows="[[100, 200]]", dropped_attempts="[]", excluded_players="[]", parts="[]", parsed_at_utc="",
             departed=json.dumps(list(departed)), scoreboard_taken="{}",
             **{k: v for k, v in IDENT.items() if k in stitch.IDENTITY})
    m.update(match)
    kills = pl.DataFrame(dict(tick=[500, 1500], round=[1, 2], attacker_steamid=[A1, B1], victim_steamid=[B2, A2],
                              assister_steamid=[None, None], assister_side=[None, None], v_side=[side[B2], side[A2]],
                              is_teamkill=[False, False], is_suicide=[False, False], headshot=[False, False]),
                         schema_overrides=dict(attacker_steamid=pl.UInt64, victim_steamid=pl.UInt64,
                                               assister_steamid=pl.UInt64, assister_side=pl.String))
    return dict(match=pl.DataFrame([m]), rounds=rounds, scoreboard=sb, player_rounds=pr, players=players, kills=kills,
                engagements=pl.DataFrame(dict(engagement_id=[0, 1], round=[1, 2], start_tick=[400, 1400])),
                engagement_ticks=pl.DataFrame(dict(engagement_id=[0, 1], tick=[401, 1401])),
                grenade_paths=pl.DataFrame(dict(projectile=[0, 0, 1], entity_id=[150, 150, 150], tick=[300, 310, 1300])),
                grenade_throws=pl.DataFrame(dict(tick=[290, 1290], steamid=[A1, B1], projectile=[0, 1], entity_id=[150, 150])),
                events_misc=pl.DataFrame(dict(tick=[5, 600], round=[0, 1], event=["warmup", "x"])))


def _two_parts(**kw2):
    t1 = _tables(1, {"A": 0, "B": 0}, ["A", "B"], "A", ZERO, MID)
    t2 = _tables(2, {"A": 1, "B": 1}, ["A", "A"], "B", MID, END, **kw2)
    return [t1, t2], [stitch.part_facts(1, t1), stitch.part_facts(2, t2)]


def test_the_joined_map_runs_on_the_matchs_rounds_and_one_tick_line():
    tables, facts = _two_parts()
    assert facts[1].first_round == 3 and stitch.plan(facts, "1.15.0") is None
    out = stitch.stitch(tables, facts)
    r = out["rounds"]
    # Part 1 ends on tick 2100 (its playback length), so part 2 starts at 2101.
    assert r["round"].to_list() == [1, 2, 3, 4] and r["start_tick"].to_list() == [0, 1000, 2101, 3101]
    # Part 2 counted its scores from 0; the match's line starts it at 1-1. B was CT there and lost both.
    assert r["ct_team_score_after"].to_list() == [1, 1, 1, 1] and r["t_team_score_after"].to_list() == [0, 1, 2, 3]
    assert out["kills"]["round"].to_list() == [1, 2, 3, 4] and out["kills"]["tick"].to_list() == [500, 1500, 2601, 3601]
    assert out["engagements"]["engagement_id"].to_list() == [0, 1, 2, 3]
    assert out["engagement_ticks"]["engagement_id"].to_list() == [0, 1, 2, 3]
    assert out["events_misc"]["round"].to_list() == [0, 1, 0, 3]  # warmup rows stay round 0
    sb = out["scoreboard"].sort("steamid")
    assert sb["kills_total"].to_list() == [2, 0, 2, 0] and sb["kills_total_at_start"].to_list() == [0, 0, 0, 0]
    m = out["match"].row(0, named=True)
    assert (m["map_key"], m["n_rounds"], m["score_ct_start"], m["score_t_start"]) == ("m1-nuke", 4, 3, 1)
    assert [p["tick_offset"] for p in json.loads(m["parts"])] == [0, 2101]
    assert json.loads(m["voided_windows"]) == [[100, 200], [2201, 2301]]
    sides = dict(out["players"].select("steamid", "side_h1").iter_rows())
    assert sides[A1] == "CT" and sides[B1] == "T"
    assert stitch.join_failures(out) == []


def test_projectiles_get_numbers_unique_in_the_match_and_entity_indices_stay_the_games():
    # Both parts number their projectiles from 0; projectile is unique in the match.
    out = stitch.stitch(*_two_parts())
    assert out["grenade_paths"]["projectile"].to_list() == [0, 0, 1, 2, 2, 3]
    assert out["grenade_throws"]["projectile"].to_list() == [0, 1, 2, 3]
    assert out["grenade_paths"]["entity_id"].to_list() == [150] * 6


def test_every_id_column_in_the_schema_is_either_offset_or_kept_as_the_games():
    def looks_like_an_id(c):
        return c.endswith(("_id", "_entity", "entity_id")) or c in ("projectile", "entity")

    found = {c for cols in schema_v1.TYPES.values() for c in cols if looks_like_an_id(c)}
    assert found - {"match_id"} <= set(stitch.OFFSET_IDS) | set(stitch.GAME_IDS), \
        f"ID columns stitch.py does not place: {sorted(found - {'match_id'} - set(stitch.OFFSET_IDS) - set(stitch.GAME_IDS))}"
    assert not set(stitch.OFFSET_IDS) & set(stitch.GAME_IDS)


def test_tables_of_two_maps_are_held_with_the_field_that_differs():
    tables, facts = _two_parts(map="de_mirage")
    assert stitch.plan(facts, "1.15.0") == "map differs: part 1 'de_nuke', part 2 'de_mirage'"


# A2 left during part 1 and is back at part 2's start. He had a kill before round 1 that the game kept (his
# baseline is 1), so his counters run one above the events'.
A2_GONE = dict(steamid=A2, tick=1700, kills_total=1, deaths_total=1, assists_total=0, damage_total=0,
               headshot_kills_total=0, team_rounds_total=1, kills_total_at_start=1, deaths_total_at_start=0,
               assists_total_at_start=0, damage_total_at_start=0, headshot_kills_total_at_start=0,
               team_rounds_total_at_start=0)


def _departure(a2_at_part_2_start):
    t1 = _tables(1, {"A": 0, "B": 0}, ["A", "B"], "A", ZERO, MID, gone={A2}, departed=[A2_GONE])
    mid2, end2 = {**MID, A2: a2_at_part_2_start}, {**END, A2: (1, 2, 0, 0, 0)}
    t2 = _tables(2, {"A": 1, "B": 1}, ["A", "A"], "B", mid2, end2)
    return [t1, t2], [stitch.part_facts(1, t1), stitch.part_facts(2, t2)]


def test_a_player_who_left_before_the_cut_carries_his_counters_and_baseline_across_it():
    tables, facts = _departure((1, 1, 0, 0, 0))
    assert stitch.plan(facts, "1.15.0") is None
    out = stitch.stitch(tables, facts)
    a2 = out["scoreboard"].filter(pl.col("steamid") == A2).row(0, named=True)
    assert a2["kills_total_at_start"] == 1  # part 1's departed row, not 0
    assert stitch.join_failures(out) == []
    assert json.loads(out["match"]["departed"][0]) == []  # he is on the final scoreboard


def test_a_player_whose_counters_moved_while_he_was_gone_is_held():
    _, facts = _departure((2, 1, 0, 0, 0))
    assert "counters of 1 player(s) changed" in stitch.plan(facts, "1.15.0")


def test_a_join_whose_scoreboard_the_events_do_not_explain_is_held(monkeypatch, tmp_path):
    # Each part's numbers carry over, but part 2's final scoreboard gives A1 a kill no part's events hold.
    tables, _ = _two_parts()
    tables[1]["scoreboard"] = tables[1]["scoreboard"].with_columns(
        pl.when(pl.col("steamid") == A1).then(3).otherwise(pl.col("kills_total")).alias("kills_total"))
    monkeypatch.setattr(stitch, "read_tables", lambda d, ignore_retired=False: tables[int(d.name[-1]) - 1])
    monkeypatch.setattr(stitch.extract, "EXTRACTOR_VERSION", "1.15.0")
    row = stitch.stitch_map({1: tmp_path / "m1-nuke-p1", 2: tmp_path / "m1-nuke-p2"}, tmp_path / "m1-nuke")
    assert row["status"] == "held" and row["reason"].startswith("the joined scoreboard fails 1 check(s); first: kills")
    assert not (tmp_path / "m1-nuke").exists()


# --- a real split recording (private fixture) ----------------------------------------------------------------

DATA = Path(os.environ.get("CS2_STATS_DATA") or Path(__file__).resolve().parents[3] / "cs2-stats-data")
SPLIT = [DATA / "fixtures" / f"fixture-d-vs-split-m1-cache-p{n}.dem" for n in (1, 2)]
MAPDATA = DATA / "mapdata" / "2000935"


def test_a_real_split_recording_stitches_through_the_writer(tmp_path):
    # Fixture D: an HLTV Cache map recorded as two demos, cut between rounds. Each part is extracted, joined
    # by stitch_map and written by write_output, as the pipeline does.
    if not all(p.exists() for p in SPLIT) or not MAPDATA.exists():
        pytest.skip(f"PRIVATE FIXTURE MISSING: {SPLIT[0].parent}/fixture-d-vs-split-m1-cache-p1.dem and -p2.dem; "
                    "stitching a real split recording is not being checked")
    dirs = {}
    for n, dem in enumerate(SPLIT, 1):
        res = stitch.extract.extract_demo(dem, tmp_path / "parts" / f"m1-cache-p{n}", source="hltv", mapdata=MAPDATA,
                                          archive="fixture")
        assert res["ok"], res["errors"]
        dirs[n] = tmp_path / "parts" / f"m1-cache-p{n}"
    row = stitch.stitch_map(dirs, tmp_path / "demos" / "m1-cache")
    assert row["status"] == "stitched", row.get("reason")
    out = stitch.read_tables(tmp_path / "demos" / "m1-cache")
    m = out["match"].row(0, named=True)
    p1, p2 = json.loads(m["parts"])
    cut = p2["first_round"]
    assert out["rounds"]["round"].to_list() == list(range(1, m["n_rounds"] + 1)) and cut > 1
    # Damage on both sides of the cut: each round's hits add up to the game's own per-round damage, and the
    # match's damage totals to the scoreboard's.
    hits = (out["damages"].filter(~pl.col("is_team_damage") & pl.col("attacker_steamid").is_not_null())
            .group_by("round", "attacker_steamid").agg(pl.col("dmg_health_capped").sum().alias("hits")))
    game = out["player_rounds"].select("round", pl.col("steamid").alias("attacker_steamid"), "game_damage")
    for r in (cut - 1, cut):
        j = game.filter(pl.col("round") == r).join(hits.filter(pl.col("round") == r), on=["round", "attacker_steamid"],
                                                   how="left").fill_null(0)
        assert j["game_damage"].sum() > 0 and (j["game_damage"] == j["hits"]).all(), r
        assert out["damages"].filter(pl.col("round") == r)["tick"].min() >= (p2["tick_offset"] if r == cut else 0)
    sb = out["scoreboard"]
    assert (sb["damage_total"] - sb["damage_total_at_start"]).sum() == out["player_rounds"]["game_damage"].sum()
    assert stitch.join_failures(out) == []
    # Projectiles: numbers unique in the match, part 2's past part 1's, each throw's projectile in its own round.
    paths, throws = out["grenade_paths"], out["grenade_throws"].drop_nulls("projectile")
    first2 = paths.filter(pl.col("tick") >= p2["tick_offset"])["projectile"].min()
    assert first2 is not None and first2 > paths.filter(pl.col("tick") < p2["tick_offset"])["projectile"].max()
    spans = paths.group_by("projectile").agg(pl.col("tick").min().alias("a"), pl.col("tick").max().alias("b"))
    assert spans.filter((pl.col("a") < p2["tick_offset"]) & (pl.col("b") >= p2["tick_offset"])).height == 0
    linked = throws.join(spans, on="projectile")
    assert linked.height == throws.height and (linked["a"] >= linked["tick"]).all()
