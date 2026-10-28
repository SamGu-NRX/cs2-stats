"""join_demos on synthetic maps: no real player, demo or HLTV page."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

import join_demos


def _hltv(path: Path, match_id: str, index: int, map_name: str, t: list[str], ct: list[str], kills: list[str]) -> None:
    """An HLTV map page as saved: two rounds, team A on T in both, winning round 1, team B winning round 2."""
    path.write_text(json.dumps({
        "match": {"matchId": match_id}, "mapIndex": index,
        "info": [f"Event2026-04-01 12:00Map{map_name}A1B1"],
        "scoreboards": [{"cls": "totalstats", "rows": [{"player": p} for p in team]} for team in (t, ct)],
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


if __name__ == "__main__":
    unittest.main()
