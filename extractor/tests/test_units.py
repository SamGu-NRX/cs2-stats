import json
import sys
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from collections import deque

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import demo_pipeline as dp  # noqa: E402
import extract as ex  # noqa: E402


# --- prices ---------------------------------------------------------------

def test_prices_come_from_the_build_file():
    # Values the coordinator called out from prices_cs2_1.41.9.2.json; the first four were also
    # observed as item_purchase costs in the test demos.
    assert ex.item_price("FAMAS") == 1950
    assert ex.item_price("MP7") == 1400
    assert ex.item_price("M4A4") == 2900
    assert ex.item_price("AWP") == 4750
    assert ex.item_price("AUG") == 3300
    assert ex.item_price("CZ75-Auto") == 500
    assert ex.item_price("P2000") == 200
    assert ex.HELMET_UPGRADE_COST == 350


def test_every_mapped_name_has_a_price():
    for name in ex.DISPLAY_TO_CLASS:
        ex.item_price(name)


def test_missing_from_file_raises(tmp_path, monkeypatch):
    monkeypatch.setitem(ex.DISPLAY_TO_CLASS, "Twin Blade", "weapon_knife_twinblade_missing")
    with pytest.raises(ex.UnknownItemPrice, match="missing from"):
        ex.item_price("Twin Blade")


def test_price_file_rejects_bad_values(tmp_path):
    f = tmp_path / "p.json"
    f.write_text('{"source": "x", "weapons": {"weapon_ak47": "2700"}, "items": {}}')
    with pytest.raises(ValueError):
        ex.load_prices(f)
    f.write_text('{"weapons": {}, "items": {}}')
    with pytest.raises(ValueError):
        ex.load_prices(f)


def test_unbuyable_items_are_zero():
    for name in ("Karambit", "knife_t", "Knife", "C4 Explosive", "Shadow Daggers"):
        assert ex.item_price(name) == 0


@pytest.mark.parametrize("name", ["Butterfly", "AK47", "Trade Up Contract", "item_nvg", ""])
def test_unknown_item_raises(name):
    with pytest.raises(ex.UnknownItemPrice):
        ex.item_price(name)


def test_inventory_value_counts_duplicates_and_raises_on_unknown():
    assert ex.inventory_value(["Karambit", "Glock-18", "Flashbang", "Flashbang", "AK-47"]) == 200 + 400 + 2700
    assert ex.inventory_value([]) == 0
    with pytest.raises(ex.UnknownItemPrice):
        ex.inventory_value(["AK-47", "Trade Up Contract"])


def test_most_expensive_per_slot():
    inv = ["Butterfly Knife", "Glock-18", "Desert Eagle", "MAC-10", "AWP", "Smoke Grenade"]
    assert ex.most_expensive(inv, ex.PRIMARY_WEAPONS) == ("AWP", 4750)
    assert ex.most_expensive(inv, ex.SECONDARY_WEAPONS) == ("Desert Eagle", 700)
    assert ex.most_expensive(["Karambit"], ex.PRIMARY_WEAPONS) == (None, None)


def test_most_expensive_raises_for_unpriced_slot_weapon(monkeypatch):
    monkeypatch.delitem(ex.DISPLAY_TO_CLASS, "AUG")
    with pytest.raises(ex.UnknownItemPrice):
        ex.most_expensive(["AUG"], ex.PRIMARY_WEAPONS)


def test_purchase_cost_check():
    assert ex.check_purchase_cost("AK-47", 2700) is None
    assert ex.check_purchase_cost("Kevlar & Helmet", 1000) is None
    assert ex.check_purchase_cost("Kevlar & Helmet", 350) is None  # helmet upgrade over an existing vest
    assert "price table" in ex.check_purchase_cost("AK-47", 2500)
    assert "unpriced" in ex.check_purchase_cost("Trade Up Contract", 100)


def test_slot_sets_are_disjoint_and_priced_weapons_are_slotted():
    assert not ex.PRIMARY_WEAPONS & ex.SECONDARY_WEAPONS
    assert (ex.PRIMARY_WEAPONS | ex.SECONDARY_WEAPONS) <= set(ex.DISPLAY_TO_CLASS)


# --- RAR detection and completeness ---------------------------------------

def test_is_rar(tmp_path):
    (tmp_path / "r5").write_bytes(b"Rar!\x1a\x07\x01\x00rest")
    (tmp_path / "r4").write_bytes(b"Rar!\x1a\x07\x00rest")
    (tmp_path / "zip").write_bytes(b"PK\x03\x04rest")
    (tmp_path / "short").write_bytes(b"Rar!")
    assert dp.is_rar(tmp_path / "r5")
    assert dp.is_rar(tmp_path / "r4")
    assert not dp.is_rar(tmp_path / "zip")
    assert not dp.is_rar(tmp_path / "short")
    assert not dp.is_rar(tmp_path / "missing")


def test_candidate_names():
    assert dp.is_candidate_name(Path("f3a92631-1281-45b5-80bb-48725dbb136b"))
    assert not dp.is_candidate_name(Path("x.crdownload"))
    assert not dp.is_candidate_name(Path("archive.rar"))
    assert not dp.is_candidate_name(Path(".hidden"))


def test_tracker_needs_ten_stable_seconds():
    t = dp.CompletenessTracker(stable_seconds=10)
    p = Path("f")
    assert not t.observe(p, 100, 0.0)
    assert not t.observe(p, 100, 9.9)
    assert t.observe(p, 100, 10.0)


def test_tracker_resets_on_growth_and_ignores_empty():
    t = dp.CompletenessTracker(stable_seconds=10)
    p = Path("f")
    t.observe(p, 100, 0.0)
    assert not t.observe(p, 200, 11.0)  # grew: clock restarts
    assert not t.observe(p, 200, 20.0)
    assert t.observe(p, 200, 21.0)
    e = Path("empty")
    t.observe(e, 0, 0.0)
    assert not t.observe(e, 0, 100.0)


def test_partial_marker_blocks_completion(tmp_path):
    rar = tmp_path / "abc"
    rar.write_bytes(b"Rar!\x1a\x07\x01\x00" + b"x" * 100)
    t = dp.CompletenessTracker(stable_seconds=10)
    assert not dp.is_complete_rar(rar, t, 0.0)
    (tmp_path / "abc.crdownload").write_bytes(b"")
    assert not dp.is_complete_rar(rar, t, 11.0)
    (tmp_path / "abc.crdownload").unlink()
    assert dp.is_complete_rar(rar, t, 12.0)


def test_complete_non_rar_is_not_an_archive(tmp_path):
    z = tmp_path / "zipfile"
    z.write_bytes(b"PK\x03\x04" + b"x" * 100)
    t = dp.CompletenessTracker(stable_seconds=10)
    dp.is_complete_rar(z, t, 0.0)
    assert not dp.is_complete_rar(z, t, 11.0)


# --- validation -----------------------------------------------------------

A, B, C, D = 11, 22, 33, 44  # A, B on team 1; C, D on team 2


TEAM = {A: "CT", B: "CT", C: "T", D: "T"}


def _kills(rows):
    df = pd.DataFrame(rows, columns=["attacker_steamid", "victim_steamid", "assister_steamid", "headshot",
                                     "is_teamkill", "is_suicide"])
    df["v_side"] = df.victim_steamid.map(TEAM)
    df["assister_side"] = df.assister_steamid.map(TEAM)
    for c in ("attacker_steamid", "victim_steamid", "assister_steamid"):
        df[c] = pd.array(df[c], dtype="UInt64")
    return df


def _damages(rows):
    df = pd.DataFrame(rows, columns=["attacker_steamid", "dmg_health_capped", "is_team_damage"])
    df["attacker_steamid"] = pd.array(df.attacker_steamid, dtype="UInt64")
    return df


def _sb(rows):
    df = pd.DataFrame(rows, columns=["steamid", "kills_total", "deaths_total", "assists_total", "damage_total",
                                     "headshot_kills_total"])
    df["steamid"] = pd.array(df.steamid, dtype="UInt64")
    return df


def _base():
    kills = _kills([(A, C, B, True, False, False), (C, A, None, False, False, False),
                    (B, D, None, False, False, False)])
    game_damage = {A: 100, B: 100, C: 100}  # player_rounds.game_damage summed per player
    sb = _sb([(A, 1, 1, 0, 100, 1), (B, 1, 0, 1, 100, 0), (C, 1, 1, 0, 100, 0), (D, 0, 1, 0, 0, 0)])
    return kills, game_damage, sb


def _fatal_failures(checks):
    return [c for c in checks if c["fatal"] and not c["ok"]]


def test_scoreboard_validation_passes():
    assert _fatal_failures(ex.validate_scoreboard(*_base())) == []


def test_scoreboard_kill_mismatch_fails():
    kills, dmg, sb = _base()
    sb.loc[sb.steamid == A, "kills_total"] = 2
    bad = _fatal_failures(ex.validate_scoreboard(kills, dmg, sb))
    assert [(c["check"], c["steamid"]) for c in bad] == [("kills", A)]


def test_scoreboard_damage_is_checked_against_the_games_own_counter():
    # The hit table is not consulted: a hit no shot names must not decide whether the scoreboard matches.
    kills, dmg, sb = _base()
    dmg[A] = 99
    bad = _fatal_failures(ex.validate_scoreboard(kills, dmg, sb))
    assert [(c["check"], c["steamid"]) for c in bad] == [("damage", A)]


def test_assists_include_flash_assists():
    kills, dmg, sb = _base()
    sb.loc[sb.steamid == B, "assists_total"] = 0
    assert [c["check"] for c in _fatal_failures(ex.validate_scoreboard(kills, dmg, sb))] == ["assists"]


def test_teamkill_and_suicide_may_be_deducted():
    kills = _kills([(A, C, None, False, False, False), (A, B, None, False, True, False),
                    (D, D, None, False, False, True)])
    dmg = {}
    for a_k in (1, 0):  # kills on enemies, or that minus the team kill
        sb = _sb([(A, a_k, 0, 0, 0, 0), (B, 0, 1, 0, 0, 0), (C, 0, 1, 0, 0, 0), (D, 0, 1, 0, 0, 0)])
        assert _fatal_failures(ex.validate_scoreboard(kills, dmg, sb)) == []
    sb = _sb([(A, 5, 0, 0, 0, 0), (B, 0, 1, 0, 0, 0), (C, 0, 1, 0, 0, 0), (D, 0, 1, 0, 0, 0)])
    assert len(_fatal_failures(ex.validate_scoreboard(kills, dmg, sb))) == 1


def test_disconnected_player_is_noted_not_failed():
    kills, dmg, sb = _base()
    sb = sb[sb.steamid != D]
    checks = ex.validate_scoreboard(kills, dmg, sb)
    assert _fatal_failures(checks) == []
    assert any(c["check"] == "present_on_scoreboard" and c["steamid"] == D for c in checks)


def test_a_player_who_left_is_checked_against_his_counters_at_the_disconnect():
    # A Valve abandoner has no final-scoreboard row; his counters where he disconnected are the reference,
    # so a wrong count for him fails the map instead of passing as a note.
    kills, dmg, sb = _base()
    board = sb[sb.steamid != D]
    left = sb[sb.steamid == D].assign(tick=4000)
    checks = ex.validate_scoreboard(kills, dmg, board, left)
    assert _fatal_failures(checks) == []
    assert {c["check"] for c in checks if c.get("steamid") == D} == {"kills", "deaths", "assists", "damage",
                                                                     "headshot_kills"}
    wrong = left.assign(deaths_total=2)
    assert [(c["check"], c["steamid"]) for c in _fatal_failures(ex.validate_scoreboard(kills, dmg, board, wrong))] \
        == [("deaths", D)]


