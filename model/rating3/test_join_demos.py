"""join_demos on synthetic maps: no real player, demo or HLTV page."""
from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

import join_demos


def _hltv(path: Path, match_id: str, index: int, map_name: str, t: list[str], ct: list[str], kills: list[str]) -> None:
    """An HLTV map page as saved: two rounds, team A on T in both, winning round 1, team B winning round 2. Each
    player's scoreboard kills are his kills in kills."""
    count = lambda p: sum(k.split(" killed ")[0] == p for k in kills)
    path.write_text(json.dumps({
        "match": {"matchId": match_id}, "mapIndex": index,
        "info": [f"Event2026-04-01 12:00Map{map_name}A1B1"],
        "scoreboards": [{"cls": "totalstats", "rows": [{"player": p, "pid": f"pid-{p}",
                                                             "cells": [["st-kills traditional-data", str(count(p))]]}
                                                            for p in team]} for team in (t, ct)],
        "roundHistory": [{"team": "A", "outcomes": ["t_win.svg|1-0", "emptyHistory.svg|"]},
                         {"team": "B", "outcomes": ["emptyHistory.svg|", "ct_win.svg|1-1"]}],
        "performance": {"rounds": {f"round{n}": {"side": "t-side", "events": [{"title": k}]}
                                   for n, k in enumerate(kills, 1)}},
    }), encoding="utf-8")


class JoinByHltvMatch(unittest.TestCase):
    def test_a_map_naming_its_hltv_match_joins_the_map_of_its_name(self):
        # An OpenCS2 demo has no archive date and names its HLTV match. The dataset's map index named another map
        # than HLTV's on 6 of 1,148 saved scoreboards (one: its index 3 is an Inferno demo, HLTV's map 3 a Nuke), so
        # the join matches the match and the map's name, never the index.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            t, ct = [f"t{i}" for i in range(1, 6)], [f"c{i}" for i in range(1, 6)]
            (root / "hltv").mkdir()
            _hltv(root / "hltv" / "ocs_map_1.json", "9", 2, "Inferno", t, ct, ["t1 killed c1", "c2 killed t2"])
            _hltv(root / "hltv" / "ocs_map_2.json", "9", 3, "Nuke", t, ct, ["t1 killed c1", "c2 killed t2"])
            d = root / "demos" / "a-vs-b-opencs2-9-m3" / "m2-inferno"
            d.mkdir(parents=True)
            extra = dict(source="opencs2", hltv_match_id="9", hltv_map_index=3, map_name="de_inferno")
            pq.write_table(pa.table({"map": ["de_inferno"], "extra": [json.dumps(extra)]}), d / "match.parquet")
            pq.write_table(pa.table({"round": [1, 2], "winner_side": ["T", "CT"], "end_tick": [100, 200]}),
                           d / "rounds.parquet")
            ids = {name: n for n, name in enumerate(t + ct, 1)}
            pq.write_table(pa.table({"round": [1] * 10, "steamid": list(ids.values()), "name": list(ids),
                                     "side": ["T"] * 5 + ["CT"] * 5}), d / "player_rounds.parquet")
            pq.write_table(pa.table({"round": [1, 2], "tick": [50, 150], "is_suicide": [False, False],
                                     "is_teamkill": [False, False], "attacker_steamid": [ids["t1"], ids["c2"]],
                                     "victim_steamid": [ids["c1"], ids["t2"]]}), d / "kills.parquet")
            metrics = root / "metrics.json"
            metrics.write_text(json.dumps({"source_audit": {"sources": []}}), encoding="utf-8")
            result = join_demos.join(root, metrics)
        self.assertEqual([(a["hltv"], a["hltv_match_map"]) for a in result["accepted"]],
                         [("ocs_map_1.json", ("9", "inferno"))], result["rejected"])

    def test_a_map_naming_its_hltv_match_is_never_joined_by_date(self):
        # Review of PR 70: a demo's own HLTV match id outranks the date window. Here the only saved scoreboard is
        # another match's Inferno, 1 hour from the demo's archive date, with the same rosters and kills; joining it
        # would publish the rating rows of a map that is not this demo's.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            t, ct = [f"t{i}" for i in range(1, 6)], [f"c{i}" for i in range(1, 6)]
            (root / "hltv").mkdir()
            _hltv(root / "hltv" / "map_8.json", "8", 1, "Inferno", t, ct, ["t1 killed c1", "c2 killed t2"])
            d = root / "demos" / "a-vs-b-opencs2-9-m1" / "m1-inferno"
            d.mkdir(parents=True)
            extra = dict(source="opencs2", hltv_match_id="9", hltv_map_index=1, map_name="de_inferno",
                         dem_modified_in_archive="2026-04-01 13:00:00")
            pq.write_table(pa.table({"map": ["de_inferno"], "extra": [json.dumps(extra)]}), d / "match.parquet")
            pq.write_table(pa.table({"round": [1, 2], "winner_side": ["T", "CT"], "end_tick": [100, 200]}),
                           d / "rounds.parquet")
            ids = {name: n for n, name in enumerate(t + ct, 1)}
            pq.write_table(pa.table({"round": [1] * 10, "steamid": list(ids.values()), "name": list(ids),
                                     "side": ["T"] * 5 + ["CT"] * 5}), d / "player_rounds.parquet")
            pq.write_table(pa.table({"round": [1, 2], "tick": [50, 150], "is_suicide": [False, False],
                                     "is_teamkill": [False, False], "attacker_steamid": [ids["t1"], ids["c2"]],
                                     "victim_steamid": [ids["c1"], ids["t2"]]}), d / "kills.parquet")
            metrics = root / "metrics.json"
            metrics.write_text(json.dumps({"source_audit": {"sources": [{"file": "map_8.json"}]}}), encoding="utf-8")
            result = join_demos.join(root, metrics)
        self.assertEqual(result["accepted"], [])
        self.assertEqual([(r["reason"], r["hltv"]) for r in result["rejected"]],
                         [("HLTV scoreboard not captured", ("9", "inferno"))])


