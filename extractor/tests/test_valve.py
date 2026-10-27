"""Valve matchmaking demos: the ways they differ from GOTV that broke extraction, and the import CLI's Steam
lookups. Everything here is synthetic; no real SteamID, name or demo."""

import json
import os
import sys
from pathlib import Path

import polars as pl
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


def _deaths(*rows):
    return pd.DataFrame({"tick": [r[0] for r in rows], "victim_steamid": pd.array([r[1] for r in rows], dtype="UInt64")})


NO_DEATHS = _deaths()


def test_a_death_in_round_one_freeze_time_is_not_taken_off_the_scoreboard():
    # A Valve player disconnected in round 1's freeze time and died to "world"; the game counted it and so does
    # the kills table. A baseline of the bare freeze-end counters took that death off the scoreboard (10 vs 11).
    rounds = pd.DataFrame(dict(start_tick=[65], freeze_end_tick=[1710]))
    p = SkippingParser({0: {1: dict(deaths_total=0)}, 488: {1: dict(deaths_total=1)}})
    assert ex.scoreboard_baseline(p, rounds, _deaths((488, 1)), NO_GUARD, 64).deaths_total.tolist() == [0]


def test_a_counter_the_game_commits_a_tick_after_the_death_still_comes_off():
    # Review of PR 19 (Astra, round 2): the snapshot on the death tick still holds the old deaths_total, which
    # rises on the next tick. Read on the death tick, the death looked uncounted and the map failed.
    rounds = pd.DataFrame(dict(start_tick=[65], freeze_end_tick=[1710]))
    p = SkippingParser({0: {1: dict(deaths_total=0)}, 489: {1: dict(deaths_total=1)}})
    guard = _guard(round_start=[65], player_death=[488])
    assert ex.scoreboard_baseline(p, rounds, _deaths((488, 1)), guard, 64).deaths_total.tolist() == [0]


def test_a_round_one_death_with_no_player_death_row_fails_the_map():
    # Review of PR 19 (Astra, round 2): the game counted a death the demo has no row for, and the freeze-end
    # baseline absorbed it, so the scoreboard and the tables agreed while both missed that death.
    rounds = pd.DataFrame(dict(start_tick=[65], freeze_end_tick=[1710]))
    p = SkippingParser({0: {1: dict(deaths_total=0)}, 300: {1: dict(deaths_total=1)}})
    with pytest.raises(RuntimeError, match="player 1's deaths_total rose by 1 between ticks 65 and 1710"):
        ex.scoreboard_baseline(p, rounds, NO_DEATHS, NO_GUARD, 64)


def test_a_lost_death_of_a_player_who_appears_after_round_one_starts_fails_the_map():
    # Review of PR 19 (round 3): measured from the window's start only, a player with no controller there was
    # left out, and a lost death after he appeared was absorbed by the freeze-end baseline. What he holds when
    # he appears (5 deaths from an earlier part) is not this demo's and passes.
    rounds = pd.DataFrame(dict(start_tick=[65], freeze_end_tick=[1710]))
    p = SkippingParser({0: {1: dict(deaths_total=0)}, 300: {1: dict(deaths_total=0), 2: dict(deaths_total=5)},
                        500: {1: dict(deaths_total=0), 2: dict(deaths_total=6)}})
    with pytest.raises(RuntimeError, match="player 2's deaths_total rose by 1 between ticks 300 and 1710"):
        ex.scoreboard_baseline(p, rounds, NO_DEATHS, NO_GUARD, 64)
    p.counters[500][2]["deaths_total"] = 5
    assert dict(zip(*ex.scoreboard_baseline(p, rounds, NO_DEATHS, NO_GUARD, 64)[["steamid", "deaths_total"]]
                    .T.values)) == {1: 0, 2: 5}


def test_a_round_one_death_the_game_did_not_count_still_fails_validation():
    # An HLTV split recording's later part had 10 "world" deaths on a restore tick that the game never counted.
    # Taking the tables' own deaths off the baseline would have cancelled them on both sides and passed the
    # map with 10 deaths too many; only the game's own counter rise may come off.
    rounds = pd.DataFrame(dict(start_tick=[4], freeze_end_tick=[4279]))
    p = SkippingParser({0: {1: dict(deaths_total=7)}})
    assert ex.scoreboard_baseline(p, rounds, _deaths((4, 1)), NO_GUARD, 64).deaths_total.tolist() == [7]


def test_a_counter_load_on_a_round_one_death_tick_fails_instead_of_emptying_the_baseline():
    # Another part's restore loaded the backup's counters on its death tick: 0 -> 106 deaths summed. Taken as
    # the game counting that tick's deaths, it would wipe the baseline out.
    rounds = pd.DataFrame(dict(start_tick=[4], freeze_end_tick=[5059]))
    p = SkippingParser({0: {1: dict(deaths_total=0)}, 4: {1: dict(deaths_total=11)}})
    with pytest.raises(RuntimeError, match="moved by 11 across tick 4"):
        ex.scoreboard_baseline(p, rounds, _deaths((4, 1)), NO_GUARD, 64)