def test_every_player_in_any_table_is_checked_not_only_killers_and_victims():
    # Review of PR 19: an abandoner who only assisted, or only appears in other tables, got no check at all.
    kills, dmg, sb = _base()
    board = sb[sb.steamid != B]
    left = sb[sb.steamid == B].assign(tick=4000, assists_total=0)  # B assisted once
    bad = _fatal_failures(ex.validate_scoreboard(kills, dmg, board, left))
    assert [(c["check"], c["steamid"]) for c in bad] == [("assists", B)]
    E = 55  # in player_rounds or positions only, never on the scoreboard, no disconnect read
    checks = ex.validate_scoreboard(kills, dmg, sb, None, {E})
    assert [c["check"] for c in checks if c.get("steamid") == E] == ["present_on_scoreboard"]


def _rounds(n, winners):
    return pd.DataFrame(dict(round=range(1, n + 1), start_tick=[i * 100 for i in range(n)],
                             freeze_end_tick=[i * 100 + 10 for i in range(n)],
                             end_tick=[i * 100 + 90 for i in range(n)], winner_team=winners))


def test_rounds_validation():
    r = _rounds(3, ["X", "Y", "X"])
    assert _fatal_failures(ex.validate_rounds(r, {"X": 2, "Y": 1})) == []
    assert {c["check"] for c in _fatal_failures(ex.validate_rounds(r, {"X": 3, "Y": 1}))} == {"round_count",
                                                                                           "team_wins"}
    r.loc[1, "freeze_end_tick"] = None
    assert [c["check"] for c in _fatal_failures(ex.validate_rounds(r, {"X": 2, "Y": 1}))] == ["round_ticks"]


def test_rounds_validation_rejects_unordered_ticks():
    r = _rounds(2, ["X", "Y"])
    r.loc[0, "end_tick"] = 5
    assert [c["check"] for c in _fatal_failures(ex.validate_rounds(r, {"X": 1, "Y": 1}))] == ["round_ticks"]


def test_round_windows_and_voided_restore():
    ends = pd.DataFrame(dict(tick=[900, 2000, 3000], round=[1, 2, 3], winner=["CT", "T", "CT"],
                             reason=["t_killed"] * 3))
    # round 2 was restarted: starts at 1000 (voided attempt) and again at 1500
    rounds, voided = ex.build_round_windows([1, 100, 1000, 1500, 2100], [200, 1100, 1600, 2200], ends, 50)
    assert rounds.start_tick.tolist() == [100, 1500, 2100]
    assert rounds.freeze_end_tick.tolist() == [200, 1600, 2200]
    assert voided == [(1000, 1500)]
    t = pd.Series([50, 150, 950, 1200, 1500, 1700, 2500])
    assert ex.assign_rounds(t, rounds, voided).tolist() == [0, 1, 1, 0, 0, 2, 3]


def test_backup_restore_voids_the_attempt_and_its_restore_tick_deaths():
    # A pro demo: round 17's attempt starts 110853 with no freeze end; a backup restore at
    # 119026 ends it with no winner and kills all 10 players with "world" on that tick (deaths +1 each
    # on the scoreboard check); the real round starts 119026 and ends 125482.
    ends = pd.DataFrame(dict(tick=[110533, 119026, 125482], round=[16, 17, 18], winner=["T", None, "T"],
                             reason=["bomb_exploded", None, "ct_killed"]))
    rounds, voided = ex.build_round_windows([106405 - 1280, 110853, 119026], [106405, 121100], ends, 86)
    assert rounds.end_tick.tolist() == [110533, 125482]
    assert rounds.start_tick.tolist()[1] == 119026 and voided == [(110853, 119026)]
    deaths = pd.Series([113933, 119026, 119026, 122000])  # a suicide in the attempt, two restore deaths, a real one
    assert ex.assign_rounds(deaths, rounds, voided).tolist() == [0, 0, 0, 2]


# --- helpers --------------------------------------------------------------

def test_to_u64_is_exact_and_refuses_floats():
    big = 76561190000000001
    s = ex.to_u64(pd.Series([str(big), None, "0", np.nan], dtype=object))
    assert s.iloc[0] == big and s.isna().tolist() == [False, True, True, True]
    assert ex.to_u64(pd.Series(np.array([big, 0], dtype="uint64"))).tolist()[0] == big
    with pytest.raises(TypeError):
        ex.to_u64(pd.Series([7.656119801287205e16]))


def test_trade_flags():
    k = pd.DataFrame(dict(round=[1, 1, 1], tick=[0, 200, 1000],
                          attacker_steamid=[C, A, D], victim_steamid=[B, C, A],
                          attacker_side=["T", "CT", "T"], victim_side=["CT", "T", "CT"],
                          is_teamkill=False, is_suicide=False))
    trade, traded = ex._trade_flags(k, 64.0, 5.0)
    assert trade.tolist() == [False, True, False]  # A avenged B 3.1 s later; D's kill is 12.5 s after
    assert traded.tolist() == [True, False, False]


def test_map_key_and_teams_from_filename():
    p = Path("team-a-vs-team-b-m2-dust2.dem")
    assert ex.map_key_for(p, "de_dust2") == "m2-dust2"
    assert ex.teams_from_filename(p) == ("team-a", "team-b")
    assert ex.map_key_for(Path("weird name.dem"), "de_Nuke") == "de_nuke"
    single = Path("alpha-team-vs-bravo-nuke.dem")
    assert ex.map_key_for(single, "de_nuke") == "nuke"
    assert ex.teams_from_filename(single) == ("alpha-team", "bravo")
    assert dp.slug_for(["team-a-vs-team-b-m1-nuke.dem"], "f3a92631-1281") == "team-a-vs-team-b-f3a92631-1281"
    assert dp.slug_for(["team-a-vs-team-b-m1-nuke.dem"], "team-a-vs-team-b-f3a92631") == "team-a-vs-team-b-f3a92631"


# --- status endpoint ------------------------------------------------------

def test_status_endpoint_cors_and_options():
    pipeline = dp.Pipeline()
    pipeline.status = {"pending": 1, "extracting": 0, "parsing": 0, "done": 0, "failed": 0, "freeGB": 99.0}
    server = ThreadingHTTPServer(("127.0.0.1", 0), dp.make_handler(pipeline))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with urllib.request.urlopen(base + "/pending") as r:
            assert r.status == 200
            assert r.headers["Access-Control-Allow-Origin"] == "https://www.hltv.org"
            assert r.headers["Access-Control-Allow-Private-Network"] == "true"
            assert json.loads(r.read())["pending"] == 1
        req = urllib.request.Request(base + "/pending", method="OPTIONS",
                                     headers={"Origin": "https://www.hltv.org",
                                              "Access-Control-Request-Private-Network": "true"})
        with urllib.request.urlopen(req) as r:
            assert r.status == 204
            assert r.headers["Access-Control-Allow-Private-Network"] == "true"
            assert "GET" in r.headers["Access-Control-Allow-Methods"]
    finally:
        server.shutdown()


def test_scan_waits_for_complete_file_before_judging_magic(tmp_path, monkeypatch):
    # Regression: a download sampled before its RAR header was written used to be ignored forever.
    monkeypatch.setattr(dp, "DOWNLOADS", tmp_path)
    monkeypatch.setattr(dp, "LEDGER", tmp_path / "ledger.jsonl")
    d = tmp_path / "hash"
    d.mkdir()
    f = d / "f3a92631-1281-45b5-80bb-48725dbb136b"
    f.write_bytes(b"\x00" * 64)
    p = dp.Pipeline()
    p.scan(0.0)
    f.write_bytes(b"Rar!\x1a\x07\x01\x00" + b"x" * 100)  # header lands, size changes
    p.scan(5.0)
    assert not p.archives and f not in p.ignored
    p.scan(16.0)
    assert list(p.archives) == [f.name]
    junk = d / "notrar"
    junk.write_bytes(b"PK\x03\x04" + b"x" * 100)
    p.scan(20.0)
    p.scan(31.0)
    assert junk in p.ignored and "notrar" not in p.archives


def test_assist_on_own_teammate_is_not_credited():
    # A pro demo, tick 31391: a T player (C) hurt his teammate (D) for 38, a CT player (A) killed D, and
    # player_death names C as assister; the scoreboard does not count it (assists 1, not 2).
    kills = _kills([(A, D, C, False, False, False)])
    sb = _sb([(A, 1, 0, 0, 0, 0), (B, 0, 0, 0, 0, 0), (C, 0, 0, 0, 0, 0), (D, 0, 1, 0, 0, 0)])
    assert _fatal_failures(ex.validate_scoreboard(kills, {}, sb)) == []


def test_deaths_after_game_over_are_dropped():
    # A pro demo: the win panel fires at 148227; three players then die to "world" at
    # 148525 and 149507 (game phase 5), which the scoreboard never counts (deaths +1 each before the fix).
    rounds = pd.DataFrame(dict(start_tick=[0, 140930]))
    t = pd.Series([148034, 148525, 149507, 149507])  # the last real kill, then three post-match suicides
    assert ex.assign_rounds(t, rounds, [], game_over=148227).tolist() == [2, 0, 0, 0]


def test_round_one_recorded_live_and_a_leftover_round_end_at_tick_1():
    # A pro demo: the recording starts at tick 1 with round 1 already live, so round 1 has no
    # freeze end, and a winnerless round_end left over from before the recording sits at tick 1. Before the
    # fix that leftover counted as round 1 (ticks [1, None, 1]) and round 1 failed round_ticks.
    ends = pd.DataFrame(dict(tick=[1, 5163, 11169], round=[0, 1, 2], winner=[None, "CT", "CT"],
                             reason=[None, "t_killed", "t_killed"]))
    rounds, voided = ex.build_round_windows([1, 5483, 11489], [6763, 12769], ends, 0)
    assert rounds.start_tick.tolist() == [1, 5483] and rounds.end_tick.tolist() == [5163, 11169]
    assert rounds.freeze_end_tick.isna().tolist() == [True, False] and rounds.started_live.tolist() == [True, False]
    rounds["winner_team"] = ["TEAM_A", "TEAM_A"]
    checks = ex.validate_rounds(rounds, {"TEAM_A": 2, "TEAM_B": 0})
    assert [c for c in checks if c["fatal"] and not c["ok"]] == []
    assert any(c["check"] == "round_ticks" and c["note"].startswith("recording began") for c in checks)


# --- scheduler policy (memory and CPU readings are injected; no test starts a parse) -------------------

def test_memory_sizes_the_pool_under_the_cpu_cs2_and_configured_caps():
    # 20 GB available, 3 GB kept back, 1.5 GB a parse: 11 workers on 16 cores.
    assert dp.worker_capacity(20.0, 1.5, 0.0, 0, 16, False, None) == 11
    assert dp.worker_capacity(100.0, 1.5, 0.0, 0, 16, False, None) == 14  # cpu_count - 2
    assert dp.worker_capacity(100.0, 1.5, 0.0, 0, 16, False, 3) == 3  # CS2_PIPELINE_MAX_WORKERS
    assert dp.worker_capacity(100.0, 1.5, 0.0, 0, 16, True, None) == dp.GAMING_WORKERS


def test_running_workers_keep_their_slots_and_their_growth_is_reserved():
    # Three running workers still to grow 5.4 GB leave nothing for a fourth on 10 GB.
    assert dp.worker_capacity(10.0, 2.0, 5.4, 3, 16, False, None) == 3
    # Under the pressure floor nothing new starts, and nobody is dropped from the count.
    assert dp.worker_capacity(1.9, 0.5, 0.0, 2, 16, False, None) == 2


