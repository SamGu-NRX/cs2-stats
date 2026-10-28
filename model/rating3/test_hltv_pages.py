"""hltv_pages on synthetic page files: no real HLTV page."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from hltv_pages import hltv_pages


class HltvPages(unittest.TestCase):
    def test_the_opencs2_pages_count_once_per_hltv_map(self):
        # Review of the refit on OpenCS2 maps: the rating, eco-adjustment and defuse fits read map_*.json only, so the
        # 1,178 pages saved for the OpenCS2 demos added nothing to them. Both kinds count; a map with both keeps one.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, msid in (("map_1.json", "10"), ("ocs_map_2.json", "10"), ("ocs_map_3.json", "11"),
                               ("map_4.json", "12"), ("demo_feed.jsonl", None)):
                (root / name).write_text(json.dumps({"v": 3, "mapstatsid": msid}), encoding="utf-8")
            self.assertEqual([p.name for p in hltv_pages(root)], ["map_1.json", "map_4.json", "ocs_map_3.json"])
            (root / "ocs_map_5.json").write_text(json.dumps({"v": 3}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "ocs_map_5.json: no mapstatsid"):
                hltv_pages(root)


if __name__ == "__main__":
    unittest.main()