def test_a_restore_on_round_one_start_before_the_match_restarts_voids_its_tick():
    # That part opened with round_start at 4, a winnerless round_end (the backup restore) at 4, and
    # begin_new_match at 5. Restores were voided only after begin_new_match, so the 10 restore deaths counted.
    ends = pd.DataFrame(dict(tick=[4, 12228], total_rounds_played=[0, 1], winner=[None, "CT"], reason=[None, "t_killed"]))
    rounds, voided = ex.build_round_windows([1, 4], [4279], ends, match_start=5)
    assert (int(rounds.start_tick.iloc[0]), voided) == (4, [(4, 4)])
    assert ex.assign_rounds(pd.Series([4, 5]), rounds, voided).tolist() == [0, 1]
    # On begin_new_match's own tick it is the recording's leftover first round_end, and nothing is voided.
    ends0 = pd.DataFrame(dict(tick=[0, 5900], total_rounds_played=[0, 1], winner=[None, "CT"], reason=[None, "t_killed"]))
    assert ex.build_round_windows([0], [1279], ends0, match_start=0)[1] == []


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


def test_the_user_file_is_replaced_whole_and_only_when_it_changes(tmp_path, monkeypatch):
    # The app reads it while it lists matches: a write cut short must leave the old file whole, and a
    # rerun for the same user must not touch it (review of #29)
    out = tmp_path / "out"
    vi.resolve_user(out, None, U1)
    f = out / vi.USER_FILE
    first = (f.read_text(encoding="utf-8"), f.stat().st_mtime_ns)
    vi.resolve_user(out, None, U1)
    assert (f.read_text(encoding="utf-8"), f.stat().st_mtime_ns) == first

    def cut(src, dst):
        raise OSError("disk full")
    monkeypatch.setattr(vi.os, "replace", cut)
    with pytest.raises(OSError):
        vi.resolve_user(out, None, U2)
    assert f.read_text(encoding="utf-8") == first[0]
    assert [p.name for p in out.iterdir()] == [vi.USER_FILE]  # no staged copy left behind


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


# --- import CLI: runs ---------------------------------------------------------

def _fake_extractor(calls: list, failing: set):
    """Stands in for extract.extract_demo: publishes a minimal map for a demo that passes, nothing otherwise."""

    def fake(dem, out_dir, source, mapdata=None, archive="", meta_extra=None):
        calls.append(Path(dem).name)
        ok = Path(dem).name not in failing
        if ok:  # published the way write_output does: under the map's lock, listing the files written
            with ex.map_lock(Path(out_dir)):
                tmp = Path(out_dir) / ".tmp-test"
                tmp.mkdir(parents=True)
                pl.DataFrame({"demo_sha256": [ex.file_sha256(dem)], "extractor_version": [ex.EXTRACTOR_VERSION],
                              "extra": [json.dumps(meta_extra)]}).write_parquet(tmp / "match.parquet")
                pl.DataFrame({"steamid": pl.Series([U1], dtype=pl.UInt64)}).write_parquet(tmp / "players.parquet")
                ex.publish_version(tmp, Path(out_dir), ex.EXTRACTOR_VERSION, ["match.parquet", "players.parquet"])
        return dict(ok=ok, errors=[] if ok else ["ValidationFailed: deaths"], validation={})
    return fake


def _run(args, out):
    code = vi.main([*map(str, args), "--out", str(out), "--user", str(U1), "--result", str(out / "summary.json")])
    return code, json.loads((out / "summary.json").read_text(encoding="utf-8"))


def test_a_rerun_extracts_only_what_failed_or_changed_and_the_exit_code_says_whether_all_passed(tmp_path, monkeypatch):
    calls, failing = [], {"b.dem"}
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor(calls, failing))
    a, b, out = tmp_path / "a.dem", tmp_path / "b.dem", tmp_path / "out"
    a.write_bytes(b"demo a")
    b.write_bytes(b"demo b")
    code, summary = _run([a, b], out)
    assert (code, calls, summary["ok"]) == (1, ["a.dem", "b.dem"], 1)
    assert [r["user_in_match"] for r in summary["results"]] == [True, None]
    calls.clear()
    failing.clear()
    assert _run([a, b], out)[0] == 0 and calls == ["b.dem"]  # a was already extracted from this file
    calls.clear()
    a.write_bytes(b"demo a, downloaded again")
    assert _run([a, b], out)[0] == 0 and calls == ["a.dem"]  # same name, different file
    calls.clear()
    assert _run([a, b, "--force"], out)[0] == 0 and calls == ["a.dem", "b.dem"]
    calls.clear()
    monkeypatch.setattr(vi, "IMPORTER_VERSION", vi.IMPORTER_VERSION + 1)  # match.extra is written differently now
    assert _run([a, b], out)[0] == 0 and calls == ["a.dem", "b.dem"]