class _FakeProc:
    pids = iter(range(50000, 60000))

    def __init__(self, *a, **k):
        self.pid = next(self.pids)

    def poll(self):
        return None


def _jobs(n):
    a = dp.Archive(rar=dp.DOWNLOADS / "r", id="r", slug="slug-r")
    return [dp.Job(archive=a, dem=dp.WORK_DIR / f"d{i}.dem", out_dir=dp.DEMOS_DIR / "slug-r" / f"m{i}", map_key=f"m{i}",
                   result_path=dp.WORK_DIR / f"d{i}.result.json", log_path=dp.LOG_DIR / f"d{i}.log") for i in range(n)]


def test_a_burst_of_starts_reserves_each_new_workers_peak(tmp_path, monkeypatch):
    # 12 GB available that the new workers have not touched yet: 4 starts of a 2 GB parse, not 6.
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp.subprocess, "Popen", _FakeProc)
    p = dp.Pipeline()
    p.available_gb, p.cpu_count, p.peaks = (lambda: 12.0), 16, deque([2.0])
    p.jobs.extend(_jobs(6))
    p.dispatch()
    assert len(p.running) == 4 and len(p.jobs) == 2


def test_low_memory_requeues_the_newest_worker_and_keeps_published_tables(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    p = dp.Pipeline()
    old, new = _jobs(2)
    for j in (old, new):
        j.proc, j.t0 = _FakeProc(), time.time()
        p.running.append(j)
    published = new.out_dir / "v-1.13.0-abc"
    staging = new.out_dir / f".tmp-{new.proc.pid + 1}"  # the interpreter under the venv launcher stub
    published.mkdir(parents=True)
    staging.mkdir()
    monkeypatch.setattr(dp, "kill_tree", lambda proc: [proc.pid, proc.pid + 1])
    monkeypatch.setattr(dp, "tree_rss_gb", lambda pid: 0.5)
    p.available_gb = lambda: 0.8
    p.poll_workers()
    assert p.running == [old] and p.jobs[0] is new
    assert published.exists() and not staging.exists()


def test_want_keeps_the_workers_fed_by_littles_law():
    # 4 workers at 600 worker-seconds an archive finish one every 150 s; a 120 s download keeps 0.8 busy: 1 + 1.
    assert dp.desired_downloads(4, 600, 120, 0, 100.0, 2.0) == 2
    # Slow downloads need more in flight, up to MAX_WANT.
    assert dp.desired_downloads(14, 240, 300, 0, 100.0, 2.0) == dp.MAX_WANT
    # The disk budget left holds one more 2 GB archive beside the one in flight.
    assert dp.desired_downloads(14, 240, 300, 1, 2.5, 2.0) == 2
    assert dp.desired_downloads(14, 240, 300, 0, -5.0, 2.0) == 1


def test_parse_peak_is_the_p90_of_measured_peaks():
    assert dp.p90([], 4.0) == 4.0
    assert dp.p90([1.0 + i / 10 for i in range(20)], 4.0) == pytest.approx(2.7)  # the 18th of 20
    peaks, parse_s = dp.manifest_seed([dict(archive="a", peak_rss_gb=1.2, timings=dict(worker_wall_s=60)),
                                       dict(archive="b", peak_rss_gb=None, timings=dict(worker_wall_s=30)),
                                       dict(archive="a", peak_rss_gb=1.4, timings=dict(worker_wall_s=90))])
    assert peaks == [1.2, 1.4] and parse_s == [30.0, 150.0]


def test_a_download_is_timed_from_first_sight_only_if_it_grew():
    t = dp.CompletenessTracker(stable_seconds=10)
    t.observe(Path("x"), 100, 0.0)
    t.observe(Path("x"), 500, 40.0)
    assert t.observe(Path("x"), 500, 50.0) and t.download_s(Path("x"), 50.0) == 50.0
    t.observe(Path("y"), 900, 0.0)  # already whole when first seen
    assert t.observe(Path("y"), 900, 10.0) and t.download_s(Path("y"), 10.0) is None


def test_each_failed_demo_is_retried_once_per_extractor_version(tmp_path):
    f = tmp_path / "kept"
    f.mkdir()
    (f / "x-m1-nuke.result.json").write_text(json.dumps(dict(dem_file="x-m1-nuke.dem", extractor_version="1.10.0")))
    (f / "x-m2-dust2.result.json").write_text(json.dumps(dict(dem_file="x-m2-dust2.dem", extractor_version="1.14.0")))
    assert dp.due_for_retry(f, "1.14.0")  # m1 failed under 1.10.0
    (f / "x-m1-nuke.result.json").write_text(json.dumps(dict(dem_file="x-m1-nuke.dem", extractor_version="1.14.0")))
    assert not dp.due_for_retry(f, "1.14.0") and dp.due_for_retry(f, "1.15.0")
    g = tmp_path / "unlisted"  # a 7-Zip failure has no demo results
    g.mkdir()
    (g / "reason.json").write_text(json.dumps(dict(reason="7z exit 2", extractor_version="1.14.0")))
    assert not dp.due_for_retry(g, "1.14.0")


def test_status_reports_want_beside_the_real_pending_count(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    p = dp.Pipeline()
    p.available_gb = lambda: 20.0
    snap = p.snapshot()
    assert snap["capacity"] and snap["pending"] == snap["pendingActual"] == 0
    assert {"want", "workersMax", "parseEstGB", "availGB"} <= set(snap) and snap["parseEstGB"] == dp.DEFAULT_PARSE_EST_GB


# --- disk budget ------------------------------------------------------------

def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(dp, "DATA_ROOT", tmp_path)
    for name in ("DEMOS_DIR", "WORK_DIR", "FAILED_DIR", "LOG_DIR", "DOWNLOADS"):
        d = tmp_path / name.lower()
        d.mkdir()
        monkeypatch.setattr(dp, name, d)
    monkeypatch.setattr(dp, "LEDGER", dp.DEMOS_DIR / "archives.jsonl")
    monkeypatch.setattr(dp, "DROPPED", dp.DEMOS_DIR / "failed_dropped.jsonl")
    monkeypatch.setattr(dp, "MANIFEST", dp.DEMOS_DIR / "manifest.jsonl")




def test_capacity_turns_off_over_budget(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "MAX_OUR_GB", 1e-6)  # 1000 bytes
    p = dp.Pipeline()
    assert p.budget(fresh=True)[1]
    (dp.DEMOS_DIR / "x.parquet").write_bytes(b"x" * 2000)
    our, ok = p.budget(fresh=True)
    assert not ok and our > 1e-6
    snap = p.snapshot()
    assert snap["capacity"] is False and snap["pending"] >= 2 and snap["pendingActual"] == 0


def test_capacity_respects_free_space(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "free_gb", lambda path=None: 44.0)
    assert not dp.Pipeline().budget(fresh=True)[1]


def test_sweep_removes_only_stale_unowned_work(tmp_path, monkeypatch):
    import os
    import time
    _isolate(tmp_path, monkeypatch)
    old, owned, fresh = (dp.WORK_DIR / n for n in ("old", "owned", "fresh"))
    for d in (old, owned, fresh):
        d.mkdir()
        (d / "f.dem").write_bytes(b"x")
    past = time.time() - 3 * 3600
    for d in (old, owned):
        os.utime(d / "f.dem", (past, past))
        os.utime(d, (past, past))
    p = dp.Pipeline()
    p.archives["a"] = dp.Archive(rar=tmp_path / "r", id="a", work=owned)
    p.sweep_work(force=True)
    assert not old.exists() and owned.exists() and fresh.exists()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows job objects")
def test_children_die_with_the_pipeline(tmp_path):
    import subprocess
    import time
    import psutil
    code = ("import sys, subprocess, time; sys.path.insert(0, r'%s'); import demo_pipeline as dp; "
            "dp.bind_children_to_this_process(); "
            "c = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
            "print(c.pid, flush=True); time.sleep(60)") % ROOT
    parent = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
    child = int(parent.stdout.readline())
    assert psutil.pid_exists(child)
    parent.kill()
    parent.wait()
    deadline = time.time() + 10
    while psutil.pid_exists(child) and time.time() < deadline:
        time.sleep(0.2)
    assert not psutil.pid_exists(child)


def test_restore_in_round_one_is_voided():
    # A pro demo: match starts at 98/99, restore at 4020, real round 1 freeze end 5892.
    ends = pd.DataFrame(dict(tick=[0, 4020, 10704], round=[0, 1, 2], winner=[None, None, "T"],
                             reason=[None, None, "bomb_exploded"]))
    rounds, voided = ex.build_round_windows([0, 98, 4020], [5892], ends, 99)
    assert rounds.start_tick.tolist() == [4020] and voided == [(98, 4020)]
    assert ex.assign_rounds(pd.Series([318, 4020, 6000]), rounds, voided).tolist() == [0, 0, 1]


def test_round_one_without_restore_has_no_voided_window():
    ends = pd.DataFrame(dict(tick=[7149], round=[1], winner=["T"], reason=["bomb_exploded"]))
    rounds, voided = ex.build_round_windows([1, 576], [1856], ends, 577)
    assert rounds.start_tick.tolist() == [576] and voided == []




def test_a_written_v1_map_counts_as_success_and_a_missing_one_does_not(tmp_path, monkeypatch):
    # Regression: the pipeline looked for the pre-v1 meta.parquet and failed every v1 map.
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "MANIFEST", dp.DEMOS_DIR / "manifest.jsonl")
    p = dp.Pipeline()
    a = dp.Archive(rar=tmp_path / "r", id="r", slug="s")
    for name, write in (("m1", True), ("m2", False)):
        out = dp.DEMOS_DIR / "s" / name
        out.mkdir(parents=True)
        if write:
            (out / "match.parquet").write_bytes(b"x")
        res = tmp_path / f"{name}.json"
        res.write_text(json.dumps({"ok": True, "errors": []}))
        p.finish_job(dp.Job(archive=a, dem=tmp_path / f"{name}.dem", out_dir=out, map_key=name, result_path=res,
                            log_path=tmp_path / f"{name}.log"), 0)
    assert {n: r["ok"] for n, r in a.results.items()} == {"m1.dem": True, "m2.dem": False}


def test_every_failed_map_has_a_reason_in_the_manifest(tmp_path, monkeypatch):
    # Four manifest failures were read as reasonless: crashes carry no validation list.
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "MANIFEST", dp.DEMOS_DIR / "manifest.jsonl")
    p = dp.Pipeline()
    a = dp.Archive(rar=tmp_path / "r", id="r", slug="s")
    silent = tmp_path / "silent.json"
    silent.write_text(json.dumps({"ok": False, "errors": []}))
    for name, result in (("silent", silent), ("crashed", tmp_path / "missing.json")):
        p.finish_job(dp.Job(archive=a, dem=tmp_path / f"{name}.dem", out_dir=dp.DEMOS_DIR / "s" / name, map_key=name,
                            result_path=result, log_path=tmp_path / f"{name}.log"), 3)
    lines = [json.loads(x) for x in dp.MANIFEST.read_text().splitlines()]
    assert [bool(x["fail_reason"]) for x in lines] == [True, True]
    assert "exit 3" in lines[1]["fail_reason"]


