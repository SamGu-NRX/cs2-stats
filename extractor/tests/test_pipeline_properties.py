"""Properties of the pipeline's two sizing rules, on seeded random inputs.

worker_capacity (how many parse workers may run) and desired_downloads (the Little's-law download target) are
pure functions whose rules hold for every input: bounds, monotonicity, and never committing memory or disk that
is not there. test_units.py checks chosen values; these check the rules everywhere. A seeded generator rather
than a property-testing library: the inputs are a handful of numbers, and a failure names its case so it
reproduces exactly.
"""
import math
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import demo_pipeline as dp  # noqa: E402

CASES = 3000


def capacity_inputs(r: random.Random):
    return dict(avail_gb=r.uniform(0.0, 64.0), parse_est_gb=r.uniform(0.3, 8.0), growth_gb=r.uniform(0.0, 12.0),
                running=r.randint(0, 12), cpu_count=r.randint(1, 32), cs2=r.random() < 0.3,
                cap=r.choice([None, None, 1, 2, 4, 8]))


def test_worker_capacity_keeps_its_limits_and_never_overcommits_memory():
    # fails if the pool passes its CPU, CS2 or configured cap, starts a worker under the memory-pressure floor,
    # drops a running worker's slot above it, starts more new workers than the memory left after headroom and
    # the running workers' growth holds (one first worker excepted, as documented), or shrinks as memory grows
    r = random.Random(20261028)
    for case in range(CASES):
        k = capacity_inputs(r)
        n = dp.worker_capacity(**k)
        limit = dp.GAMING_WORKERS if k["cs2"] else max(1, k["cpu_count"] - 2)
        if k["cap"] is not None:
            limit = min(limit, k["cap"])
        assert 0 <= n <= limit, (case, k, n)
        if k["avail_gb"] < dp.RAM_PRESSURE_GB:
            assert n <= k["running"], (case, k, n)
        else:
            assert n >= min(limit, max(k["running"], 1)), (case, k, n)
            started = n - k["running"]
            room = k["avail_gb"] - dp.RAM_HEADROOM_GB - k["growth_gb"]
            if started > 0 and not (k["running"] == 0 and n == 1):
                assert started * k["parse_est_gb"] <= room + 1e-9, (case, k, n)
        more = dict(k, avail_gb=k["avail_gb"] + r.uniform(0.0, 16.0))
        assert dp.worker_capacity(**more) >= n, (case, k, more)
        heavier = dict(k, parse_est_gb=k["parse_est_gb"] + r.uniform(0.0, 4.0), growth_gb=k["growth_gb"] + r.uniform(0.0, 4.0))
        assert dp.worker_capacity(**heavier) <= n, (case, k, heavier)


def want_inputs(r: random.Random):
    return dict(workers=r.randint(1, 16), parse_s=r.uniform(30.0, 3600.0), download_s=r.uniform(5.0, 1800.0),
                in_flight=r.randint(0, 6), room_gb=r.uniform(-10.0, 40.0), archive_gb=r.uniform(0.2, 8.0))


def test_desired_downloads_stays_within_the_disk_and_moves_the_right_way():
    # fails if the target passes MAX_WANT, asks for an archive the disk budget left cannot hold beside those in
    # flight, goes below zero, or moves against its inputs: more workers, slower downloads or more room never
    # lower it, and slower parses or bigger archives never raise it
    r = random.Random(20261029)
    for case in range(CASES):
        k = want_inputs(r)
        w = dp.desired_downloads(**k)
        assert 0 <= w <= dp.MAX_WANT, (case, k, w)
        assert w <= k["in_flight"] + max(0, math.floor(k["room_gb"] / k["archive_gb"])), (case, k, w)
        for field, up in (("workers", r.randint(1, 8)), ("download_s", r.uniform(0.0, 600.0)), ("room_gb", r.uniform(0.0, 20.0))):
            assert dp.desired_downloads(**dict(k, **{field: k[field] + up})) >= w, (case, field, k)
        for field, up in (("parse_s", r.uniform(0.0, 1800.0)), ("archive_gb", r.uniform(0.0, 4.0))):
            assert dp.desired_downloads(**dict(k, **{field: k[field] + up})) <= w, (case, field, k)
