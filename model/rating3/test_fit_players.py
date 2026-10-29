"""The fits read a joined map's players through the join's pairing, on synthetic maps: no real player, demo or HLTV
page."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

import postplant_analysis
import swing_fit

# One round: ana (in game "ana_2026", renamed since HLTV saved her as "ana") plants, then kills bob with an AK-47.
ANA, BOB = 11, 22
JOIN = {"demo": "demos/a-vs-b/m1-nuke", "hltv": "map_1.json",
        "players": {str(ANA): {"hltv": "ana", "pid": "1", "renamed": True},
                    str(BOB): {"hltv": "bob", "pid": "2", "renamed": False}}}


def _row(player: str, pid: str) -> dict:
    return {"player": player, "pid": pid, "cells": [["st-kills eco-adjusted-data", "1 (1)"],
                                                    ["st-deaths eco-adjusted-data", "0 (0)"],
                                                    ["st-adr eco-adjusted-data", "100.0"],
                                                    ["st-kast eco-adjusted-data", "50.0%"], ["st-rating", "1.10"]]}


def _map(root: Path) -> None:
    d = root / "demos" / "a-vs-b" / "m1-nuke"
    d.mkdir(parents=True)
    pq.write_table(pa.table({"round": [1, 1], "steamid": [ANA, BOB], "name": ["ana_2026", "bob"], "side": ["T", "CT"],
                             "armor": [100, 100], "defuser": [False, True]}), d / "player_rounds.parquet")
    pq.write_table(pa.table({"tick_rate": [64.0], "extra": ["{}"]}), d / "match.parquet")
    pq.write_table(pa.table({"round": [1], "tick": [500], "attacker_steamid": [ANA], "victim_steamid": [BOB],
                             "a_side": ["T"], "v_side": ["CT"], "is_suicide": [False], "is_teamkill": [False],
                             "a_active_weapon": ["weapon_ak47"], "v_active_weapon": ["weapon_m4a1"]}),
                   d / "kills.parquet")
    pq.write_table(pa.table({"round": [1], "tick": [450], "victim_steamid": [BOB], "attacker_steamid": [ANA],
                             "is_team_damage": [False], "is_self": [False], "source": ["event"],
                             "dmg_health_capped": [100], "weapon": ["weapon_ak47"], "a_side": ["T"]}),
                   d / "damages.parquet")
    pq.write_table(pa.table({"round": [9], "tick": [0], "victim_steamid": [BOB], "attacker_steamid": [ANA],
                             "duration": [0.0], "is_team_flash": [False]}), d / "blinds.parquet")
    pq.write_table(pa.table({"round": [1], "winner_side": ["T"], "end_tick": [900], "plant_tick": [300],
                             "explode_tick": [2860], "reason": ["t_killed"]}), d / "rounds.parquet")
    (root / "hltv").mkdir()
    boards = [{"cls": cls, "rows": [_row(p, pid)]} for cls in ("totalstats", "ctstats", "tstats")
              for p, pid in (("ana", "1"), ("bob", "2"))]
    (root / "hltv" / "map_1.json").write_text(json.dumps({
        "match": {"matchId": "5"}, "scoreboards": boards,
        "performance": {
            "players": [{"nick": n, "events": {"round1": [[0, ""], [0, "ana | +12.0%"]]}, "perRound": [["1", "0.5"]]}
                        for n in ("ana", "bob")],
            "rounds": {"round1": {"side": "t-side", "events": [
                {"icon": "bombplant.svg", "title": "ana planted the bomb", "y": "50", "alive": "5v5"},
                {"icon": "kill.svg", "title": "ana killed bob", "y": "62", "alive": "5v4"}]}}},
    }), encoding="utf-8")


def _dump(root: Path):
    """A writer of rating-dump files (app: pnpm rating-dump) into <root>/model-rating3."""
    folder = root / "model-rating3"
    folder.mkdir()
    return lambda name, rows: (folder / name).write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


def _dumped_join(**changes) -> dict:
    """The dump's record of the join and tables layout map_1.json's rows came from (rating-rows.ts joinRow)."""
    return {"hltv": "map_1.json", "demo": JOIN["demo"], "players": JOIN["players"], "layout": "schema_v1", **changes}


def _eco_fit(test: unittest.TestCase):
    try:
        import eco_fit
    except ImportError as error:
        test.skipTest(f"{error}; pip install -r model/rating3/requirements.txt")
    return eco_fit


def _round(pid: str, ri: int, side: str, won: bool = False, rated: bool = True, **m) -> dict:
    """A rating-dump player-round row (rating-dump.ts): m holds the measures it sets, as the dump omits zeros."""
    return {"hltv": "map_1.json", "pid": pid, "ri": ri, "side": side, "won": won,
            "m": {"rounds": 1, **({"ratedRounds": 1, "ecoRounds": 1} if rated else {}), **m}}


def _kill(**k) -> dict:
    """A rating-dump kill row (rating-rows.ts killRows): ana (HLTV player 1, T) kills bob (2) in round 0."""
    return {"hltv": "map_1.json", "ri": 0, "enemy": True, "killer": "1", "victim": "2", "assister": None,
            "flashAssist": False, "traded": False, "killerSide": "T", "aGroup": "sniper", "vGroup": "rifle1", **k}


def _hit(**h) -> dict:
    """A rating-dump hit row (rating-rows.ts hitRows): ana's 100 damage to bob in round 0."""
    return {"hltv": "map_1.json", "ri": 0, "attacker": "1", "victim": "2", "aSide": "T", "dmg": 100,
            "aGroup": "sniper", "vGroup": "rifle1", **h}