def test_a_re_extraction_replaces_only_its_own_old_folder(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "NEEDS_REEXTRACT", dp.DEMOS_DIR / "needs_reextract.jsonl")
    old, other = dp.DEMOS_DIR / "old-slug" / "m1-nuke", dp.DEMOS_DIR / "old-slug" / "m2-dust2"
    for d in (old, other):
        d.mkdir(parents=True)
        (d / "meta.parquet").write_bytes(b"x")
    rows = [dict(dem_file="a-vs-b-m1-nuke.dem", dem_bytes=100, out_dir=str(old.relative_to(tmp_path))),
            dict(dem_file="a-vs-b-m2-dust2.dem", dem_bytes=200, out_dir=str(other.relative_to(tmp_path)))]
    dp.NEEDS_REEXTRACT.write_text("".join(json.dumps(r) + "\n" for r in rows))
    # m1 re-extracted as v1; a same-named demo of a different size (another match) must not count
    new = dp.DEMOS_DIR / "new-slug" / "m1-nuke"
    _write_map(new)
    dp.replace_old_extractions({"x": dict(ok=True, dem_file="a-vs-b-m1-nuke.dem", dem_bytes=100),
                                "y": dict(ok=True, dem_file="a-vs-b-m2-dust2.dem", dem_bytes=999)},
                               {"x": new, "y": dp.DEMOS_DIR / "new-slug" / "m2-dust2"})
    assert not old.exists() and other.exists()
    assert [json.loads(x)["dem_file"] for x in dp.NEEDS_REEXTRACT.read_text().splitlines()] == ["a-vs-b-m2-dust2.dem"]


def _pr(rows):
    df = pd.DataFrame(rows, columns=["round", "steamid", "game_damage"])
    return df.astype({"steamid": "UInt64"})


def test_every_rebuilt_hit_is_unattributed():
    # A pro demo, round 2: ticks 9168-9184 carry no player_hurt or weapon_fire, yet a CT (V1) drops 48 -> 0
    # at 9173 (player_death names T1 with a galil) and T1 drops 100 -> 45 at 9182; on another demo a player
    # dies to the world from 74 HP. None of the three is credited, the kill and the suicide included: the
    # evidence that would rule other players out can be lost in the same gap.
    T1, V1, C1, S1 = 76561190000000011, 76561190000000012, 76561190000000013, 76561190000000014
    side = {(2, T1): "T", (2, V1): "CT", (2, C1): "CT", (2, S1): "CT"}
    dmg = ex.pd.DataFrame(dict(tick=[8802, 9196], round=[2, 2], attacker_steamid=[T1, C1],
                               victim_steamid=[C1, T1], dmg_health_capped=[231, 85],
                               is_team_damage=[False, False])).astype({"attacker_steamid": "UInt64",
                                                                       "victim_steamid": "UInt64"})
    drops = ex.pd.DataFrame(dict(tick=[8802, 9173, 9182, 9500], steamid=[C1, V1, T1, S1],
                                 health_before=[100, 48, 100, 74], health_after=[0, 0, 45, 0], round=[2, 2, 2, 2]))
    out = ex.rebuild_lost_hits(drops, dmg, side)  # 8802 has its player_hurt: not rebuilt
    assert out.tick.tolist() == [9173, 9182, 9500] and out.attacker_steamid.isna().all()
    assert out.reconstructed_ambiguous.all() and out.weapon.isna().all() and not out.is_self.any()
    assert not out.is_team_damage.any() and out.dmg_health_capped.tolist() == [48, 55, 74]


def test_game_damage_is_the_counter_rise_measured_on_the_next_round_start():
    # A split recording's first part: round 16 ends 133021, one player's counter reads 1123 at 133340 and 1246 at the
    # 133341 round start, where the game commits the round's damage. The baseline carries an earlier part.
    X_ = 76561190000000002
    counter = ex.pd.DataFrame(dict(tick=[120000, 133341], steamid=[X_, X_], damage_total=[1123, 1246]))
    rise = ex.game_damage_by_round(counter, [15, 16], [120000, 133341], {X_: 1000})
    assert rise == {(15, X_): 123, (16, X_): 123}


def test_a_re_extraction_into_the_same_folder_keeps_it(tmp_path, monkeypatch):
    # A retry from failed/ writes the same slug folder; deleting the listed "old" folder would delete the new map.
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "NEEDS_REEXTRACT", dp.DEMOS_DIR / "needs_reextract.jsonl")
    same = dp.DEMOS_DIR / "slug" / "m1-nuke"
    written = _write_map(same)
    dp.NEEDS_REEXTRACT.write_text(json.dumps(dict(dem_file="a.dem", dem_bytes=1, out_dir=str(same.relative_to(tmp_path))))
                                  + "\n")
    dp.replace_old_extractions({"x": dict(ok=True, dem_file="a.dem", dem_bytes=1, version_dir=written.name)},
                               {"x": same})
    assert same.exists() and dp.NEEDS_REEXTRACT.read_text() == ""


def test_workers_run_a_frozen_copy_of_the_extractor(tmp_path, monkeypatch):
    # Edits to the repo while the pipeline ran reached live workers and failed 13 maps.
    monkeypatch.setattr(dp, "RUN_CODE", tmp_path / "run")
    dp.freeze_code()
    assert sorted(p.name for p in (tmp_path / "run").iterdir()) == sorted(dp.CODE_FILES)
    for name in dp.CODE_FILES:
        assert (tmp_path / "run" / name).read_bytes() == (dp.ROOT / name).read_bytes()



def test_the_frozen_copy_holds_every_module_the_extractor_imports():
    # extract.py began importing repo_guard and the copy did not follow: every worker died on the import.
    import ast
    code = [n for n in dp.CODE_FILES if n.endswith(".py")]
    for name in code:
        for node in ast.walk(ast.parse((dp.ROOT / name).read_text(encoding="utf-8"))):
            mods = [a.name for a in node.names] if isinstance(node, ast.Import) else                 [node.module] if isinstance(node, ast.ImportFrom) and node.module else []
            for m in mods:
                if (dp.ROOT / f"{m.split('.')[0]}.py").exists():
                    assert f"{m.split('.')[0]}.py" in code, f"{name} imports {m}, which the frozen copy lacks"


def _failed_archive(tmp_path, name, dem_bytes=b"dem", reason="ValidationFailed: deaths 12!=13"):
    rar = dp.DOWNLOADS / name
    rar.write_bytes(dp.RAR_MAGIC + bytes(10))
    work = dp.WORK_DIR / name
    work.mkdir()
    (work / f"{name}-m1-nuke.dem").write_bytes(dem_bytes)
    (work / f"{name}-m2-dust2.dem").write_bytes(dem_bytes)
    a = dp.Archive(rar=rar, id=name, slug=f"slug-{name}", work=work,
                   listing={f"{name}-m1-nuke.dem": {}, f"{name}-m2-dust2.dem": {}})
    a.results = {f"{name}-m1-nuke.dem": {"ok": False, "errors": [reason]}, f"{name}-m2-dust2.dem": {"ok": True}}
    return a


def test_a_failure_keeps_its_archive_failing_demo_and_report_together(tmp_path, monkeypatch):
    # Deleting failed archives left 4 death mismatches and a damage gap impossible to root-cause.
    _isolate(tmp_path, monkeypatch)
    p = dp.Pipeline()
    a = _failed_archive(tmp_path, "u1")
    p.archives[a.id] = a
    p.fail_archive(a, "deaths")
    kept = dp.FAILED_DIR / "slug-u1"
    assert sorted(f.name for f in kept.iterdir()) == ["archive.rar", "reason.json", "u1-m1-nuke.dem",
                                                      "u1-m1-nuke.result.json"]
    assert json.loads((kept / "u1-m1-nuke.result.json").read_text())["errors"] == ["ValidationFailed: deaths 12!=13"]
    assert not a.work.exists() and not a.rar.exists()


def test_failed_dir_drops_the_oldest_beyond_its_cap(tmp_path, monkeypatch):
    import os
    _isolate(tmp_path, monkeypatch)
    p = dp.Pipeline()
    for i, name in enumerate(["old", "mid", "new"]):
        if i == 2:  # room for two kept failures
            monkeypatch.setattr(dp, "MAX_FAILED_GB", 2.5 * dp.tree_bytes(dp.FAILED_DIR / "slug-old") / 1e9)
        a = _failed_archive(tmp_path, name, dem_bytes=b"x" * 1000)
        p.archives[a.id] = a
        p.fail_archive(a, "deaths")
        os.utime(dp.FAILED_DIR / f"slug-{name}", (1000 + i, 1000 + i))
        p.enforce_failed_cap()
    assert sorted(d.name for d in dp.FAILED_DIR.iterdir()) == ["slug-mid", "slug-new"]
    assert [json.loads(x)["slug"] for x in dp.DROPPED.read_text().splitlines()] == ["slug-old"]


