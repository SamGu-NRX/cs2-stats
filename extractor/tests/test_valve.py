"""Valve matchmaking demos: the ways they differ from GOTV that broke extraction.
Everything here is synthetic; no real SteamID, name or demo."""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import extract as ex  # noqa: E402


class SkippingParser:
    """parse_ticks over per-tick counters that, like a Valve demo, has no rows at some ticks."""

    def __init__(self, counters: dict[int, dict[int, dict]], skipped=()):
        self.counters, self.skipped = counters, set(skipped)

    def parse_ticks(self, props, ticks):
        rows = []
        for t in ticks:
            if t in self.skipped:
                continue
            last = max((k for k in self.counters if k <= t), default=None)
            for sid, vals in (self.counters[last].items() if last is not None else ()):
                rows.append(dict(tick=t, steamid=sid, name=f"p{sid}", **{p: vals.get(p, 0) for p in props}))
        return pd.DataFrame(rows, columns=["tick", "steamid", "name"] + list(props))


def test_a_read_at_a_skipped_tick_takes_the_next_recorded_tick_and_keeps_the_requested_one():
    # The tick after the last round end was missing on a Valve demo, and the score read there came back
    # with no rows at all. The value must come from the next recorded tick, labelled with the tick asked for.
    p = SkippingParser({0: {1: dict(team_rounds_total=12)}, 501: {1: dict(team_rounds_total=13)}}, skipped={501})
    got = ex.parse_at(p, ["team_rounds_total"], [501])
    assert got[["tick", "team_rounds_total"]].values.tolist() == [[501, 13]]


def test_a_read_with_no_recorded_tick_nearby_fails_loudly_unless_optional():
    p = SkippingParser({0: {1: dict(kills_total=0)}}, skipped=range(100, 100 + ex.MAX_TICK_GAP + 1))
    with pytest.raises(RuntimeError, match="no tick within"):
        ex.parse_at(p, ["kills_total"], [100])
    assert ex.parse_at(p, ["kills_total"], [100], required=False).empty


def test_a_death_in_round_one_freeze_time_is_not_taken_off_the_scoreboard():
    # A Valve player disconnected in round 1's freeze time and died to "world"; the game counted it and so does
    # the kills table. A baseline read at freeze end took that death off the scoreboard (10 against 11).
    rounds = pd.DataFrame(dict(start_tick=[65], freeze_end_tick=[1710]))
    p = SkippingParser({0: {1: dict(deaths_total=0)}, 488: {1: dict(deaths_total=1)}}, skipped={66, 67})
    base = ex.scoreboard_baseline(p, rounds, match_start=67)
    assert base.deaths_total.tolist() == [0]


def _snap(rows):
    return pd.DataFrame(rows, columns=["tick", "steamid", "team_num"])


def test_a_player_who_joins_after_round_one_takes_his_teammates_team_name():
    # Wingman, no clan names: one CT slot was empty in round 1 and a player filled it later, after which the
    # sides swapped at halftime. Naming by round 1 alone left him without a team on the scoreboard.
    names = ex.start_side_teams(_snap([(100, 1, 3), (100, 2, 2), (100, 3, 2),
                                       (900, 1, 3), (900, 4, 3), (900, 2, 2), (900, 3, 2),
                                       (1500, 1, 2), (1500, 4, 2), (1500, 2, 3), (1500, 3, 3)]))
    assert names == {1: "ct_start", 4: "ct_start", 2: "t_start", 3: "t_start"}


def test_a_newcomer_on_a_side_with_no_named_player_takes_the_name_the_other_side_lacks():
    names = ex.start_side_teams(_snap([(100, 1, 3), (900, 1, 2), (900, 5, 3)]))
    assert names == {1: "ct_start", 5: "t_start"}


def _blinds(rows):
    df = pd.DataFrame(rows, columns=["tick", "victim_steamid", "attacker_steamid", "duration"])
    for c in ("victim_steamid", "attacker_steamid"):
        df[c] = pd.array(df[c], dtype="UInt64")
    return df


def test_rebuilt_blinds_are_checked_against_the_demos_own_player_blind_events():
    ours = _blinds([(10, 1, 2, 2.5), (20, 3, None, 1.25)])
    game = ours.astype({"attacker_steamid": object})
    agree = ex.blinds_vs_event(ours, game.tick, game.victim_steamid, game.attacker_steamid, game.duration)
    assert (agree["ok"], agree["actual"]) == (True, 2)
    off = ex.blinds_vs_event(ours, game.tick, game.victim_steamid, game.attacker_steamid, game.duration + [0, 0.5])
    assert (off["ok"], off["actual"], off["fatal"]) == (False, 1, False)
