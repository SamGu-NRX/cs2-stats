"""Valve matchmaking demos: the ways they differ from GOTV that broke extraction, and the import CLI's Steam
lookups. Everything here is synthetic; no real SteamID, name or demo."""

import json
import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import extract as ex  # noqa: E402
import valve_import as vi  # noqa: E402


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


NO_GUARD = ex.snap_guard({})


def _guard(**events):
    """snap_guard over synthetic events: name=[ticks]."""
    return ex.snap_guard({n: pd.DataFrame({"tick": t}) for n, t in events.items()})


def test_a_read_at_a_skipped_tick_takes_the_next_recorded_tick_and_keeps_the_requested_one():
    # The tick after the last round end was missing on a Valve demo, and the score read there came back
    # with no rows at all. The value must come from the next recorded tick, labelled with the tick asked for.
    p = SkippingParser({0: {1: dict(team_rounds_total=12)}, 501: {1: dict(team_rounds_total=13)}}, skipped={501})
    got = ex.read_at(p, ["team_rounds_total"], [501], after=True, guard=NO_GUARD, rate=64)
    assert got[["tick", "team_rounds_total"]].values.tolist() == [[501, 13]]


def test_a_state_as_of_a_skipped_tick_comes_from_before_it_unless_a_purchase_lies_between():
    # Freeze-end equipment read after a purchase would credit an item bought later (review of PR 19).
    p = SkippingParser({0: {1: dict(balance=800)}, 999: {1: dict(balance=600)}}, skipped={1000})
    got = ex.read_at(p, ["balance"], [1000], after=False, guard=NO_GUARD, rate=64)
    assert got[["tick", "balance"]].values.tolist() == [[1000, 600]]
    with pytest.raises(RuntimeError, match="item_purchase at tick 1000"):
        ex.read_at(p, ["balance"], [1000], after=False, guard=_guard(item_purchase=[1000]), rate=64)


def test_the_snap_limit_is_a_time_so_it_scales_with_the_tick_rate():
    gap = range(101, 113)  # 12 ticks: 0.094 s at 128 tick, 0.188 s at 64
    p = SkippingParser({0: {1: dict(kills_total=0)}}, skipped=gap)
    assert len(ex.read_at(p, ["kills_total"], [101], after=True, guard=NO_GUARD, rate=128)) == 1
    with pytest.raises(RuntimeError, match="no tick within"):
        ex.read_at(p, ["kills_total"], [101], after=True, guard=NO_GUARD, rate=64)
    assert ex.read_at(p, ["kills_total"], [101], after=True, guard=NO_GUARD, rate=64, required=False).empty


@pytest.mark.parametrize("event", ex.SNAP_GUARD_EVENTS)
def test_a_snap_across_a_state_changing_event_fails_with_the_tick_and_the_event(event):
    # The value read after the event is not the one at the requested tick: fail rather than store it.
    p = SkippingParser({0: {1: dict(kills_total=0)}}, skipped={100, 101})
    with pytest.raises(RuntimeError, match=f"{event} at tick 101"):
        ex.read_at(p, ["kills_total"], [100], after=True, guard=_guard(**{event: [101]}), rate=64)


def test_a_kept_aborted_attempt_is_never_judged_from_a_snapshot_past_its_death():
    # Review of PR 19: attempt starts at 100, a counted death at 102, the first recorded tick is 104, the
    # restore is at 200. Read at 104, the start already holds the death, kills plus deaths look unchanged
    # across the restore, and the attempt passes as rolled back.
    p = SkippingParser({0: {1: dict(kills_total=0, deaths_total=0)}, 102: {1: dict(kills_total=0, deaths_total=1)}},
                       skipped={100, 101, 102, 103})
    with pytest.raises(RuntimeError, match="player_death at tick 102"):
        ex.read_at(p, ["kills_total", "deaths_total"], [100, 264], after=True,
                   guard=_guard(round_start=[100], player_death=[102], round_end=[200]), rate=64)


def _deaths(rows):
    df = pd.DataFrame(rows, columns=["tick", "attacker_steamid", "victim_steamid", "assister_steamid", "a_side",
                                     "v_side", "assister_side", "headshot"])
    for c in ("attacker_steamid", "victim_steamid", "assister_steamid"):
        df[c] = pd.array(df[c], dtype="UInt64")
    return df


NO_DEATHS = _deaths([])


def test_a_death_in_round_one_freeze_time_is_not_taken_off_the_scoreboard():
    # A Valve player disconnected in round 1's freeze time and died to "world"; the game counted it and so does
    # the kills table. A baseline of the bare freeze-end counters took that death off the scoreboard (10 vs 11).
    rounds = pd.DataFrame(dict(start_tick=[65], freeze_end_tick=[1710]))
    p = SkippingParser({0: {1: dict(deaths_total=0)}, 488: {1: dict(deaths_total=1)}})
    deaths = _deaths([(488, 1, 1, None, "T", "T", None, False)])
    base = ex.scoreboard_baseline(p, rounds, deaths, NO_GUARD, 64)
    assert base.deaths_total.tolist() == [0]