def test_a_truncated_demo_is_logged_and_never_kept_or_retried(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    p = dp.Pipeline(retry_failed=True)
    a = _failed_archive(tmp_path, "cut", reason="truncated_demo: InvalidDemoError: unexpected end of data")
    p.archives[a.id] = a
    p.fail_archive(a, "truncated")
    assert list(dp.FAILED_DIR.iterdir()) == [] and not a.rar.exists()
    assert json.loads(dp.DROPPED.read_text().splitlines()[0])["reason"] == "truncated_demo"
    p.scan(0.0)
    assert p.archives == {}


def test_a_retried_failure_that_passes_removes_its_kept_folder(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "NEEDS_REEXTRACT", dp.DEMOS_DIR / "needs_reextract.jsonl")
    p = dp.Pipeline()
    a = _failed_archive(tmp_path, "u2")
    p.archives[a.id] = a
    p.fail_archive(a, "deaths")
    kept = dp.FAILED_DIR / "slug-u2"
    work = dp.WORK_DIR / "again"
    work.mkdir()
    r = dp.Archive(rar=kept / "archive.rar", id="slug-u2", slug="slug-u2", state="parsing", work=work,
                   dems=[work / "u2-m1-nuke.dem"])
    r.results = {"u2-m1-nuke.dem": {"ok": True, "map": "m1-nuke"}}
    p.archives[r.id] = r
    p.finish_archives()
    assert not kept.exists() and p.ledger["slug-u2"]["status"] == "done"



def test_match_starts_at_the_last_restart_that_rounds_follow():
    # A pro demo: a round ends before restarts at 5290 and 5429, so the match starts at 5429.
    assert ex.match_start_tick([99, 5290, 5429], [4800, 9000, 15000]) == 5429
    # A split recording's first part: begin_new_match after the last round must not void the rounds before it.
    assert ex.match_start_tick([137818], [7507, 133021]) == 0
    # The usual case: one begin_new_match just before round 1.
    assert ex.match_start_tick([577], [7149]) == 577



def test_lost_burn_ticks_stay_unattributed():
    # A pro demo, round 2: seven lost burn ticks (1, 3, 3, 4, 5, 6, 6 = 28 HP) on one CT; the only T short
    # of his game damage is short by exactly 28 (36 counted, 8 recorded). That total is no evidence of who
    # burned him, so none is credited.
    side = {(2, A): "CT", (2, C): "T", (2, D): "T"}
    burns = [1, 3, 3, 4, 5, 6, 6]
    hp = list(np.cumsum([0] + burns))
    drops = ex.pd.DataFrame(dict(tick=[13753 + 13 * i for i in range(7)], steamid=A, health_before=[100 - h for h in hp[:-1]],
                                 health_after=[100 - h for h in hp[1:]], round=2))
    dmg = ex.pd.DataFrame(dict(tick=[13000], round=[2], attacker_steamid=[C], victim_steamid=[A], dmg_health_capped=[8],
                               is_team_damage=[False], v_side=["CT"], reconstructed_ambiguous=[False])).astype(
        {"attacker_steamid": "UInt64", "victim_steamid": "UInt64"})
    out = ex.rebuild_lost_hits(drops, dmg, side)
    assert out.attacker_steamid.isna().all() and out.reconstructed_ambiguous.all()


def test_a_winnerless_attempt_is_voided_only_if_the_game_rolled_its_stats_back():
    # A pro demo: kills plus deaths stay put across the 45420-57646 restore (rolled back), but a
    # world suicide inside 78153-97787 raised deaths_total and stayed counted (the game kept that attempt).
    totals = {45420: 120, 57646 + 64: 120, 78153: 131, 97787 + 64: 132}
    assert ex.split_restores([(45420, 57646), (78153, 97787)], totals, 64.0) == ([(45420, 57646)],
                                                                                [(78153, 97787)])


def test_restores_are_judged_one_second_after_the_restore_at_any_tick_rate():
    # The counters were sampled 64 ticks after the restore, which is half a second on a 128-tick demo.
    # Here a 128-tick demo's kept attempt only shows its counted death one second (128 ticks) later.
    totals = {1000: 50, 5000 + 64: 50, 5000 + 128: 51}
    assert ex.split_restores([(1000, 5000)], totals, 128.0) == ([], [(1000, 5000)])



def test_trade_flags_skip_a_world_death_before_the_trade():
    # A pro demo crashed: an earlier kill with no attacker (world) made the comparison NA.
    k = pd.DataFrame(dict(round=[1, 1, 1], tick=[0, 50, 200], attacker_steamid=[None, C, A],
                          victim_steamid=[D, B, C], attacker_side=[None, "T", "CT"], victim_side=["T", "CT", "T"],
                          is_teamkill=False, is_suicide=False)).astype({"attacker_steamid": "UInt64",
                                                                        "victim_steamid": "UInt64"})
    trade, traded = ex._trade_flags(k, 64.0, 5.0)
    assert trade.tolist() == [False, False, True] and traded.tolist() == [False, True, False]


def test_a_torn_last_ledger_line_does_not_brick_startup(tmp_path, monkeypatch):
    # A crash mid-append leaves half a JSON line; startup used to raise on it.
    _isolate(tmp_path, monkeypatch)
    dp.LEDGER.write_text('{"id": "a", "status": "done"}\n{"id": "b", "sta', encoding="utf-8")
    assert list(dp.read_ledger()) == ["a"]
    dp.append_jsonl(dp.LEDGER, {"id": "c", "status": "failed"})
    assert sorted(dp.read_ledger()) == ["a", "c"]  # the next append starts on its own line


def test_a_malformed_line_before_the_end_still_fails_loudly(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    dp.LEDGER.write_text('{"id": "a"}\nnot json\n{"id": "b"}\n', encoding="utf-8")
    with pytest.raises(json.JSONDecodeError):
        dp.read_ledger()



def test_deletes_refuse_paths_outside_the_data_and_download_roots(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("x")
    with pytest.raises(ValueError):
        dp.safe_rmtree(outside)
    with pytest.raises(ValueError):
        dp.safe_rmtree(dp.DATA_ROOT)  # the root itself is never deleted
    with pytest.raises(ValueError):
        dp.safe_unlink(outside / "keep.txt")
    assert (outside / "keep.txt").exists()


def test_a_ledger_row_cannot_point_a_delete_outside_the_data_folder(tmp_path, monkeypatch):
    # replace_old_extractions deletes the folder a needs_reextract row names; a crafted row must not escape.
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "NEEDS_REEXTRACT", dp.DEMOS_DIR / "needs_reextract.jsonl")
    victim = tmp_path.parent / f"{tmp_path.name}-victim"
    victim.mkdir()
    rows = [dict(dem_file="a.dem", dem_bytes=1, out_dir=f"../{victim.name}"),
            dict(dem_file="b.dem", dem_bytes=2, out_dir=str(victim))]
    dp.NEEDS_REEXTRACT.write_text("".join(json.dumps(r) + "\n" for r in rows))
    dp.replace_old_extractions({"x": dict(ok=True, dem_file="a.dem", dem_bytes=1),
                                "y": dict(ok=True, dem_file="b.dem", dem_bytes=2)}, set())
    assert victim.exists()



def _pending_archive(tmp_path, dem_bytes):
    rar = dp.DOWNLOADS / "u"
    rar.write_bytes(dp.RAR_MAGIC + bytes(10))
    return dp.Archive(rar=rar, id="u"), {"m1.dem": dict(size=dem_bytes, modified=None)}


def test_an_archive_whose_demos_would_break_the_budget_is_not_extracted(tmp_path, monkeypatch):
    # The budget counted only what was already on disk, so a 2 GB expansion could push it past 12 GB.
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "MAX_OUR_GB", 1.0)
    monkeypatch.setattr(dp, "free_gb", lambda path=None: 100.0)
    a, listing = _pending_archive(tmp_path, int(0.6e9))
    (dp.DEMOS_DIR / "existing.parquet").write_bytes(b"x" * 100)
    started = []
    monkeypatch.setattr(dp, "list_archive", lambda rar: listing)
    monkeypatch.setattr(dp.subprocess, "Popen", lambda *x, **k: started.append(x))
    p = dp.Pipeline()
    p.archives[a.id] = a
    monkeypatch.setattr(p, "disk_usage", lambda: (int(0.5e9), 0))  # 0.5 GB on disk + 0.6 GB of demos > 1 GB
    p.start_extractions()
    assert started == [] and a.state == "pending"
    monkeypatch.setattr(p, "disk_usage", lambda: (int(0.3e9), 0))  # 0.3 + 0.6 fits
    p.start_extractions()
    assert len(started) == 1 and a.state == "extracting"



def test_an_archive_still_extracting_holds_its_listed_size_against_the_next_one(tmp_path, monkeypatch):
    # The check counted only bytes already on disk, so a second archive could start while the first one's
    # 7-Zip run had written nothing yet, and together they broke the budget. Sizes in bytes: the budget is
    # 1000, each archive lists 600 bytes of demos.
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "MAX_OUR_GB", 1e-6)
    monkeypatch.setattr(dp, "free_gb", lambda path=None: 100.0)
    archives = []
    for name in ("a", "b"):
        rar = dp.DOWNLOADS / name
        rar.write_bytes(dp.RAR_MAGIC + bytes(10))
        archives.append(dp.Archive(rar=rar, id=name))
    listing = {"m1.dem": dict(size=600, modified=None)}
    started = []
    monkeypatch.setattr(dp, "list_archive", lambda rar: listing)
    monkeypatch.setattr(dp.subprocess, "Popen", lambda *x, **k: started.append(x))
    p = dp.Pipeline()
    for a in archives:
        p.archives[a.id] = a
    first, second = sorted(archives, key=lambda a: a.rar.stat().st_mtime)
    p.start_extractions()
    assert len(started) == 1 and first.state == "extracting" and second.state == "pending"
    (first.work / "m1.dem").write_bytes(b"x" * 600)  # 7-Zip wrote the demo: it now counts as disk use
    p.start_extractions()
    assert len(started) == 1 and second.state == "pending"
    (first.work / "m1.dem").unlink()  # the first archive finished and its demos are gone
    del p.archives[first.id]
    p.start_extractions()
    assert len(started) == 2 and second.state == "extracting"

def test_an_archive_that_breaks_the_free_space_floor_waits(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "free_gb", lambda path=None: 46.0)  # 46 GB free, 2 GB of demos -> 44 < 45
    a, listing = _pending_archive(tmp_path, int(2e9))
    started = []
    monkeypatch.setattr(dp, "list_archive", lambda rar: listing)
    monkeypatch.setattr(dp.subprocess, "Popen", lambda *x, **k: started.append(x))
    p = dp.Pipeline()
    p.archives[a.id] = a
    p.start_extractions()
    assert started == [] and a.state == "pending"


def test_an_archive_too_big_to_ever_fit_fails_with_a_reason(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "MAX_OUR_GB", 1.0)
    monkeypatch.setattr(dp, "free_gb", lambda path=None: 100.0)
    a, listing = _pending_archive(tmp_path, int(1.5e9))
    monkeypatch.setattr(dp, "list_archive", lambda rar: listing)
    monkeypatch.setattr(dp.subprocess, "Popen", lambda *x, **k: pytest.fail("must not extract"))
    p = dp.Pipeline()
    p.archives[a.id] = a
    p.start_extractions()
    assert a.id not in p.archives and "larger than the" in p.ledger["u"]["reason"]



def _map(d, content):
    d.mkdir(parents=True)
    (d / "match.parquet").write_text(content)


def test_a_crash_after_a_pre_1_5_swap_keeps_the_new_map(tmp_path):
    # Extractors before 1.5.0 swapped whole folders and could leave <map>.old beside the map.
    out = tmp_path / "m1"
    _map(out, "new")
    _map(tmp_path / "m1.old", "old")  # the swap finished; only deleting the old copy was interrupted
    ex.recover_output(out)
    assert (out / "match.parquet").read_text() == "new" and not (tmp_path / "m1.old").exists()



def _rounds_frame(**override):
    import schema_v1
    row = {c: None for c in schema_v1.TYPES["rounds"]}
    row.update(round=1, start_tick=1, freeze_end_tick=100, end_tick=900, started_live=False, aborted=False,
               winner_side="CT", reason="t_killed", voided_attempts=0, ct_team="A", t_team="B", winner_team="A",
               ct_team_score_after=1, t_team_score_after=0, duration_s=12.5, ct_equip_value=4000, t_equip_value=4000,
               ct_money_start=4000, t_money_start=4000)
    row.update(override)
    return pd.DataFrame([row])


def test_the_writer_rejects_a_null_in_a_non_nullable_column():
    # A live-start round wrote duration_s = NaN into a column the schema declares non-null.
    with pytest.raises(ValueError, match="duration_s"):
        ex._to_polars(_rounds_frame(duration_s=float("nan")), "rounds")


def test_the_writer_rejects_a_duplicate_key():
    with pytest.raises(ValueError, match="key"):
        ex._to_polars(pd.concat([_rounds_frame(), _rounds_frame()]), "rounds")


def test_a_round_recorded_live_is_timed_from_its_start():
    r = pd.DataFrame(dict(start_tick=[1, 5483], freeze_end_tick=[None, 6763], end_tick=[5163, 11169]))
    assert ex.round_duration_s(r, 64.0).tolist() == [(5163 - 1) / 64, (11169 - 6763) / 64]


# Lost hits: rebuilt, never credited.
LA, LB, LC, LV, LW = (76561190000000021, 76561190000000022, 76561190000000023, 76561190000000031,
                      76561190000000032)
LOST_SIDES = {(3, LA): "T", (3, LB): "T", (3, LC): "T", (3, LV): "CT", (3, LW): "CT"}


def _lost(*rows):
    """rows: (tick, victim, health_before, health_after), all in round 3."""
    return pd.DataFrame(dict(tick=[r[0] for r in rows], steamid=[r[1] for r in rows],
                             health_before=[r[2] for r in rows], health_after=[r[3] for r in rows], round=3))


def _no_events():
    dmg = pd.DataFrame(dict(tick=pd.Series([], dtype="int64"), victim_steamid=pd.Series([], dtype="UInt64")))
    kills = pd.DataFrame(dict(tick=pd.Series([], dtype="int64"), victim_steamid=pd.Series([], dtype="UInt64"),
                              attacker_steamid=pd.Series([], dtype="UInt64"), weapon=[], hitgroup=[]))
    return dmg, kills


