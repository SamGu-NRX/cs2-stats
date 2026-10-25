"""Synthetic checks for flash calibration and duel baseline units.

Run with python -I test_fit_calibration.py; no private data is needed.
"""
from copy import deepcopy
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import eco_fit
import swing_fit


FLASH_BUCKET = "damage=False flash=1 trade=False"


def flash_event(match: str, map_name: str, ratio: float, layout: str) -> dict:
    return {
        "match": match,
        "map": map_name,
        "layout": layout,
        "round": 1,
        "index": 0,
        "event": {"title": "attacker killed victim"},
        "kill": {"attacker_steamid": "attacker", "victim_steamid": "victim"},
        "delta": 0.1,
        "observed": {"attacker": ratio * 0.1, "victim": -0.1},
        "damage": {},
        "damage_seen": False,
        "flash": {"helper"},
        "traded": [],
        "future_trades": [],
    }


class FlashCalibrationTests(unittest.TestCase):
    def setUp(self):
        self.events = [
            flash_event(str(match), f"map-{match}-{map_index}",
                        0.2 if match == 0 else 0.8,
                        "legacy" if match == 0 else "schema_v1")
            for match in range(5)
            for map_index in range(2)
        ]

    def fit_block(self, events):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            joins = root / "joins.json"
            joins.write_text(json.dumps({"accepted": [], "counts": {"accepted": 0}}))
            with patch.object(swing_fit, "joined_events", return_value=iter(events)):
                return swing_fit.fit_block(root, joins)

    def test_emitted_fraction_uses_both_layouts(self):
        result = self.fit_block(self.events)
        self.assertAlmostEqual(result["flash_credit_fraction"], 0.2)
        self.assertEqual(result["flash_credit_sample_size"], 10)
        self.assertEqual(result["source"]["flash_calibration_layout"], "all_consumed_joins")
        comparison = result["source"]["layout_comparison"]
        self.assertAlmostEqual(comparison["legacy"]["flash_credit_fraction"], 0.8)
        self.assertEqual(comparison["legacy"]["sample_size"], 2)
        self.assertEqual(comparison["legacy"]["matches"], 1)
        self.assertEqual(comparison["schema_v1"]["sample_size"], 8)
        self.assertEqual(comparison["schema_v1"]["matches"], 4)

    def test_held_out_medians_exclude_every_map_of_test_match(self):
        result = swing_fit.held_out_flash_error(self.events, FLASH_BUCKET)
        self.assertEqual(result["n"], 10)
        self.assertEqual(result["matches"], 5)
        self.assertAlmostEqual(result["mae"], 0.12)
        self.assertAlmostEqual(result["max"], 0.6)
        for fold in result["folds"]:
            self.assertEqual(fold["n"], 2)
            self.assertEqual(fold["matches"], 1)
            self.assertAlmostEqual(fold["median"], 0.8)

    def test_clean_bucket_requires_exactly_one_flash(self):
        excluded = []
        for changes in (
            {"flash": set()},
            {"flash": {"helper", "other"}},
            {"damage_seen": True},
            {"traded": [{"victim_steamid": "other"}]},
            {"kill": None},
            {"delta": 0.0009},
        ):
            event = deepcopy(self.events[0])
            event.update(changes)
            excluded.append(event)
        result = self.fit_block(self.events + excluded)
        self.assertEqual(result["flash_credit_sample_size"], 10)
        self.assertEqual(result["held_out"]["n"], 10)

    def test_single_layout_does_not_require_legacy_observations(self):
        result = self.fit_block(self.events[2:])
        self.assertAlmostEqual(result["flash_credit_fraction"], 0.2)
        legacy = result["source"]["layout_comparison"]["legacy"]
        self.assertEqual(legacy["sample_size"], 0)
        self.assertIsNone(legacy["flash_credit_fraction"])
        self.assertEqual(result["held_out"]["split"], "4-fold GroupKFold by match")

    def test_no_clean_observations_fails_loudly(self):
        with self.assertRaisesRegex(ValueError, "no clean single-flash observations"):
            self.fit_block([])

    def test_single_match_cannot_claim_held_out_error(self):
        result = swing_fit.held_out_flash_error([self.events[0]] * 5, FLASH_BUCKET)
        self.assertEqual(result["split"], "insufficient match groups")
        self.assertNotIn("mae", result)


class DuelBaselineTests(unittest.TestCase):
    def test_target_errors_accept_adr_as_rate_not_total_damage(self):
        target = {"ek": 12.0, "ed": 8.0, "eadr": 75.0, "rounds": 20}
        self.assertEqual(eco_fit.target_errors(target, kills=12, deaths=8, adr=75), [0, 0, 0])
        np.testing.assert_allclose(
            eco_fit.target_errors(target, kills=17, deaths=3, adr=95), [1, -1, 1],
        )

    def test_baseline_uses_training_means_with_no_second_adr_division(self):
        targets = [
            {
                "target": "player", "match": str(match),
                "map": f"map-{match}-{map_index}", "player": "player",
                "ek": 10.0 + match * 2, "ed": 15.0 - match,
                "eadr": 40.0 + match * 10, "rounds": 12 + map_index * 18,
            }
            for match in range(5)
            for map_index in range(2)
        ]
        expected = []
        for target in targets:
            train = [row for row in targets if row["match"] != target["match"]]
            expected.extend([
                abs(np.mean([row["ek"] for row in train]) - target["ek"]) * 0.2,
                abs(np.mean([row["ed"] for row in train]) - target["ed"]) * 0.2,
                abs(np.mean([row["eadr"] for row in train]) - target["eadr"]) * 0.05,
            ])
        with patch.object(eco_fit, "collect", return_value=(targets, [], eco_fit.empty_provenance())):
            with patch.object(eco_fit, "least_squares", side_effect=lambda fun, initial, **kw: SimpleNamespace(x=initial)):
                result = eco_fit.fit_model(Path("unused"), [])
        baseline = result["held_out_baseline"]
        self.assertEqual(baseline["targets"], 10)
        self.assertEqual(baseline["matches"], 5)
        self.assertAlmostEqual(baseline["mae"], float(np.mean(expected)))
        self.assertAlmostEqual(baseline["p95"], float(np.quantile(expected, 0.95)))
        self.assertAlmostEqual(baseline["max"], max(expected))
        for fold in baseline["folds"]:
            self.assertEqual(fold["matches"], 1)
            self.assertEqual(fold["targets"], 2)


if __name__ == "__main__":
    unittest.main()