def test_the_baseline_waits_for_a_restores_rollback_to_settle():
    # Review of PR 19: round 1 restored at 200, replayed from 201, the voided death rolled back at 240, freeze
    # end at 400. Read at the replay's start, the baseline would hold the voided death.
    rounds = pd.DataFrame(dict(start_tick=[201], freeze_end_tick=[400]))
    p = SkippingParser({0: {1: dict(deaths_total=0)}, 150: {1: dict(deaths_total=1)}, 240: {1: dict(deaths_total=0)}})
    assert ex.scoreboard_baseline(p, rounds, NO_DEATHS, NO_GUARD, 64).deaths_total.tolist() == [0]


def test_a_returning_player_carries_his_earlier_totals_into_a_later_part():
    # Review of PR 19: in a split recording's later part, a player whose controller appears only after round 1
    # starts still has the earlier parts' kills, and they must not count as this part's.
    rounds = pd.DataFrame(dict(start_tick=[100], freeze_end_tick=[400]))
    p = SkippingParser({0: {1: dict(kills_total=7)}, 300: {1: dict(kills_total=7), 2: dict(kills_total=5)}})
    base = ex.scoreboard_baseline(p, rounds, NO_DEATHS, NO_GUARD, 64)
    assert dict(zip(base.steamid, base.kills_total)) == {1: 7, 2: 5}


def test_a_departed_player_is_measured_from_his_own_baseline():
    # Review of PR 19: his baseline came only from final-scoreboard players, so a later part credited him with
    # the earlier parts' damage.
    baseline = ex.baseline_of(pd.DataFrame({"steamid": [1, 2], "kills_total": [3, 0], "deaths_total": [1, 0],
                                            "assists_total": [0, 0], "damage_total": [300, 0],
                                            "headshot_kills_total": [1, 0], "team_rounds_total": [4, 0]}))
    left = pd.DataFrame({"steamid": [1], "tick": [5000], "kills_total": [5], "deaths_total": [4], "assists_total": [2],
                         "damage_total": [520], "headshot_kills_total": [2], "team_rounds_total": [6]})
    got = ex.since_start(left, baseline).iloc[0]
    assert (got.kills_total, got.deaths_total, got.damage_total) == (2, 3, 220)


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
    # Two unmatched blinds on one tick and victim, one with no attacker: the note must still be written.
    both = _blinds([(30, 4, None, 1.0), (30, 4, 2, 1.0)])
    none = ex.blinds_vs_event(both, [], [], [], [])
    assert (none["ok"], "only_rebuilt=[(30, 4, None, 1.0), (30, 4, 2, 1.0)]" in none["note"]) == (False, True)


# --- import CLI: Steam files ------------------------------------------------

U1, U2 = vi.STEAMID64_MIN + 1000, vi.STEAMID64_MIN + 2000


def _login(users: dict) -> str:
    body = "".join(f'\t"{sid}"\n\t{{\n' + "".join(f'\t\t"{k}"\t\t"{v}"\n' for k, v in kv.items()) + "\t}\n"
                   for sid, kv in users.items())
    return f'"users"\n{{\n{body}}}\n'


def test_the_user_is_steams_most_recent_login():
    # Current Steam clients write only a timestamp; older ones mark MostRecent, which wins when present.
    by_time = {U1: dict(AccountName="a", timestamp="100"), U2: dict(AccountName="b", timestamp="200")}
    assert vi.most_recent_user(vi.parse_vdf(_login(by_time))) == U2
    by_time[U1]["MostRecent"] = "1"
    assert vi.most_recent_user(vi.parse_vdf(_login(by_time))) == U1


def test_a_malformed_vdf_fails_loudly():
    for bad in ('"users"\n{\n"1"\n{\n', '"users" x', '"a" "b" }'):
        with pytest.raises(ValueError):
            vi.parse_vdf(bad)


def test_the_replays_folder_is_found_in_the_library_that_holds_cs2(tmp_path):
    steam, other = tmp_path / "Steam", tmp_path / "Other Lib"
    (steam / "steamapps").mkdir(parents=True)
    (other / vi.REPLAYS).mkdir(parents=True)
    esc = lambda p: str(p).replace("\\", "\\\\")
    (steam / "steamapps" / "libraryfolders.vdf").write_text(
        '"libraryfolders"\n{\n'
        f'\t"0"\n\t{{\n\t\t"path"\t\t"{esc(steam)}"\n\t\t"apps"\n\t\t{{\n\t\t\t"228980"\t\t"1"\n\t\t}}\n\t}}\n'
        f'\t"1"\n\t{{\n\t\t"path"\t\t"{esc(other)}"\n\t\t"apps"\n\t\t{{\n\t\t\t"730"\t\t"1"\n\t\t}}\n\t}}\n}}\n',
        encoding="utf-8")
    assert vi.replays_dir(steam) == other / vi.REPLAYS


def test_a_saved_user_survives_a_later_steam_login_and_an_explicit_one_replaces_it(tmp_path):
    steam = tmp_path / "Steam"
    (steam / "config").mkdir(parents=True)
    login = steam / "config" / "loginusers.vdf"
    login.write_text(_login({U1: dict(timestamp="1")}), encoding="utf-8")
    out = tmp_path / "out"
    assert vi.resolve_user(out, steam, None)["steamid"] == U1
    login.write_text(_login({U2: dict(timestamp="9")}), encoding="utf-8")
    assert vi.resolve_user(out, steam, None)["steamid"] == U1
    assert vi.resolve_user(out, steam, U2)["steamid"] == U2
    assert json.loads((out / vi.USER_FILE).read_text(encoding="utf-8"))["steamid"] == U2
    with pytest.raises(ValueError):
        vi.resolve_user(out, steam, 12345)