def _hit_table(rows):
    """rows: (round, attacker or None, hp, team damage, rebuilt with no attacker)."""
    df = pd.DataFrame(rows, columns=["round", "attacker_steamid", "dmg_health_capped", "is_team_damage",
                                     "reconstructed_ambiguous"])
    df["attacker_steamid"] = pd.array([r[1] for r in rows], dtype="UInt64")
    return df


def test_a_hit_table_short_of_the_game_counter_passes_and_records_the_gap():
    # The game counted 100 for LA in round 3. The hit table names him for 45; 55 HP is a rebuilt hit no shot
    # names, and his 30 HP of team damage does not count. The map passes on the game's counter, and the
    # gap the engine cannot credit per event is a named warning.
    checks, hp = ex.hit_table_checks(_hit_table([(3, LA, 45, False, False), (3, None, 55, False, True),
                                                 (3, LA, 30, True, False)]), _pr([(3, LA, 100), (3, LV, 0)]))
    assert [c for c in checks if c["fatal"] and not c["ok"]] == []
    warn = [c for c in checks if c["check"] == "damage_events_incomplete"]
    assert hp == 55 and [(w["ok"], w["fatal"], w["actual"]) for w in warn] == [(False, False, 55)]
    assert "damage_events_incomplete: 55 HP" in warn[0]["note"]


def test_a_hit_table_over_the_game_counter_fails_the_map():
    # More credited than the game counted cannot come from lost events: a round boundary read early, or a
    # hit given to the wrong player.
    checks, _ = ex.hit_table_checks(_hit_table([(3, LA, 45, False, False)]), _pr([(3, LA, 40)]))
    assert [(c["check"], c["actual"]) for c in checks if c["fatal"] and not c["ok"]] == \
        [("hit_table_over_game_damage", 1)]


# Versioned map folders: <map>/v-<version>-<hash>/ and a CURRENT pointer replaced with os.replace.
_TABLE_FILES = ("match.parquet", "rounds.parquet")  # what _tables writes


def _tables(d, content):
    d.mkdir(parents=True)
    for name in ("match", "rounds"):
        (d / f"{name}.parquet").write_text(f"{name} {content}")


def test_publishing_a_map_never_renames_a_folder_a_reader_has_open(tmp_path):
    # Before 1.5.0 the map folder itself was renamed aside, which Windows refuses while a reader has a
    # file in it open. Now the new tables go to a new folder and only the small CURRENT file is replaced.
    m = tmp_path / "m1"
    _tables(m / ".tmp-1", "old")
    v1 = ex.publish_version(m / ".tmp-1", m, "1.5.0", _TABLE_FILES)
    assert ex.resolve_map_dir(m) == v1
    with open(v1 / "match.parquet", "rb"):  # a reader holds the old version open
        _tables(m / ".tmp-2", "new")
        v2 = ex.publish_version(m / ".tmp-2", m, "1.5.0", _TABLE_FILES)
        assert ex.resolve_map_dir(m) == v2 and (v2 / "match.parquet").read_text() == "match new"
        left = ex.prune_map(m)
        if sys.platform == "win32":  # the open file cannot be deleted yet; that is left for later
            assert left == [v1] and (v1 / "match.parquet").exists()
    assert ex.prune_map(m) == [] and sorted(x.name for x in m.iterdir()) == ["CURRENT", v2.name]


def test_a_crash_before_the_pointer_moves_leaves_the_old_map_current(tmp_path):
    m = tmp_path / "m1"
    _tables(m / ".tmp-1", "old")
    v1 = ex.publish_version(m / ".tmp-1", m, "1.5.0", _TABLE_FILES)
    _tables(m / "v-1.5.0-0000beef", "new")  # renamed into place, then the process died before CURRENT moved
    (m / ".tmp-7").mkdir()  # and another run died mid-write
    assert ex.resolve_map_dir(m) == v1
    assert ex.prune_map(m) == [] and sorted(x.name for x in m.iterdir()) == ["CURRENT", v1.name]


def test_a_pointer_that_names_anything_but_a_version_folder_is_refused(tmp_path):
    m = tmp_path / "m1"
    m.mkdir()
    (m / "CURRENT").write_text("..\\..\\elsewhere\n")
    with pytest.raises(ValueError, match="not a version folder"):
        ex.resolve_map_dir(m)


def test_a_map_from_before_versioned_folders_is_read_in_place_until_it_is_republished(tmp_path):
    m = tmp_path / "m1"
    _tables(m, "legacy")
    (m / "awpy").mkdir()  # not written by the extractor: never deleted by pruning
    assert ex.resolve_map_dir(m) == m and ex.prune_map(m) == [] and (m / "match.parquet").exists()
    _tables(m / ".tmp-1", "new")
    v = ex.publish_version(m / ".tmp-1", m, "1.5.0", _TABLE_FILES)
    assert ex.resolve_map_dir(m) == v
    assert ex.prune_map(m) == [] and sorted(x.name for x in m.iterdir()) == ["CURRENT", "awpy", v.name]


def test_pruning_a_folder_with_no_map_removes_only_what_the_extractor_wrote(tmp_path):
    # A pre-v1 folder (meta.parquet) has no CURRENT and no match.parquet; it is not debris.
    m = tmp_path / "m1"
    m.mkdir()
    (m / "meta.parquet").write_text("pre-v1")
    _tables(m / "v-1.5.0-0000beef", "orphan")
    (m / ".tmp-3").mkdir()
    assert ex.resolve_map_dir(m) is None and ex.prune_map(m) == []
    assert sorted(x.name for x in m.iterdir()) == ["meta.parquet"]


def test_a_retired_map_stops_resolving_at_once_and_goes_once_unlocked(tmp_path):
    m = tmp_path / "m1"
    _tables(m / ".tmp-1", "x")
    v = ex.publish_version(m / ".tmp-1", m, "1.5.0", _TABLE_FILES)
    with open(v / "match.parquet", "rb"):
        ex.retire_map(m)
        assert ex.resolve_map_dir(m) is None
    assert ex.prune_map(m) == [] and not m.exists()


def test_startup_tidies_every_map_and_leaves_pre_v1_folders_alone(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    live = dp.DEMOS_DIR / "slug" / "m1-nuke"
    _tables(live / ".tmp-1", "old")
    old = ex.publish_version(live / ".tmp-1", live, "1.5.0", _TABLE_FILES)
    _tables(live / ".tmp-2", "new")
    new = ex.publish_version(live / ".tmp-2", live, "1.5.0", _TABLE_FILES)  # old was locked when this published
    pre_v1 = dp.DEMOS_DIR / "slug" / "m2-dust2"
    pre_v1.mkdir()
    (pre_v1 / "meta.parquet").write_text("pre-v1")
    assert old.exists()
    dp.tidy_demos()
    assert sorted(x.name for x in live.iterdir()) == ["CURRENT", new.name]
    assert (pre_v1 / "meta.parquet").exists()



_PLACEHOLDER = {"Boolean": False, "Float32": 1.0, "Int8": 1, "Int16": 1, "Int32": 1, "Int64": 1, "UInt32": 1,
                "UInt64": 76561190000000001, "String": "x", "List(String)": ["x"], "List(UInt64)": [1]}


def _one_row(table, **override):
    import schema_v1
    row = {c: _PLACEHOLDER[t] for c, t in schema_v1.TYPES[table].items()}
    row.update(override)
    return pd.DataFrame([row]).astype({c: object for c in override})


@pytest.mark.parametrize("table, cols", [
    # Each was seen on a real map that passes validation, and failed it at the writer.
    ("grenade_throws", ["entity_id", "flight_s", "land_tick", "land_x", "land_y", "land_z", "link_distance",
                        "projectile"]),  # a molotov never linked to a projectile
    ("player_rounds", ["best_secondary", "best_secondary_price"]),  # a player holding no pistol
    ("kills", ["v_best_secondary", "v_best_secondary_price"]),  # a victim holding no pistol
    ("kills", ["s_since_freeze_end"]),  # a kill in a round recorded already live
    ("bomb", ["steamid", "place", "x", "y", "z"]),  # a pickup on tick 0 that names no player
    ("grenade_events", ["steamid"]),  # an inferno_expire that names no player
    ("rounds", ["winner_side", "winner_team"]),  # an aborted round (no winner, stats kept)
])
def test_the_writer_accepts_the_nulls_real_maps_carry(table, cols):
    ex._to_polars(_one_row(table, **{c: None for c in cols}), table)


def test_republishing_the_same_tables_never_reuses_a_partly_pruned_folder(tmp_path):
    # Folders were named by a hash of their tables, so republishing identical tables reused the old folder
    # even if a prune had already deleted part of it, and CURRENT then pointed at an incomplete map.
    m = tmp_path / "m1"
    _tables(m / ".tmp-1", "same")
    first = ex.publish_version(m / ".tmp-1", m, "1.6.0", _TABLE_FILES)
    _tables(m / ".tmp-2", "other")
    ex.publish_version(m / ".tmp-2", m, "1.6.0", _TABLE_FILES)
    (first / "rounds.parquet").unlink()  # a prune deleted part of it; match.parquet was locked
    _tables(m / ".tmp-3", "same")
    again = ex.publish_version(m / ".tmp-3", m, "1.6.0", _TABLE_FILES)
    assert again != first and ex.resolve_map_dir(m) == again
    assert sorted(x.name for x in again.iterdir()) == ["COMPLETE", "match.parquet", "rounds.parquet"]


def test_a_version_folder_resolves_only_with_every_file_its_completion_list_names(tmp_path):
    m = tmp_path / "m1"
    _tables(m / ".tmp-1", "x")
    v = ex.publish_version(m / ".tmp-1", m, "1.6.0", _TABLE_FILES)
    assert ex.resolve_map_dir(m) == v
    (v / "rounds.parquet").write_text("truncated")  # same name, different size
    assert ex.resolve_map_dir(m) is None
    (v / "rounds.parquet").unlink()
    assert ex.resolve_map_dir(m) is None
    (v / "COMPLETE").unlink()
    _tables(m / "v-1.6.0-0123abcd", "no list")  # a folder with tables but no completion list
    (m / "CURRENT").write_text("v-1.6.0-0123abcd\n")
    assert ex.resolve_map_dir(m) is None


def test_a_write_between_the_size_reads_cannot_hide_a_running_extraction(tmp_path, monkeypatch):
    # Usage and the running archive's hold were read separately: if 7-Zip wrote its demo after usage was
    # read but before the hold was, the bytes counted in neither and the next archive started over budget.
    # Sizes in bytes: the budget is 1000, each archive lists 600 bytes of demos.
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "MAX_OUR_GB", 1e-6)
    monkeypatch.setattr(dp, "free_gb", lambda path=None: 100.0)
    archives = []
    for name in ("a", "b"):
        rar = dp.DOWNLOADS / name
        rar.write_bytes(dp.RAR_MAGIC + bytes(10))
        archives.append(dp.Archive(rar=rar, id=name))
    started = []
    monkeypatch.setattr(dp, "list_archive", lambda rar: {"m1.dem": dict(size=600, modified=None)})
    monkeypatch.setattr(dp.subprocess, "Popen", lambda *x, **k: started.append(x))
    p = dp.Pipeline()
    first, second = sorted(archives, key=lambda a: a.rar.stat().st_mtime)
    p.archives[first.id] = first
    p.start_extractions()
    assert first.state == "extracting"
    p.archives[second.id] = second
    real, wrote = dp.tree_bytes, []

    def write_after_first_work_read(path):
        n = real(path)
        if not wrote and (Path(path) == dp.WORK_DIR or dp.WORK_DIR in Path(path).parents):
            (first.work / "m1.dem").write_bytes(b"x" * 600)  # 7-Zip finishes the demo mid-check
            wrote.append(path)
        return n

    monkeypatch.setattr(dp, "tree_bytes", write_after_first_work_read)
    p.start_extractions()
    assert wrote and len(started) == 1 and second.state == "pending"