def _copy(root: Path, slug: str, version: str) -> None:
    """A published Inferno map from an HLTV archive (archive date 2026-04-01 13:00) under demos/<slug>, extracted by
    version, matching the HLTV page _hltv writes with t1 killed c1 and c2 killed t2."""
    t, ct = [f"t{i}" for i in range(1, 6)], [f"c{i}" for i in range(1, 6)]
    d = root / "demos" / slug / "m1-inferno"
    d.mkdir(parents=True)
    pq.write_table(pa.table({"map": ["de_inferno"], "extractor_version": [version],
                             "extra": [json.dumps(dict(dem_modified_in_archive="2026-04-01 13:00:00"))]}),
                   d / "match.parquet")
    pq.write_table(pa.table({"round": [1, 2], "winner_side": ["T", "CT"], "end_tick": [100, 200]}), d / "rounds.parquet")
    ids = {name: n for n, name in enumerate(t + ct, 1)}
    pq.write_table(pa.table({"round": [1] * 10, "steamid": list(ids.values()), "name": list(ids),
                             "side": ["T"] * 5 + ["CT"] * 5}), d / "player_rounds.parquet")
    pq.write_table(pa.table({"round": [1, 2], "tick": [50, 150], "is_suicide": [False, False],
                             "is_teamkill": [False, False], "attacker_steamid": [ids["t1"], ids["c2"]],
                             "victim_steamid": [ids["c1"], ids["t2"]]}), d / "kills.parquet")


def slug(demo: str) -> str:
    """The slug of a joined demo folder, recorded as demos\\<slug>\\<map> whatever the OS."""
    return re.split(r"[\\/]+", demo)[1]


