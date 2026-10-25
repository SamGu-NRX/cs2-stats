import json
import sys
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

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
    dmg = _damages([(A, 100, False), (C, 100, False), (B, 100, False), (B, 30, True)])
    sb = _sb([(A, 1, 1, 0, 100, 1), (B, 1, 0, 1, 100, 0), (C, 1, 1, 0, 100, 0), (D, 0, 1, 0, 0, 0)])
    return kills, dmg, sb


def _fatal_failures(checks):
    return [c for c in checks if c["fatal"] and not c["ok"]]


def test_scoreboard_validation_passes_and_excludes_team_damage():
    assert _fatal_failures(ex.validate_scoreboard(*_base())) == []


def test_scoreboard_kill_mismatch_fails():
    kills, dmg, sb = _base()
    sb.loc[sb.steamid == A, "kills_total"] = 2
    bad = _fatal_failures(ex.validate_scoreboard(kills, dmg, sb))
    assert [(c["check"], c["steamid"]) for c in bad] == [("kills", A)]


def test_scoreboard_damage_uses_capped_hp():
    kills, dmg, sb = _base()
    dmg.loc[0, "dmg_health_capped"] = 99
    bad = _fatal_failures(ex.validate_scoreboard(kills, dmg, sb))
    assert [(c["check"], c["steamid"]) for c in bad] == [("damage", A)]


def test_assists_include_flash_assists():
    kills, dmg, sb = _base()
    sb.loc[sb.steamid == B, "assists_total"] = 0
    assert [c["check"] for c in _fatal_failures(ex.validate_scoreboard(kills, dmg, sb))] == ["assists"]


def test_teamkill_and_suicide_may_be_deducted():
    kills = _kills([(A, C, None, False, False, False), (A, B, None, False, True, False),
                    (D, D, None, False, False, True)])
    dmg = _damages([])
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
    assert dp.slug_for(["team-a-vs-team-b-m1-nuke.dem"], "f3a92631-1281") == "team-a-vs-team-b-f3a92631"
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
    assert _fatal_failures(ex.validate_scoreboard(kills, _damages([]), sb)) == []


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


# --- disk budget ------------------------------------------------------------

def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(dp, "DATA_ROOT", tmp_path)
    for name in ("DEMOS_DIR", "WORK_DIR", "FAILED_DIR", "DOWNLOADS"):
        d = tmp_path / name.lower()
        d.mkdir()
        monkeypatch.setattr(dp, name, d)
    monkeypatch.setattr(dp, "LEDGER", dp.DEMOS_DIR / "archives.jsonl")
    monkeypatch.setattr(dp, "DROPPED", dp.DEMOS_DIR / "failed_dropped.jsonl")




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
    dp.replace_old_extractions({"x": dict(ok=True, dem_file="a-vs-b-m1-nuke.dem", dem_bytes=100),
                                "y": dict(ok=True, dem_file="a-vs-b-m2-dust2.dem", dem_bytes=999)},
                               {(dp.DEMOS_DIR / "new-slug" / "m1-nuke").resolve()})
    assert not old.exists() and other.exists()
    assert [json.loads(x)["dem_file"] for x in dp.NEEDS_REEXTRACT.read_text().splitlines()] == ["a-vs-b-m2-dust2.dem"]


def _pr(rows):
    df = pd.DataFrame(rows, columns=["round", "steamid", "game_damage"])
    return df.astype({"steamid": "UInt64"})


def test_hits_the_demo_lost_are_rebuilt_from_health_with_an_exact_attacker():
    # A pro demo, round 2: ticks 9168-9184 carry no player_hurt or weapon_fire, yet a CT (V1) drops 48 -> 0
    # at 9173 (killed by T1) and T1 drops 100 -> 45 at 9182. The game credits T1 279 (hits 231 + 48) and a
    # CT (C1) 140 (hits 85 + 55). On another demo, a world suicide from 74 HP (S) is self damage.
    T1, V1, C1, S1 = 76561190000000011, 76561190000000012, 76561190000000013, 76561190000000014
    side = {(2, T1): "T", (2, V1): "CT", (2, C1): "CT", (2, S1): "CT"}
    dmg = ex.pd.DataFrame(dict(tick=[8802, 9196], round=[2, 2], attacker_steamid=[T1, C1],
                               victim_steamid=[C1, T1], dmg_health_capped=[231, 85],
                               is_team_damage=[False, False])).astype({"attacker_steamid": "UInt64",
                                                                       "victim_steamid": "UInt64"})
    kills = ex.pd.DataFrame(dict(tick=[9173, 9500], attacker_steamid=[T1, S1], victim_steamid=[V1, S1],
                                 weapon=["galilar", "world"], hitgroup=["head", "generic"])).astype(
        {"attacker_steamid": "UInt64", "victim_steamid": "UInt64"})
    drops = ex.pd.DataFrame(dict(tick=[9173, 9182, 9500], steamid=[V1, T1, S1], health_before=[48, 100, 74],
                                 health_after=[0, 45, 0], round=[2, 2, 2]))
    out = ex.rebuild_lost_hits(drops, dmg, kills, _pr([(2, T1, 279), (2, C1, 140)]), side)
    out["weapon"] = out.weapon.astype(object).where(out.weapon.notna(), None)
    assert out[["tick", "attacker_steamid", "dmg_health_capped", "weapon", "is_team_damage", "is_self", "source"]]         .values.tolist() == [[9173, T1, 48, "galilar", False, False, "health"],
                             [9182, C1, 55, None, False, False, "health"],
                             [9500, S1, 74, "world", True, True, "health"]]