def _rebuild_and_validate(drops, game_damage):
    """Rebuild the lost drops (nothing else in the event stream) and check them against the game's counter."""
    dmg, _ = _no_events()
    out = ex.rebuild_lost_hits(drops, dmg, LOST_SIDES)
    checks, hp = ex.hit_table_checks(out, _pr([(3, s_, g) for s_, g in game_damage.items()]))
    warn = [c for c in checks if c["check"] == "damage_events_incomplete"]
    return out, [c for c in checks if c["fatal"] and not c["ok"]], hp, warn


@pytest.mark.parametrize("drops, game_damage, lost_hp", [
    # The reviewer's swap with the fires lost too: LA does 80 and LB kills LV for 20 at tick 100, LB does 80
    # and LA kills LW for 20 at 200, and the gap holds no weapon_fire to rule either out.
    ([(100, LV, 100, 0), (200, LW, 100, 0)], {LA: 100, LB: 100}, 200),
    # Team damage folded into an enemy's lethal drop: LW (LV's teammate) burns LV for 30, LA kills him with
    # 70, one drop of 100. The game counts LA's 70; the 30 is nobody's enemy damage.
    ([(300, LV, 100, 0)], {LA: 70}, 70),
    # World damage mixed in: LV falls for 40 and LA shoots him for the last 60 on one tick.
    ([(400, LV, 100, 0)], {LA: 60}, 60),
])
def test_a_lost_drop_names_no_one_and_the_map_passes_with_the_exact_gap_as_a_warning(drops, game_damage, lost_hp):
    out, fatal, hp, warn = _rebuild_and_validate(_lost(*drops), game_damage)
    assert out.attacker_steamid.isna().all() and out.reconstructed_ambiguous.all()
    assert fatal == [] and hp == lost_hp
    assert [(w["ok"], w["fatal"], w["actual"]) for w in warn] == [(False, False, lost_hp)]
    assert warn[0]["note"].startswith(f"damage_events_incomplete: {lost_hp} HP")



def test_a_stale_map_is_skipped_by_readers_but_kept_until_a_re_extraction_replaces_it(tmp_path):
    # Maps from extractors before 1.2.0 have untrustworthy per-round damage. RETIRED makes readers skip a
    # map, but pruning deleted every RETIRED folder, so marking them would have destroyed them before any
    # re-extraction existed. A stale marker keeps the folder; retiring it once replaced still deletes it.
    m = tmp_path / "m1"
    _tables(m, "legacy")
    ex.mark_stale(m, "extractor 1.1.0: per-round damage predates the round-boundary fix")
    assert ex.resolve_map_dir(m) is None
    assert (m / "RETIRED").read_text(encoding="utf-8").startswith("stale: extractor 1.1.0")
    assert ex.prune_map(m) == [] and (m / "match.parquet").exists()
    ex.retire_map(m)  # its re-extraction landed in another folder
    assert not m.exists()


def test_a_marker_that_cannot_be_read_keeps_the_map(tmp_path, monkeypatch):
    # Any OSError reading RETIRED counted as "not stale", so an unreadable marker was pruned as replaced.
    m = tmp_path / "m1"
    _tables(m, "legacy")
    ex.mark_stale(m, "extractor 1.1.0")
    real = Path.read_text

    def locked(self, *a, **k):
        if self.name == "RETIRED":
            raise PermissionError(13, "Access is denied", str(self))
        return real(self, *a, **k)

    monkeypatch.setattr(Path, "read_text", locked)
    assert ex.prune_map(m) == [] and (m / "match.parquet").exists() and ex.resolve_map_dir(m) is None


def test_only_a_marker_reading_replaced_or_empty_lets_the_prune_delete(tmp_path):
    for text, kept in (("replaced\n", False), ("", False), ("stale: x\n", True), ("garbled \x00\n", True)):
        m = tmp_path / f"m-{len(text)}-{kept}"
        _tables(m, "x")
        (m / "RETIRED").write_text(text, encoding="utf-8")
        ex.prune_map(m)
        assert m.exists() == kept, text


def _withdrawn(tmp_path, reason):
    m = tmp_path / "m1"
    _tables(m, "old")
    if reason == "stale":
        ex.mark_stale(m, "extractor 1.1.0")
    else:
        (m / "RETIRED").write_text("replaced\n", encoding="utf-8")  # retired, its delete not yet done
    return m


@pytest.mark.parametrize("reason", ["stale", "replaced"])
def test_a_failed_publish_into_a_withdrawn_folder_leaves_its_old_tables_withdrawn(tmp_path, monkeypatch, reason):
    # Extraction removed RETIRED before writing, so a failed write left the old, withdrawn tables resolvable.
    m = _withdrawn(tmp_path, reason)

    def fail(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(ex, "publish_version", fail)
    with pytest.raises(OSError):
        ex.write_output({"match": _one_row("match")}, m, dict(rows={}, bytes={}))
    assert (m / "RETIRED").exists() and ex.resolve_map_dir(m) is None
    assert not any(x.name.startswith(".tmp-") for x in m.iterdir())


@pytest.mark.parametrize("reason", ["stale", "replaced"])
def test_a_publish_into_a_withdrawn_folder_makes_it_live_only_once_published(tmp_path, reason):
    m = _withdrawn(tmp_path, reason)
    result = dict(rows={}, bytes={})
    ex.write_output({"match": _one_row("match")}, m, result)
    assert not (m / "RETIRED").exists() and ex.resolve_map_dir(m) == m / result["version_dir"]
    assert sorted(x.name for x in m.iterdir()) == ["CURRENT", result["version_dir"]]  # old tables pruned


# --- Publish protocol fixes from the formal audit (formal/AUDIT.md; schedules replayed by formal/reproduce.py)
AUDIT_TABLES = ("match", "player_rounds", "damages")


def _write_map(m, **match):
    """Publish a small real map into m through the production writer."""
    result = dict(rows={}, bytes={})
    ex.write_output({t: _one_row(t, **(match if t == "match" else {})) for t in AUDIT_TABLES}, m, result)
    return m / result["version_dir"]


def test_an_in_place_re_extraction_never_retires_the_map_it_just_wrote(tmp_path, monkeypatch):
    # The pipeline names a job's folder from the file stem (plus _dup), but rebuilt the archive's new folders
    # from the worker's result["map"], which a name without "-vs-" takes from the demo header instead. The
    # folder just written was then missing from new_dirs, and its needs_reextract row retired it.
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "NEEDS_REEXTRACT", dp.DEMOS_DIR / "needs_reextract.jsonl")
    slug = "lan-final-0123abcd"
    out = dp.DEMOS_DIR / slug / "lan-final-map1"
    written = _write_map(out)
    work = dp.WORK_DIR / slug
    work.mkdir(parents=True)
    dem = work / "lan-final-map1.dem"
    dem.write_bytes(b"x")
    (dp.DOWNLOADS / "h").mkdir()
    rar = dp.DOWNLOADS / "h" / "0123abcd-0000"
    rar.write_bytes(dp.RAR_MAGIC)
    dp.NEEDS_REEXTRACT.write_text(json.dumps(dict(dem_file=dem.name, dem_bytes=1,
                                                  out_dir=str(out.relative_to(tmp_path)))) + "\n")
    a = dp.Archive(rar=rar, id="0123abcd-0000", state="parsing", slug=slug, work=work, dems=[dem])
    a.results = {dem.name: dict(ok=True, dem_file=dem.name, dem_bytes=1, map="de_nuke", version_dir=written.name)}
    a.out_dirs = {dem.name: out}
    p = dp.Pipeline()
    p.archives[a.id] = a
    p.finish_archives()
    assert ex.resolve_map_dir(out) is not None and not (out / "RETIRED").exists()
    assert dp.NEEDS_REEXTRACT.read_text() == ""  # the row is satisfied by the map written in place











def test_complete_lists_every_table_written_and_a_missing_one_fails_the_publish(tmp_path, monkeypatch):
    # COMPLETE listed whatever .parquet files were left in the staging folder, not the tables written.
    m = tmp_path / "m1"
    real_schema = ex.pl.read_parquet_schema

    def lose_damages(path):
        if path.name == "match.parquet":
            (path.parent / "damages.parquet").unlink(missing_ok=True)
        return real_schema(path)

    monkeypatch.setattr(ex.pl, "read_parquet_schema", lose_damages)
    with pytest.raises(Exception):
        _write_map(m)
    assert ex.resolve_map_dir(m) is None


def test_a_map_is_retired_only_while_its_successor_resolves(tmp_path):
    old, new = tmp_path / "a" / "m1", tmp_path / "b" / "m1"
    _write_map(old)
    with pytest.raises(ex.SuccessorMissing):
        ex.retire_map(old, successor=new)
    assert ex.resolve_map_dir(old) is not None and not (old / "RETIRED").exists()
    _write_map(new)
    assert ex.retire_map(old, successor=new) == [] and not old.exists() and ex.resolve_map_dir(new) is not None


def test_a_re_extraction_whose_map_is_gone_keeps_the_old_map_and_its_row(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "NEEDS_REEXTRACT", dp.DEMOS_DIR / "needs_reextract.jsonl")
    old, new = dp.DEMOS_DIR / "old-slug" / "m1-nuke", dp.DEMOS_DIR / "new-slug" / "m1-nuke"
    _write_map(old)
    row = dict(dem_file="a-vs-b-m1-nuke.dem", dem_bytes=100, out_dir=str(old.relative_to(tmp_path)))
    dp.NEEDS_REEXTRACT.write_text(json.dumps(row) + "\n")
    dp.replace_old_extractions({"a-vs-b-m1-nuke.dem": dict(ok=True, dem_file=row["dem_file"], dem_bytes=100)},
                               {"a-vs-b-m1-nuke.dem": new})  # reported ok, but nothing resolves there now
    assert ex.resolve_map_dir(old) is not None
    assert [json.loads(x) for x in dp.NEEDS_REEXTRACT.read_text().splitlines()] == [row]


def test_two_archives_sharing_an_id_prefix_get_different_folders(tmp_path, monkeypatch):
    names = ["team-a-vs-team-b-m1-nuke.dem"]
    one, two = "f3a92631-1281-45b5-80bb-48725dbb136b", "f3a92631-9999-45b5-80bb-48725dbb136b"
    assert dp.slug_for(names, one) != dp.slug_for(names, two)
    # A folder already named by the old 8-character form keeps serving the archive that owns it.
    _isolate(tmp_path, monkeypatch)
    _write_map(dp.DEMOS_DIR / "team-a-vs-team-b-f3a92631" / "m1-nuke", archive=one)
    p = dp.Pipeline()
    a, b = dp.Archive(rar=tmp_path / "r1", id=one), dp.Archive(rar=tmp_path / "r2", id=two)
    a.listing = b.listing = {names[0]: dict(size=1, modified=None)}
    assert p.slug_of(a) == "team-a-vs-team-b-f3a92631" and p.slug_of(b) == dp.slug_for(names, two)