def _two_players(root: Path, **join) -> None:
    """map_1.json's dump: two rated rounds of ana (T) and bob (CT). In round 0 ana's AWP kill on bob's rifle and her
    hit count; a team kill and another map's kill do not. Round 1 holds a kill and a hit with an unknown group, so
    the app leaves round 1 out for both players."""
    _map(root)
    write = _dump(root)
    write("rating-joins.private.jsonl", [_dumped_join(**join), {**_dumped_join(), "hltv": "map_9.json"}])
    write("rating-rounds.private.jsonl", [_round("1", 0, "T", won=True, survived=1), _round("2", 0, "CT", deaths=1),
                                          _round("1", 1, "T"), _round("2", 1, "CT", deaths=1)])
    write("rating-kills.private.jsonl", [_kill(), _kill(enemy=False), _kill(hltv="map_9.json"), _kill(ri=1, aGroup=None)])
    write("rating-hits.private.jsonl", [_hit(), _hit(ri=1, vGroup=None, dmg=40)])


def _cells(ek: int, ed: int, adr: float, kast: float) -> list:
    return [["st-kills eco-adjusted-data", f"{ek} ({ek})"], ["st-deaths eco-adjusted-data", f"{ed} (0)"],
            ["st-adr eco-adjusted-data", f"{adr}"], ["st-kast eco-adjusted-data", f"{kast}%"]]