class OneDemoPerHltvMap(unittest.TestCase):
    def test_two_copies_of_one_map_count_once_the_newer_extraction_kept(self):
        # Review of PR 70: one archive published under two slugs joined the same two HLTV maps twice, so the fits
        # counted those maps twice. The newer extraction stays (1.16.0 over 1.9.0: by number, not as text); with equal
        # versions, the first folder.
        for versions, kept in (({"x-1": "1.9.0", "x-2": "1.16.0"}, "x-2"), ({"x-2": "1.16.0", "x-1": "1.16.0"}, "x-1")):
            with self.subTest(versions=versions), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                t, ct = [f"t{i}" for i in range(1, 6)], [f"c{i}" for i in range(1, 6)]
                (root / "hltv").mkdir()
                _hltv(root / "hltv" / "map_7.json", "7", 1, "Inferno", t, ct, ["t1 killed c1", "c2 killed t2"])
                for name, version in versions.items():
                    _copy(root, name, version)
                metrics = root / "metrics.json"
                metrics.write_text(json.dumps({"source_audit": {"sources": [{"file": "map_7.json"}]}}), encoding="utf-8")
                result = join_demos.join(root, metrics)
                other = ({"x-1", "x-2"} - {kept}).pop()
                self.assertEqual([slug(a["demo"]) for a in result["accepted"]], [kept])
                self.assertEqual([(slug(d["demo"]), slug(d["kept"]), d["reason"])
                                  for d in result["duplicates"]], [(other, kept, "duplicate")])
                self.assertEqual((result["counts"]["accepted"], result["counts"]["duplicates"]), (1, 1))


class DateWindowTrust(unittest.TestCase):
    def test_a_wrong_match_identical_in_every_kill_is_refused_only_by_a_learned_pair(self):
        # Review 2 of PR 70: a demo with no HLTV match id joins by the date window. With its own scoreboard not saved,
        # another match's page with the same rosters, round winners and kills passes every check. A learned pair that
        # puts a known player on another HLTV player refuses it; with no learned evidence it is accepted, the residual
        # SPEC.md states.
        cases = (({"1": "pid-elsewhere"}, []), ({"1": "pid-t1"}, ["map_8.json"]), ({}, ["map_8.json"]))
        for learned, accepted in cases:
            with self.subTest(learned=learned), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                t, ct = [f"t{i}" for i in range(1, 6)], [f"c{i}" for i in range(1, 6)]
                (root / "hltv").mkdir()
                _hltv(root / "hltv" / "map_8.json", "8", 1, "Inferno", t, ct, ["t1 killed c1", "c2 killed t2"])
                _copy(root, "x-1", "1.16.0")
                metrics = root / "metrics.json"
                metrics.write_text(json.dumps({"source_audit": {"sources": [{"file": "map_8.json"}]}}), encoding="utf-8")
                result = join_demos.join(root, metrics, learned)
                self.assertEqual([a["hltv"] for a in result["accepted"]], accepted)
                if not accepted:
                    self.assertEqual([n["players"] for r in result["rejected"] for n in r["near"]],
                                     ["t1 would be HLTV t1 (player id pid-t1), but an earlier join paired that SteamID "
                                      "with player id pid-elsewhere"])


class PlayerIds(unittest.TestCase):
    def test_a_page_without_a_players_id_is_not_joined(self):
        # Review of PR 77: a scoreboard row with no pid was paired as "", which the fits and the learned map read as
        # an HLTV player, pairing him with nobody. The candidate is refused, naming who has no id.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            t, ct = [f"t{i}" for i in range(1, 6)], [f"c{i}" for i in range(1, 6)]
            (root / "hltv").mkdir()
            page = root / "hltv" / "map_8.json"
            _hltv(page, "8", 1, "Inferno", t, ct, ["t1 killed c1", "c2 killed t2"])
            data = json.loads(page.read_text(encoding="utf-8"))
            data["scoreboards"][0]["rows"][2]["pid"] = ""  # t3
            page.write_text(json.dumps(data), encoding="utf-8")
            _copy(root, "x-1", "1.16.0")
            metrics = root / "metrics.json"
            metrics.write_text(json.dumps({"source_audit": {"sources": [{"file": "map_8.json"}]}}), encoding="utf-8")
            result = join_demos.join(root, metrics)
        self.assertEqual(result["accepted"], [])
        self.assertEqual([n["players"] for r in result["rejected"] for n in r["near"]], ["HLTV lists no player id for ['t3']"])


if __name__ == "__main__":
    unittest.main()
