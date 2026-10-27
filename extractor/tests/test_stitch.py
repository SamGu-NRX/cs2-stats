"""stitch.py on synthetic parts: when a split recording joins into one map, and what the joined tables hold."""

import json
import sys
from dataclasses import replace
from pathlib import Path

import polars as pl
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import stitch  # noqa: E402

A1, A2, B1, B2 = 1, 2, 3, 4  # team A: A1, A2; team B: B1, B2 (two a side keeps the tables short)


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
                       ct_last=ct_last, start=start, end=end, max_rounds=4, ot_max=6)


# An MR4 match (halftime after round 2) recorded in two parts: 1-1 at the cut, A wins 3-1.
ZERO = {s: (0, 0, 0, 0, 0) for s in (A1, A2, B1, B2)}
MID = {A1: (1, 1, 0, 100, 0), A2: (0, 1, 0, 50, 0), B1: (1, 0, 0, 100, 0), B2: (1, 1, 0, 100, 0)}
END = {s: (9, 9, 0, 0, 0) for s in MID}
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
    ([P1, replace(P2, start={**MID, A1: (2, 1, 0, 100, 0)})], "counters of 1 player(s) changed"),
    ([P1, replace(P2, ct_first="A")], "the teams swap there"),
    ([P1, replace(P2, score_end={"A": 2, "B": 2})], "before the match does"),
    ([P1, replace(P2, extractor_version="1.14.0")], "extractor 1.14.0, 1.15.0"),
])
def test_parts_that_do_not_provably_make_one_match_are_held(parts, reason):
    assert reason in stitch.plan(parts, "1.15.0")


def _tables(part, score_start, winners, ct, start, end):
    """One part's tables: two rounds of 1000 ticks each, a kill and an engagement in each round."""
    other = {"A": "B", "B": "A"}
    ct_after = [int(winners[0] == ct), int(winners[0] == ct) + int(winners[1] == ct)]
    rounds = pl.DataFrame(dict(round=[1, 2], start_tick=[0, 1000], end_tick=[900, 1900], ct_team=[ct, ct],
                               t_team=[other[ct]] * 2, winner_team=winners, ct_team_score_after=ct_after,
                               t_team_score_after=[1 - ct_after[0], 2 - ct_after[1]]))
    team = {A1: "A", A2: "A", B1: "B", B2: "B"}
    side = {s: "CT" if team[s] == ct else "T" for s in team}
    pr = pl.DataFrame([dict(round=r, steamid=s, side=side[s], tick=r * 1000 - 700) for r in (1, 2) for s in side])
    sb = pl.DataFrame([dict(steamid=s, team_clan_name=team[s], tick=2000, team_rounds_total_at_start=score_start[team[s]],
                            team_rounds_total=score_start[team[s]] + winners.count(team[s]),
                            **{c: end[s][i] for i, c in enumerate(stitch.CARRIED)},
                            **{f"{c}_at_start": start[s][i] for i, c in enumerate(stitch.CARRIED)}) for s in side])
    players = pl.DataFrame([dict(steamid=s, name=f"p{s}", is_bot=False, team=team[s], side_h1=None, side_h2=None,
                                 side_ot=[], rounds_present=2) for s in side],
                           schema=dict(steamid=pl.Int64, name=pl.String, is_bot=pl.Boolean, team=pl.String,
                                       side_h1=pl.String, side_h2=pl.String, side_ot=pl.List(pl.String),
                                       rounds_present=pl.Int64))
    match = pl.DataFrame([dict(
        extractor_version="1.15.0", convars=json.dumps(dict(mp_maxrounds="4")), map_key=f"m1-nuke-p{part}",
        dem_file=f"x-m1-nuke-p{part}.dem", demo_sha256=str(part) * 64, dem_bytes=10, final_tick=2000,
        playback_ticks=2100, team_ct_start=ct, team_t_start=other[ct], score_ct_start=0, score_t_start=0,
        match_start_tick=0, truncated=False, extra="{}", unattributed_damage_hp=0, n_rounds=2,
        voided_windows="[[100, 200]]", dropped_attempts="[]", excluded_players="[]", parts="[]", parsed_at_utc="")])
    return dict(match=match, rounds=rounds, scoreboard=sb, player_rounds=pr, players=players,
                kills=pl.DataFrame(dict(tick=[500, 1500], round=[1, 2], attacker_steamid=[A1, B1],
                                        victim_steamid=[B2, A2])),
                engagements=pl.DataFrame(dict(engagement_id=[0, 1], round=[1, 2], start_tick=[400, 1400])),
                engagement_ticks=pl.DataFrame(dict(engagement_id=[0, 1], tick=[401, 1401])),
                events_misc=pl.DataFrame(dict(tick=[5, 600], round=[0, 1], event=["warmup", "x"])))


def test_the_joined_map_runs_on_the_matchs_rounds_and_one_tick_line():
    t1 = _tables(1, {"A": 0, "B": 0}, ["A", "B"], "A", ZERO, MID)
    t2 = _tables(2, {"A": 1, "B": 1}, ["A", "A"], "B", MID, END)
    facts = [stitch.part_facts(1, t1), stitch.part_facts(2, t2)]
    assert facts[1].first_round == 3 and stitch.plan(facts, "1.15.0") is None
    out = stitch.stitch([t1, t2], facts)
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
    assert sb["kills_total"].to_list() == [9, 9, 9, 9] and sb["kills_total_at_start"].to_list() == [0, 0, 0, 0]
    m = out["match"].row(0, named=True)
    assert (m["map_key"], m["n_rounds"], m["score_ct_start"], m["score_t_start"]) == ("m1-nuke", 4, 3, 1)
    assert [p["tick_offset"] for p in json.loads(m["parts"])] == [0, 2101]
    assert json.loads(m["voided_windows"]) == [[100, 200], [2201, 2301]]
    sides = dict(out["players"].select("steamid", "side_h1").iter_rows())
    assert sides[A1] == "CT" and sides[B1] == "T"