def test_a_lost_hit_goes_only_to_the_one_enemy_whose_residual_equals_it():
    side = {(1, A): "CT", (1, B): "CT", (1, C): "T"}
    drops = ex.pd.DataFrame(dict(tick=[100], steamid=[C], health_before=[100], health_after=[70], round=[1]))
    no_dmg = ex.pd.DataFrame(dict(tick=[], round=[], attacker_steamid=[], victim_steamid=[], dmg_health_capped=[],
                                  is_team_damage=[])).astype({"attacker_steamid": "UInt64", "victim_steamid": "UInt64",
                                                               "is_team_damage": bool})
    no_kills = ex.pd.DataFrame(dict(tick=[], attacker_steamid=[], victim_steamid=[], weapon=[], hitgroup=[])).astype(
        {"attacker_steamid": "UInt64", "victim_steamid": "UInt64"})
    # Only an enemy whose unexplained game damage equals the drop exactly is credited...
    out = ex.rebuild_lost_hits(drops, no_dmg, no_kills, _pr([(1, A, 30), (1, B, 31)]), side)
    assert out.attacker_steamid.tolist() == [A]
    # ...and with two such enemies nobody is.
    out = ex.rebuild_lost_hits(drops, no_dmg, no_kills, _pr([(1, A, 30), (1, B, 30)]), side)
    assert out.attacker_steamid.isna().tolist() == [True]


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
    same.mkdir(parents=True)
    (same / "match.parquet").write_bytes(b"x")
    dp.NEEDS_REEXTRACT.write_text(json.dumps(dict(dem_file="a.dem", dem_bytes=1, out_dir=str(same.relative_to(tmp_path))))
                                  + "\n")
    dp.replace_old_extractions({"x": dict(ok=True, dem_file="a.dem", dem_bytes=1)}, {same.resolve()})
    assert same.exists() and dp.NEEDS_REEXTRACT.read_text() == ""


def test_workers_run_a_frozen_copy_of_the_extractor(tmp_path, monkeypatch):
    # Edits to the repo while the pipeline ran reached live workers and failed 13 maps.
    monkeypatch.setattr(dp, "RUN_CODE", tmp_path / "run")
    dp.freeze_code()
    assert sorted(p.name for p in (tmp_path / "run").iterdir()) == sorted(dp.CODE_FILES)
    for name in dp.CODE_FILES:
        assert (tmp_path / "run" / name).read_bytes() == (dp.ROOT / name).read_bytes()



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



def test_several_lost_hits_go_to_the_one_enemy_whose_residual_is_their_sum():
    # A pro demo, round 2: seven lost burn ticks (1, 3, 3, 4, 5, 6, 6 = 28 HP) on one CT; the
    # only T with unexplained game damage has exactly 28 (36 counted, 8 recorded).
    side = {(2, A): "CT", (2, C): "T", (2, D): "T"}
    burns = [1, 3, 3, 4, 5, 6, 6]
    hp = list(np.cumsum([0] + burns))
    drops = ex.pd.DataFrame(dict(tick=[13753 + 13 * i for i in range(7)], steamid=A, health_before=[100 - h for h in hp[:-1]],
                                 health_after=[100 - h for h in hp[1:]], round=2))
    dmg = ex.pd.DataFrame(dict(tick=[13000], round=[2], attacker_steamid=[C], victim_steamid=[A], dmg_health_capped=[8],
                               is_team_damage=[False])).astype({"attacker_steamid": "UInt64", "victim_steamid": "UInt64"})
    no_kills = ex.pd.DataFrame(dict(tick=[], attacker_steamid=[], victim_steamid=[], weapon=[], hitgroup=[])).astype(
        {"attacker_steamid": "UInt64", "victim_steamid": "UInt64"})
    out = ex.rebuild_lost_hits(drops, dmg, no_kills, _pr([(2, C, 36), (2, D, 0)]), side)
    assert out.attacker_steamid.tolist() == [C] * 7 and int(out.dmg_health_capped.sum()) == 28
    # If the sum does not match exactly, nobody is credited.
    out = ex.rebuild_lost_hits(drops, dmg, no_kills, _pr([(2, C, 37), (2, D, 0)]), side)
    assert out.attacker_steamid.isna().all()



def test_a_winnerless_attempt_is_voided_only_if_the_game_rolled_its_stats_back():
    # A pro demo: kills plus deaths stay put across the 45420-57646 restore (rolled back), but a
    # world suicide inside 78153-97787 raised deaths_total and stayed counted (the game kept that attempt).
    totals = {45420: 120, 57646 + 64: 120, 78153: 131, 97787 + 64: 132}
    assert ex.split_restores([(45420, 57646), (78153, 97787)], totals) == ([(45420, 57646)], [(78153, 97787)])



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