class FitsUseTheJoinsPairing(unittest.TestCase):
    def test_swing_events_name_a_renamed_player_by_her_steamid(self):
        # Review of PR 70: swing_fit paired HLTV's names with the in-game ones, so a renamed player (198 on the 567
        # joined maps) failed with a KeyError, or with a name collision would credit another player.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _map(root)
            events = list(swing_fit.joined_events(root, [JOIN]))
            with self.assertRaisesRegex(KeyError, "records no player pairing"):
                list(swing_fit.joined_events(root, [{k: v for k, v in JOIN.items() if k != "players"}]))
        self.assertEqual([(e["kill"]["attacker_steamid"], e["kill"]["victim_steamid"], e["player_ids"])
                          for e in events if e["kill"]], [(ANA, BOB, [ANA, BOB])])

    def test_duel_events_include_a_renamed_players_kills(self):
        # Review of PR 70: demo_round_fit matched kills to HLTV's scoreboard by in-game name, so a renamed player's
        # kills and deaths were dropped from the duel fit without a word.
        try:
            import demo_round_fit
        except ImportError as error:
            self.skipTest(f"{error}; pip install -r model/rating3/requirements.txt")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _map(root)
            events, _ = demo_round_fit.build_duel_events(root, [JOIN])
        self.assertEqual([(e["attacker"], e["victim"], e["attacker_group"]) for e in events], [("ana", "bob", "rifle1")])

    def test_eco_fit_trains_on_the_groups_the_app_valued_each_duel_with(self):
        # Review of PR 80: eco_fit worked out its own weapon groups (active weapon, round-start loadout), unlike the
        # app (best primary held at the kill, else equipment value), and the duel block it fitted made the app's rating
        # worse. It now reads the groups the rating dump wrote, keyed by HLTV player id (the join's pairing), and
        # leaves out a duel whose groups the app did not know.
        eco_fit = _eco_fit(self)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _two_players(root)
            d, provenance = eco_fit.collect(root, [JOIN])
        points = np.arange(1, eco_fit.CELLS + 1) / 10
        kill = points[eco_fit.cell("sniper", "rifle1", "T")]
        ours = eco_fit.eco_inputs(d, points)
        np.testing.assert_allclose([ours["ekpr"], ours["edpr"], ours["eadr"]], [[kill, 0], [0, kill], [100 * kill, 0]])
        self.assertEqual({k: v.tolist() for k, v in d.targets.items()},
                         {"ekpr": [0.5, 0.5], "edpr": [0.0, 0.0], "eadr": [100.0, 100.0], "ekast": [50.0, 50.0]})
        self.assertEqual((d.duels, provenance["consumed_joins"], provenance["unknown_group_rounds"]), (1, 1, 2))

    def test_eco_fit_leaves_out_a_round_with_an_unknown_group_as_the_app_does(self):
        # Review of PR 84: eco_fit skipped a kill or hit whose group was unknown but kept its player-round in the
        # inputs and their rounds, where rating3.ts ecoAdjust leaves the whole player-round out of every eco input.
        # Fails if such a round stays in a numerator or a denominator, or if a flash assist leaves a round out.
        eco_fit = _eco_fit(self)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _map(root)
            write = _dump(root)
            write("rating-joins.private.jsonl", [_dumped_join()])
            write("rating-rounds.private.jsonl", [_round("1", ri, "T") for ri in range(4)])
            write("rating-kills.private.jsonl", [
                _kill(ri=0),                                                          # counts
                _kill(ri=1, killer=None, assister="1", aGroup=None),                  # her assist: round 1 left out
                _kill(ri=2, killer=None, assister="1", flashAssist=True, aGroup=None),  # a flash assist: round 2 stays
            ])
            write("rating-hits.private.jsonl", [_hit(ri=3, vGroup=None)])          # her hit: round 3 left out
            d, provenance = eco_fit.collect(root, [JOIN])
        points = np.full(eco_fit.CELLS, 0.5)
        points[eco_fit.cell("sniper", "rifle1", "T")] = 1.7
        ours = eco_fit.eco_inputs(d, points)
        np.testing.assert_allclose([ours["ekpr"][0], ours["eadr"][0], ours["ekast"][0]], [1.7 / 2, 0, 100 * 1.7 / 2])
        self.assertEqual(provenance["unknown_group_rounds"], 2)

    def test_eco_fit_compares_with_hltv_over_the_sides_the_app_rates(self):
        # Review of PR 84: eco_fit's targets were HLTV's map totals over every round, while its predictions average the
        # rated rounds of the sides rating3Of rates. A player-map with a side or a round the app does not rate now
        # takes HLTV's side cells for the rated sides, weighted by their rated rounds; one with every round rated keeps
        # the totals, which HLTV rounds once. Fails if a side the app does not rate (ana's CT, none of 2 rounds rated)
        # or the rated-round weights (bob's 2 and 3) are lost, or if carol's totals give way to her rounded sides.
        eco_fit = _eco_fit(self)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _map(root)
            boards = {"totalstats": {"1": _cells(9, 7, 80.0, 70.0), "2": _cells(5, 3, 65.0, 70.0), "3": _cells(5, 2, 75.0, 72.5)},
                      "ctstats hidden": {"1": _cells(1, 3, 50.0, 40.0), "2": _cells(2, 1, 60.0, 75.0), "3": _cells(3, 1, 80.0, 75.0)},
                      "tstats hidden": {"1": _cells(8, 4, 95.0, 85.0), "2": _cells(3, 2, 70.0, 65.0), "3": _cells(3, 1, 70.0, 70.0)}}
            (root / "hltv" / "map_1.json").write_text(json.dumps({"match": {"matchId": "5"}, "scoreboards": [
                {"cls": f"stats-table {cls}", "rows": [{"player": f"p{pid}", "pid": pid, "cells": c} for pid, c in rows.items()]}
                for cls, rows in boards.items()]}), encoding="utf-8")
            write = _dump(root)
            carol = {"33": {"hltv": "carol", "pid": "3", "renamed": False}}
            write("rating-joins.private.jsonl", [_dumped_join(players={**JOIN["players"], **carol})])
            write("rating-rounds.private.jsonl", [
                *[_round("1", ri, "CT", rated=False) for ri in (0, 1)],
                *[_round("1", ri, "T", rated=ri != 5) for ri in (2, 3, 4, 5)],
                *[_round("2", ri, "CT") for ri in (0, 1)],
                *[_round("2", ri, "T", rated=ri != 5) for ri in (2, 3, 4, 5)],
                *[_round("3", ri, side) for ri, side in ((0, "CT"), (1, "CT"), (2, "T"), (3, "T"))],
            ])
            write("rating-kills.private.jsonl", [])
            write("rating-hits.private.jsonl", [])
            d, _ = eco_fit.collect(root, [{**JOIN, "players": {**JOIN["players"], **carol}}])
        np.testing.assert_allclose(
            [d.targets["ekpr"], d.targets["edpr"], d.targets["eadr"], d.targets["ekast"]],
            [[8 / 4, 0.4 * 2 / 2 + 0.6 * 3 / 4, 5 / 4], [4 / 4, 0.4 * 1 / 2 + 0.6 * 2 / 4, 2 / 4],
             [95.0, 0.4 * 60 + 0.6 * 70, 75.0], [85.0, 0.4 * 75 + 0.6 * 65, 72.5]])

    def test_eco_fit_values_a_rounds_eco_kast_by_the_apps_rule(self):
        # Issue 81: eco_fit fitted eKPR, eDPR and eADR only, so a refit could inflate eco KAST unchecked and the
        # rating ran 0.030 high. eKAST is now fitted too, valued as rating3.ts ecoAdjust values it: the most a rated
        # round's kills and non-flash assists are worth, or 1 for a traded death or survival in a won round. Fails if
        # any part of that rule, or the rated-rounds restriction, is lost.
        eco_fit = _eco_fit(self)
        c0, c1, c2 = (eco_fit.cell("sniper", "rifle1", "T"), eco_fit.cell("rifle1", "smg", "T"),
                      eco_fit.cell("smg", "pistol", "T"))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _map(root)
            write = _dump(root)
            write("rating-joins.private.jsonl", [_dumped_join()])
            write("rating-rounds.private.jsonl", [
                _round("1", 0, "T"),                               # a kill worth 1.7, the round lost: 1.7
                _round("1", 1, "T", survived=1),                   # a flash assist, survived a lost round: 0
                _round("1", 2, "T", won=True, survived=1),         # an assist worth 1.4, survived a won round: 1.4
                _round("1", 3, "T", deaths=1, tradedDeaths=1),     # a traded death: 1
                _round("1", 4, "T", rated=False),                  # not rated: left out
            ])
            write("rating-kills.private.jsonl", [
                _kill(ri=0, killer="1", victim="2", aGroup="sniper", vGroup="rifle1"),
                _kill(ri=1, killer=None, victim="2", assister="1", flashAssist=True, aGroup="smg", vGroup="pistol"),
                _kill(ri=2, killer=None, victim="2", assister="1", aGroup="rifle1", vGroup="smg"),
                _kill(ri=4, killer="1", victim="2", aGroup="sniper", vGroup="rifle1"),
            ])
            write("rating-hits.private.jsonl", [])
            d, _ = eco_fit.collect(root, [JOIN])
        points = np.full(eco_fit.CELLS, 0.5)
        points[[c0, c1, c2]] = 1.7, 1.4, 2.0
        ours = eco_fit.eco_inputs(d, points)
        np.testing.assert_allclose([ours["ekast"][0], ours["ekpr"][0]], [100 * (1.7 + 0 + 1.4 + 1) / 4, 1.7 / 4])

    def test_eco_fit_weighs_each_input_by_how_much_it_moves_the_rating(self):
        # Issue 81: eco_fit weighed kill and death errors by 0.2 and ADR errors by 0.05, a scale with no tie to the
        # rating. Each input's error is now weighed by the rating curve's slope at HLTV's value, in its own block, so
        # the fit cannot buy one input's accuracy with another's error. Fails if an input is left out or weighed
        # otherwise, or if a slope is read on the wrong side of a knot.
        eco_fit = _eco_fit(self)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _two_players(root)
            d, _ = eco_fit.collect(root, [JOIN])
        curves = {"eKPR": {"slope": 0.2, "knots": [2.0], "slope_changes": [9.0]},
                  "eDPR": {"slope": -0.3, "knots": [], "slope_changes": []},
                  "eADR": {"slope": 0.001, "knots": [100.0], "slope_changes": [0.002]},
                  "eKAST": {"slope": 0.001, "knots": [40.0, 60.0], "slope_changes": [0.002, 9.0]}}
        points = np.arange(1, eco_fit.CELLS + 1) / 10
        ours = eco_fit.eco_inputs(d, points)
        got = eco_fit.residuals(d, points, eco_fit.rating_weights(d, curves))
        expected = np.concatenate([0.2 * (ours["ekpr"] - 0.5), 0.3 * ours["edpr"], 0.003 * (ours["eadr"] - 100),
                                   0.003 * (ours["ekast"] - 50)])
        np.testing.assert_allclose(got, expected)
        # every slope change from a knot on, the second eKAST knot's too
        np.testing.assert_allclose(eco_fit.slope_at(curves["eKAST"], np.array([59.9, 60.0, 70.0])), [0.003, 9.003, 9.003])

    def test_eco_fit_counts_each_join_by_the_table_layout_the_dump_read(self):
        # Review of PR 80: once eco_fit read the dump instead of the tables, it counted every join as schema v1, so a
        # legacy map was reported as schema v1 in eco_metrics.json.
        eco_fit = _eco_fit(self)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _two_players(root, layout="legacy")
            _, provenance = eco_fit.collect(root, [JOIN])
        self.assertEqual(provenance["layouts"], {"schema_v1": 0, "legacy": 1})

    def test_eco_fit_refuses_rows_dumped_under_another_join(self):
        # Review of PR 80: eco_fit matched dump rows to joins by HLTV file only, so after demo_joins.json changed, a
        # dump not written again trained on the old demo's rows and the old pairing, with no warning.
        eco_fit = _eco_fit(self)
        other_pairing = {**JOIN["players"], str(BOB): {"hltv": "bob", "pid": "3", "renamed": False}}
        for stale in ({"demo": "demos/a-vs-b/m2-nuke"}, {"players": other_pairing}):
            with self.subTest(stale=stale), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                _two_players(root, **stale)
                with self.assertRaisesRegex(ValueError, "map_1.json: the rating dump holds it from another join"):
                    eco_fit.collect(root, [JOIN])

    def test_postplant_rows_place_a_renamed_players_kill(self):
        # Review of PR 70: the post-plant analysis found an HLTV kill in the demo by in-game name, so a renamed
        # player's kill had no tick and its row was dropped.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _map(root)
            rows = postplant_analysis.read_join(root, JOIN)
        self.assertEqual([(r["icon"], r["tick"]) for r in rows], [("bombplant.svg", 300), ("kill.svg", 500)])


if __name__ == "__main__":
    unittest.main()
