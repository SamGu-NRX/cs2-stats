"""Synthetic checks for flash calibration and the duel fit's held-out baseline.

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

try:
    import scipy  # noqa: F401 - several fit scripts need it
except ModuleNotFoundError:
    # Only this missing package skips: install model/rating3/requirements.txt to run these tests (CI's model job does).
    raise unittest.SkipTest("scipy is not installed; pip install -r model/rating3/requirements.txt") from None

import numpy as np
from scipy import sparse

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
    def test_a_duel_fit_stopped_at_the_evaluation_cap_publishes_nothing(self):
        # Review of PR 84: solve returned least_squares' vector without reading success, so a fit stopped at the
        # 400-evaluation cap would reach params.json as if it had converged. Fails if that vector is returned.
        stopped = SimpleNamespace(success=False, x=eco_fit.INITIAL,
                                  message="The maximum number of function evaluations is exceeded.")
        with patch.object(eco_fit, "least_squares", return_value=stopped):
            with self.assertRaisesRegex(RuntimeError, "did not converge: The maximum number"):
                eco_fit.solve(None, {})

    def test_baseline_predicts_each_input_at_its_training_mean_in_rating_points(self):
        # Fails if the held-out baseline is scored on anything but each input's training-fold mean, weighed by the
        # rating curve's slope at HLTV's value as the fit's own errors are, so the two are in the same units.
        n = 10
        targets = {"ekpr": np.linspace(0.5, 0.9, n), "edpr": np.linspace(0.8, 0.6, n),
                   "eadr": np.linspace(60, 90, n), "ekast": np.linspace(62, 80, n)}
        match = np.array([str(i // 2) for i in range(n)])
        none = sparse.csr_matrix((n, eco_fit.CELLS))
        d = eco_fit.Duels(kills=none, deaths=none, damage=none, kast_rounds=sparse.csr_matrix((n, 1)),
                          kast_floor=np.zeros(1), kast_cells=np.full((1, 1), eco_fit.CELLS), rated=np.ones(n),
                          players=sparse.identity(n, format="csr"), targets=targets, match=match, duels=0)
        slope = {"ekpr": 0.2, "edpr": 0.3, "eadr": 0.001, "ekast": 0.002}
        curves = {curve: {"slope": slope[name] * (-1 if name == "edpr" else 1), "knots": [], "slope_changes": []}
                  for name, curve in eco_fit.INPUTS.items()}
        expected = [slope[k] * abs(targets[k][match != match[i]].mean() - targets[k][i]) for i in range(n) for k in slope]
        with patch.object(eco_fit, "collect", return_value=(d, eco_fit.empty_provenance())), \
                patch.object(eco_fit, "solve", return_value=eco_fit.INITIAL):
            baseline = eco_fit.fit_model(Path("unused"), [], curves)["held_out_baseline"]
        self.assertEqual((baseline["player_maps"], baseline["matches"]), (10, 5))
        self.assertAlmostEqual(baseline["mae"], float(np.mean(expected)))
        self.assertAlmostEqual(baseline["p95"], float(np.quantile(expected, 0.95)))
        self.assertAlmostEqual(baseline["max"], max(expected))
        self.assertEqual([(f["matches"], f["player_maps"]) for f in baseline["folds"]], [(1, 2)] * 5)


if __name__ == "__main__":
    unittest.main()