def test_a_crash_while_rewriting_needs_reextract_keeps_every_row(tmp_path, monkeypatch):
    # The rewrite truncated the file in place; a crash before the retained rows were written lost them.
    import builtins
    import io
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "NEEDS_REEXTRACT", dp.DEMOS_DIR / "needs_reextract.jsonl")
    done, other = dp.DEMOS_DIR / "s1" / "m1", dp.DEMOS_DIR / "s2" / "m2"
    _write_map(done)
    rows = [dict(dem_file="a.dem", dem_bytes=1, out_dir=str((dp.DEMOS_DIR / "old" / "m1").relative_to(tmp_path))),
            dict(dem_file="b.dem", dem_bytes=2, out_dir=str(other.relative_to(tmp_path)))]
    dp.NEEDS_REEXTRACT.write_text("".join(json.dumps(r) + "\n" for r in rows))
    real_open = io.open

    class Crash:
        def __init__(self, f):
            self.f = f

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self.f.close()

        def write(self, *_):
            raise OSError("power cut")

        def __getattr__(self, name):
            return getattr(self.f, name)

    def crashing(file, mode="r", *a, **k):
        f = real_open(file, mode, *a, **k)
        if "w" in mode and Path(file).parent == dp.DEMOS_DIR:
            return Crash(f)
        return f

    with monkeypatch.context() as mp, pytest.raises(OSError):
        mp.setattr(io, "open", crashing)
        mp.setattr(builtins, "open", crashing)
        dp.replace_old_extractions({"a.dem": dict(ok=True, dem_file="a.dem", dem_bytes=1)}, {"a.dem": done})
    assert [json.loads(x) for x in dp.NEEDS_REEXTRACT.read_text().splitlines()] == rows


def test_a_refeed_of_a_finished_archive_is_extracted_when_needs_reextract_asks(tmp_path, monkeypatch):
    # A finished ledger id was skipped forever, so a refeed under the same id never re-extracted.
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "NEEDS_REEXTRACT", dp.DEMOS_DIR / "needs_reextract.jsonl")
    aid = "4f4ef05b-d8e4-44a5-8d7a-2b16f4d105ad"
    dp.LEDGER.write_text(json.dumps(dict(id=aid, status="done", slug="team-a-vs-team-b-4f4ef05b")) + "\n")
    (dp.DOWNLOADS / "h").mkdir()
    (dp.DOWNLOADS / "h" / aid).write_bytes(dp.RAR_MAGIC + bytes(10))
    p = dp.Pipeline()
    p.scan(0.0)
    p.scan(100.0)
    assert aid not in p.archives  # nothing asks for it: still skipped
    dp.NEEDS_REEXTRACT.write_text(json.dumps(dict(archive_slug="team-a-vs-team-b-4f4ef05b", dem_file="x.dem",
                                                  dem_bytes=1, out_dir="demos/team-a-vs-team-b-4f4ef05b/m1")) + "\n")
    p.scan(200.0)
    p.scan(300.0)
    assert aid in p.archives



def test_the_startup_tidy_skips_a_map_another_process_holds(tmp_path, monkeypatch):
    # An orphan worker or a standalone extractor can still be writing a map when the pipeline starts.
    _isolate(tmp_path, monkeypatch)
    m = dp.DEMOS_DIR / "slug" / "m1"
    _write_map(m)
    orphan = m / "v-1.10.0-0000beef"  # what a prune would delete
    orphan.mkdir()
    done = threading.Event()
    with ex.map_lock(m):
        t = threading.Thread(target=lambda: (dp.tidy_demos(), done.set()))
        t.start()
        assert done.wait(5)  # it did not wait for the holder
        assert orphan.exists()
    dp.tidy_demos()
    assert not orphan.exists() and ex.resolve_map_dir(m) is not None


def _signal_lock_attempts(monkeypatch, events):
    """Set events[thread] when that thread starts trying to take a map lock (it then waits if it is held)."""
    real = ex.map_lock._acquire

    def acquire(self, f, path):
        if threading.current_thread() in events:
            events[threading.current_thread()].set()
        return real(self, f, path)

    monkeypatch.setattr(ex.map_lock, "_acquire", acquire)


def _run(target, errors):
    def body():
        try:
            target()
        except BaseException as e:  # noqa: BLE001 - asserted empty by the test
            errors.append(e)
    return threading.Thread(target=body)


def test_a_prune_cannot_delete_a_version_published_while_it_runs(tmp_path, monkeypatch):
    # Audit schedule 1: the pruner read CURRENT (V0), a writer published V1, and the pruner then deleted V1
    # as "not current", leaving CURRENT dangling. The pruner pauses right after reading CURRENT until the
    # writer has either published (no lock) or started waiting for the map's lock.
    m = tmp_path / "m1"
    _write_map(m)
    real_resolve, real_publish = ex.resolve_map_dir, ex.publish_version
    cached, writer_moved, errors = threading.Event(), threading.Event(), []
    pruner = _run(lambda: ex.prune_map(m), errors)
    writer = _run(lambda: _write_map(m), errors)

    def resolve(path):
        found = real_resolve(path)
        if threading.current_thread() is pruner and not cached.is_set():
            cached.set()
            assert writer_moved.wait(10), "the writer neither published nor waited for the lock"
        return found

    def publish(*a, **k):
        out = real_publish(*a, **k)
        if threading.current_thread() is writer:
            writer_moved.set()
        return out

    monkeypatch.setattr(ex, "resolve_map_dir", resolve)
    monkeypatch.setattr(ex, "publish_version", publish)
    _signal_lock_attempts(monkeypatch, {writer: writer_moved})
    pruner.start()
    assert cached.wait(10)
    writer.start()
    pruner.join(20)
    writer.join(20)
    assert not pruner.is_alive() and not writer.is_alive() and not errors, errors
    assert real_resolve(m) is not None


def test_a_retirement_racing_a_writer_leaves_the_map_withdrawn(tmp_path, monkeypatch):
    # Audit schedule 2: the writer replaced CURRENT, a retirement wrote "replaced" and paused, the writer
    # removed RETIRED, and the retirement's prune then kept the map: a withdrawn version resolved again.
    # The writer pauses after publishing until the retirement has written its marker (no lock) or started
    # waiting for the lock; the retirement prunes only after the writer has finished.
    m = tmp_path / "m1"
    _write_map(m)
    real_marker, real_publish = ex._write_marker, ex.publish_version
    retirer_moved, writer_done, errors = threading.Event(), threading.Event(), []
    retirer = _run(lambda: ex.retire_map(m), errors)

    def marker(path, text):
        real_marker(path, text)
        if threading.current_thread() is retirer:
            retirer_moved.set()
            assert writer_done.wait(10), "the writer never finished"

    def publish(*a, **k):
        out = real_publish(*a, **k)
        if threading.current_thread() is threading.main_thread() and not retirer.is_alive():
            retirer.start()
            assert retirer_moved.wait(10), "the retirement neither marked the map nor waited for the lock"
        return out

    monkeypatch.setattr(ex, "_write_marker", marker)
    monkeypatch.setattr(ex, "publish_version", publish)
    _signal_lock_attempts(monkeypatch, {retirer: retirer_moved})
    _write_map(m)
    writer_done.set()
    retirer.join(20)
    assert not retirer.is_alive() and not errors, errors
    assert ex.resolve_map_dir(m) is None


def test_a_prune_never_touches_the_staging_folder_of_a_running_writer(tmp_path, monkeypatch):
    # Audit schedule 3: a prune deleted a running writer's .tmp-<pid> folder (in the audit, part of it), and
    # the writer published what survived. The writer pauses after its first table until the prune has
    # finished (no lock) or started waiting for the lock.
    m = tmp_path / "m1"
    _write_map(m)
    real_schema, pruner_moved, errors = ex.pl.read_parquet_schema, threading.Event(), []

    def prune():
        try:
            ex.prune_map(m)
        finally:
            pruner_moved.set()

    pruner = _run(prune, errors)

    def schema(path):
        if threading.current_thread() is threading.main_thread() and not pruner.is_alive() and not pruner_moved.is_set():
            pruner.start()
            assert pruner_moved.wait(10), "the prune neither ran nor waited for the lock"
        return real_schema(path)

    monkeypatch.setattr(ex.pl, "read_parquet_schema", schema)
    _signal_lock_attempts(monkeypatch, {pruner: pruner_moved})
    new = _write_map(m)
    pruner.join(20)
    assert not pruner.is_alive() and not errors, errors
    assert ex.resolve_map_dir(m) == new
    assert sorted(json.loads((new / "COMPLETE").read_text())) == [f"{t}.parquet" for t in sorted(AUDIT_TABLES)]


def test_an_in_place_re_extraction_withdrawn_again_keeps_its_row(tmp_path, monkeypatch):
    # The reviewer's case: the job publishes, then the map is marked stale, then the archive finishes. The
    # row was dropped because its folder was the job's own, though readers now skip the map.
    _isolate(tmp_path, monkeypatch)
    monkeypatch.setattr(dp, "NEEDS_REEXTRACT", dp.DEMOS_DIR / "needs_reextract.jsonl")
    m = dp.DEMOS_DIR / "slug" / "m1-nuke"
    written = _write_map(m)
    ex.mark_stale(m, "extractor 1.1.0")
    row = dict(dem_file="a.dem", dem_bytes=1, out_dir=str(m.relative_to(tmp_path)))
    dp.NEEDS_REEXTRACT.write_text(json.dumps(row) + "\n")
    dp.replace_old_extractions({"a.dem": dict(ok=True, dem_file="a.dem", dem_bytes=1, version_dir=written.name)},
                               {"a.dem": m})
    assert [json.loads(x) for x in dp.NEEDS_REEXTRACT.read_text().splitlines()] == [row]


def test_a_writer_survives_a_retirement_that_deletes_its_map_folder_first(tmp_path, monkeypatch):
    # write_output created the map folder before taking its lock, so a retirement holding the lock could
    # delete the folder in between, and the writer then failed creating .tmp-<pid> inside it. The writer
    # arrives while the retirement holds the lock; the retirement goes on only once the writer waits.
    m = tmp_path / "slug" / "m1"
    _write_map(m)
    real_marker, writer_waiting, errors = ex._write_marker, threading.Event(), []
    writer = _run(lambda: _write_map(m), errors)
    holding = threading.Event()

    def marker(path, text):
        real_marker(path, text)
        if threading.current_thread() is not writer:
            holding.set()
            assert writer_waiting.wait(10), "the writer never reached the lock"

    monkeypatch.setattr(ex, "_write_marker", marker)
    _signal_lock_attempts(monkeypatch, {writer: writer_waiting})
    retirer = _run(lambda: ex.retire_map(m), errors)
    retirer.start()
    assert holding.wait(10)
    writer.start()
    retirer.join(20)
    writer.join(20)
    assert not retirer.is_alive() and not writer.is_alive() and not errors, errors
    assert ex.resolve_map_dir(m) is not None



def test_a_kill_whose_event_lacks_the_killfeed_modifiers_writes_null_not_a_failed_map():
    # attackerblind / attackerinair were copied with col(), which fills NaN for a field the event lacks,
    # into columns declared non-null: the writer then rejected the whole map. They are now null there.
    without = pd.DataFrame(dict(tick=[100, 200]))
    flags = ex.kill_modifiers(without)
    assert {c: s.isna().tolist() for c, s in flags.items()} == {"attackerblind": [True, True],
                                                               "attackerinair": [True, True]}
    ex._to_polars(_one_row("kills", attackerblind=None, attackerinair=None), "kills")
    # When the event has them, they come through as recorded.
    with_flags = pd.DataFrame(dict(tick=[100, 200], attackerblind=[True, False], attackerinair=[False, True]))
    flags = ex.kill_modifiers(with_flags)
    assert flags["attackerblind"].tolist() == [True, False] and flags["attackerinair"].tolist() == [False, True]
