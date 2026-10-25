"""Tests for complete-version resolution during table loads."""
from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from demo_paths import load_demo_tables


class DemoTableLoadTests(unittest.TestCase):
    def test_reloads_every_table_after_current_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            map_dir = root / "demos" / "archive" / "m1-map"
            first = map_dir / "v-1.8.0-11111111"
            second = map_dir / "v-1.8.0-22222222"
            self.publish(first)
            self.publish(second)
            (map_dir / "CURRENT").write_text(first.name, encoding="utf-8")

            opened = []

            def read_table(path: Path) -> str:
                opened.append(path)
                if len(opened) == 1:
                    (map_dir / "CURRENT").write_text(second.name, encoding="utf-8")
                return path.parent.name + "/" + path.name

            layout, tables = load_demo_tables(
                root,
                "demos/archive/m1-map",
                ("match", "player_rounds", "kills"),
                read_table,
            )

            self.assertEqual(layout.directory, second)
            self.assertEqual(
                [path.parent for path in opened],
                [first, first, first, second, second, second],
            )
            self.assertEqual(
                tables,
                {
                    "match": f"{second.name}/match.parquet",
                    "player_rounds": f"{second.name}/player_rounds.parquet",
                    "kills": f"{second.name}/kills.parquet",
                },
            )

    @staticmethod
    def publish(directory: Path) -> None:
        directory.mkdir(parents=True)
        files = ("match.parquet", "player_rounds.parquet", "kills.parquet")
        for filename in files:
            (directory / filename).write_bytes(filename.encode("ascii"))
        manifest = {
            filename: (directory / filename).stat().st_size
            for filename in files
        }
        (directory / "COMPLETE").write_text(json.dumps(manifest), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
