"""The fits read a joined map's players through the join's pairing, on synthetic maps: no real player, demo or HLTV
page."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

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
                                                    ["st-adr eco-adjusted-data", "100.0"], ["st-rating", "1.10"]]}


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
        try:
            import eco_fit
        except ImportError as error:
            self.skipTest(f"{error}; pip install -r model/rating3/requirements.txt")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _map(root)
            write = _dump(root)
            kill = lambda **k: {"hltv": "map_1.json", "enemy": True, "killer": "1", "victim": "2", "killerSide": "T",
                                "aGroup": "sniper", "vGroup": "rifle1", **k}
            write("rating-kills.private.jsonl", [kill(), kill(aGroup=None), kill(enemy=False), kill(hltv="map_9.json")])
            hit = lambda **k: {"hltv": "map_1.json", "attacker": "1", "victim": "2", "aSide": "T", "dmg": 100,
                               "aGroup": "sniper", "vGroup": "rifle1", **k}
            write("rating-hits.private.jsonl", [hit(), hit(vGroup=None, dmg=40)])
            write("rating-winprob.private.jsonl", [{"hltv": "map_1.json", "ri": 0}, {"hltv": "map_9.json", "ri": 0}])
            write("rating-joins.private.jsonl", [_dumped_join(), {**_dumped_join(), "hltv": "map_9.json"}])
            rows, duels, provenance = eco_fit.collect(root, [JOIN])
        self.assertEqual([(d["a"], d["v"], d["side"]) for d in duels], [("sniper", "rifle1", "T")])
        self.assertEqual(sorted((r["player"], r["victim"], r["a"], r["v"], r["kill"]) for r in rows if "victim" in r),
                         [("1", "2", "sniper", "rifle1", False), ("1", "2", "sniper", "rifle1", True)])
        self.assertEqual(sorted((r["player"], r["ek"], r["eadr"], r["rounds"]) for r in rows if r.get("target")),
                         [("1", 1.0, 100.0, 1), ("2", 1.0, 100.0, 1)])
        self.assertEqual(provenance["consumed_joins"], 1)

    def test_eco_fit_counts_each_join_by_the_table_layout_the_dump_read(self):
        # Review of PR 80: once eco_fit read the dump instead of the tables, it counted every join as schema v1, so a
        # legacy map was reported as schema v1 in eco_metrics.json.
        try:
            import eco_fit
        except ImportError as error:
            self.skipTest(f"{error}; pip install -r model/rating3/requirements.txt")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _map(root)
            write = _dump(root)
            for name in ("rating-kills.private.jsonl", "rating-hits.private.jsonl"):
                write(name, [])
            write("rating-winprob.private.jsonl", [{"hltv": "map_1.json", "ri": 0}])
            write("rating-joins.private.jsonl", [_dumped_join(layout="legacy")])
            _, _, provenance = eco_fit.collect(root, [JOIN])
        self.assertEqual(provenance["layouts"], {"schema_v1": 0, "legacy": 1})

    def test_eco_fit_refuses_rows_dumped_under_another_join(self):
        # Review of PR 80: eco_fit matched dump rows to joins by HLTV file only, so after demo_joins.json changed, a
        # dump not written again trained on the old demo's rows and the old pairing, with no warning.
        try:
            import eco_fit
        except ImportError as error:
            self.skipTest(f"{error}; pip install -r model/rating3/requirements.txt")
        other_pairing = {**JOIN["players"], str(BOB): {"hltv": "bob", "pid": "3", "renamed": False}}
        for stale in (_dumped_join(demo="demos/a-vs-b/m2-nuke"), _dumped_join(players=other_pairing)):
            with self.subTest(stale=stale), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                _map(root)
                write = _dump(root)
                for name in ("rating-kills.private.jsonl", "rating-hits.private.jsonl"):
                    write(name, [])
                write("rating-winprob.private.jsonl", [{"hltv": "map_1.json", "ri": 0}])
                write("rating-joins.private.jsonl", [stale])
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
