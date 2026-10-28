"""Each model/rating3 writer refuses a private output inside the repository before it reads any data, and
lets it through outside; params.json, the one public output, may take only its own path.

    python -I -m unittest model/rating3/test_rating3_repo_guard.py     (or pytest)

Named apart from extractor/tests/test_repo_guard.py so one pytest run can collect both.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    import scipy  # noqa: F401 - several fit scripts need it
except ModuleNotFoundError:
    # Only this missing package skips: install model/rating3/requirements.txt to run these tests (CI's model job does).
    raise unittest.SkipTest("scipy is not installed; pip install -r model/rating3/requirements.txt") from None

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]

# each writer's required arguments besides the output, pointing at data that does not exist: a run that
# gets past the guard then fails on the missing data, which shows the guard let it through
NOWHERE = "nowhere-data"
WRITERS = {
    "join_demos.py": ["--data", NOWHERE, "--metrics", NOWHERE],
    "postplant_analysis.py": ["--data", NOWHERE, "--joins", NOWHERE],
    "eco_fit.py": ["--data", NOWHERE, "--joins", NOWHERE],
    "hypothesis_fit.py": ["--hltv", NOWHERE],
    "round_fit.py": ["--hltv", NOWHERE],
    "side_fit.py": ["--hltv", NOWHERE],
    "swing_fit.py": ["--data", NOWHERE, "--joins", NOWHERE],
    "demo_round_fit.py": ["--data", NOWHERE, "--joins", NOWHERE],
    "additive_fit.py": ["--hltv", NOWHERE],
}


def run(script: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-I", str(HERE / script), *args], capture_output=True, text=True, timeout=120,
                          cwd=tempfile.gettempdir())


class PrivateReports(unittest.TestCase):
    def test_each_report_is_refused_in_the_repository_before_any_data_is_read(self):
        # fails if a writer can put a private report in the tree, under model/ or anywhere else in it
        for script, args in WRITERS.items():
            for out in (HERE / "report.json", REPO / "app" / "public" / "report.json", REPO / "x" / ".." / "report.json"):
                with self.subTest(script=script, out=str(out)):
                    r = run(script, *args, "--out", str(out))
                    self.assertNotEqual(r.returncode, 0)
                    self.assertIn("refusing to write", r.stderr)
                    self.assertIn("is private", r.stderr)
                    self.assertFalse(out.exists())

    def test_each_report_gets_past_the_guard_outside_the_repository(self):
        with tempfile.TemporaryDirectory() as tmp:
            for script, args in WRITERS.items():
                with self.subTest(script=script):
                    r = run(script, *args, "--out", str(Path(tmp) / "report.json"))
                    self.assertNotIn("refusing to write", r.stderr)

    def test_the_winprob_lookup_and_report_are_refused_in_the_repository(self):
        # the lookup is the private HLTV win-probability pack
        r = run("winprob_fit.py", "--data", NOWHERE, "--private-data", str(REPO / "model" / "private"))
        self.assertIn("refusing to write the HLTV win-probability lookup", r.stderr)
        r = run("winprob_fit.py", "--data", NOWHERE, "--out", str(HERE / "winprob_metrics.json"))
        self.assertIn("refusing to write the win-probability report", r.stderr)
        with tempfile.TemporaryDirectory() as tmp:
            r = run("winprob_fit.py", "--data", NOWHERE, "--private-data", tmp, "--out", str(Path(tmp) / "m.json"))
            self.assertNotIn("refusing to write", r.stderr)


class PublicParams(unittest.TestCase):
    ARGS = ["--data", NOWHERE, "--hltv", NOWHERE, "--joins", NOWHERE]

    def test_params_json_may_take_its_own_path_and_no_other_in_the_repository(self):
        # fails if params.json can be written elsewhere in the tree, or no longer to its own path
        r = run("fit_params.py", *self.ARGS, "--out", str(HERE / "params.json"))
        self.assertNotIn("refusing to write", r.stderr)
        for out in (HERE / "params-copy.json", REPO / "app" / "public" / "params.json"):
            r = run("fit_params.py", *self.ARGS, "--out", str(out))
            self.assertIn("its only place in the repository is", r.stderr)
        with tempfile.TemporaryDirectory() as tmp:
            r = run("fit_params.py", *self.ARGS, "--out", str(Path(tmp) / "params.json"))
            self.assertNotIn("refusing to write", r.stderr)


class FitRating3(unittest.TestCase):
    """model/fit_rating3.py: the fixed rating3-params.ts is public, a fit written anywhere else private."""

    def fit(self, *args):
        return subprocess.run([sys.executable, "-I", str(REPO / "model" / "fit_rating3.py"), NOWHERE, "--write", *args],
                              capture_output=True, text=True, timeout=120, cwd=tempfile.gettempdir())

    def test_its_fixed_output_gets_past_the_guard_and_nothing_else_in_the_repository_does(self):
        # fails if --out can put a fit from the private players CSV in the tree (it wrote directly before)
        self.assertNotIn("refusing to write", self.fit().stderr)
        for out in (REPO / "app" / "src" / "stats" / "rating3-params.copy.ts", REPO / "model" / "fit.private.ts"):
            r = self.fit("--out", str(out))
            self.assertIn("is private and must stay outside the repository", r.stderr)
            self.assertFalse(out.exists())

    def test_outside_the_repository_a_private_fit_must_carry_the_marker_in_its_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIn("must be named *.private.*", self.fit("--out", str(Path(tmp) / "fit.ts")).stderr)
            self.assertNotIn("refusing to write", self.fit("--out", str(Path(tmp) / "fit.private.ts")).stderr)


if __name__ == "__main__":
    unittest.main()