def _pb_varint(v: int) -> bytes:
    out = b""
    while True:
        out += bytes([(v & 0x7F) | (0x80 if v > 0x7F else 0)])
        v >>= 7
        if not v:
            return out


def test_a_demos_date_is_its_dem_info_match_time_else_its_file_time(tmp_path, monkeypatch):
    # Demos carry no date, and the app sorts and groups matches by one. Steam's .dem.info is a MatchInfo
    # protobuf: field 1 the match id, field 2 the match time (Unix seconds), then nested messages.
    extras, fake = [], _fake_extractor([], set())

    def capture(dem, out_dir, source, mapdata=None, archive="", meta_extra=None):
        extras.append(meta_extra)
        return fake(dem, out_dir, source, mapdata, archive, meta_extra)
    monkeypatch.setattr(vi.extract, "extract_demo", capture)
    a, b = tmp_path / "a.dem", tmp_path / "b.dem"
    a.write_bytes(b"demo a")
    b.write_bytes(b"demo b")
    t = 1784431150  # 2026-07-19T03:19:10Z
    (tmp_path / "a.dem.info").write_bytes(bytes([0x08]) + _pb_varint(123456789012345) + bytes([0x1A, 0x02, 0x08, 0x01])
                                          + bytes([0x10]) + _pb_varint(t))
    (tmp_path / "b.dem.info").write_bytes(bytes([0x10, 0xFF]))  # cut off inside its varint
    os.utime(b, (1790000000, 1790000000))
    _run([a, b], tmp_path / "out")
    # started_at is what the app turns into the local day: from date alone, Chicago saw July 19 for July 18
    assert [e["started_at"] for e in extras] == [e["date"] for e in extras]
    assert [(e["date"], e["date_source"]) for e in extras] == [("2026-07-19T03:19:10+00:00", "dem.info"),
                                                             ("2026-09-21T14:13:20+00:00", "file time")]


def test_progress_reports_each_demo_as_it_starts_and_ends(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor([], {"b.dem"}))
    a, b = tmp_path / "a.dem", tmp_path / "b.dem"
    a.write_bytes(b"demo a")
    b.write_bytes(b"demo b")
    vi.main([str(a), str(b), "--out", str(tmp_path / "out"), "--user", str(U1), "--progress"])
    events = [json.loads(line) for line in capsys.readouterr().err.splitlines()]
    assert [(e["event"], e["i"], e["n"], e.get("ok")) for e in events] == [
        ("start", 1, 2, None), ("done", 1, 2, True), ("start", 2, 2, None), ("done", 2, 2, False)]


def test_the_importer_refuses_to_write_the_users_id_inside_a_repository(tmp_path, monkeypatch):
    monkeypatch.setattr(vi.extract, "extract_demo", _fake_extractor([], set()))
    (tmp_path / "repo" / ".git").mkdir(parents=True)
    dem = tmp_path / "a.dem"
    dem.write_bytes(b"demo")
    out = tmp_path / "repo" / "data" / "valve"
    with pytest.raises(SystemExit) as e:
        vi.main([str(dem), "--out", str(out), "--user", str(U1)])
    assert e.value.code == 2 and not (out / vi.USER_FILE).exists()
    # there is no flag to allow it any more
    with pytest.raises(SystemExit) as e:
        vi.main([str(dem), "--out", str(out), "--user", str(U1), "--allow-in-repo"])
    assert e.value.code == 2 and not (out / vi.USER_FILE).exists()


def test_an_empty_replays_folder_is_an_error_not_a_successful_import(tmp_path):
    steam = tmp_path / "Steam"
    (steam / "steamapps").mkdir(parents=True)
    (steam / vi.REPLAYS).mkdir(parents=True)
    with pytest.raises(SystemExit) as e:
        vi.main(["--out", str(tmp_path / "out"), "--steam", str(steam), "--user", str(U1)])
    assert e.value.code == 2


def test_a_rise_before_round_one_a_dropped_attempt_explains_stays_in_the_baseline():
    # Review of PR 54 (finding 3): a restored attempt before round 1 kept one player's death, and his counter
    # settled in round 1's freeze time, where no row explains it. The baseline refused it as a lost death; when
    # the attempt's own events explain the rise, it belongs to the baseline instead.
    rounds = pd.DataFrame(dict(start_tick=[65], freeze_end_tick=[1710]))
    p = SkippingParser({0: {1: dict(deaths_total=0)}, 300: {1: dict(deaths_total=1)}})
    with pytest.raises(RuntimeError, match="rose by 1"):
        ex.scoreboard_baseline(p, rounds, NO_DEATHS, NO_GUARD, 64)
    base = ex.scoreboard_baseline(p, rounds, NO_DEATHS, NO_GUARD, 64,
                                  explain=lambda sid, excess: excess["deaths_total"] == 1)
    assert base.deaths_total.tolist() == [1]
