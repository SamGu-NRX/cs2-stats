"""Fit Rating 3.0 as HLTV computes it: per side, then the total as the sides' round-weighted mean.

HLTV's map total equals the round-weighted mean of its CT and T ratings to display rounding (MAE
0.0035 over 7,330 player-maps), so the model rates each side and averages. One side's rating is

    intercept + ct_offset * [CT] + sum of curve_f(input_f) + sum of k_n * (share of rounds with exactly n kills)

where each curve is piecewise linear in its input (eKPR, eADR, eDPR, eKAST, Swing): a slope, plus a
change of slope at each knot. Knots sit at fixed quantiles of the training inputs. The curves bend
upward for every positive input, which a straight line cannot follow; a linear model on the same
inputs leaves held-out MAE 0.047 where the curves reach 0.025.

Inputs are HLTV's displayed side columns (eK, eD, eADR, eKAST), its per-round swing (performance
perRound, unrounded), and the 2K-5K round counts from its kill feed. Each side row is weighted by its
rounds.

The held-out split is by event and date: whole events, latest first by their first map date, go to the
test set until it holds a quarter of the maps. No map of a test event is used for fitting.
"""
from __future__ import annotations

from collections import defaultdict
import json
from pathlib import Path
import re

import numpy as np

CURVES = ("eKPR", "eADR", "eDPR", "eKAST", "Swing")
KILL_ROUNDS = ("K2", "K3", "K4", "K5")
KNOT_QUANTILES = (0.05, 0.23, 0.41, 0.59, 0.77, 0.95)
TEST_SHARE = 0.25
DATE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def _num(value: str) -> float:
    value = value.replace("%", "").replace("+", "").strip()
    return float("nan") if value in {"", "-", "N/A"} else float(value)


def _lead(value: str) -> float:
    m = re.match(r"\s*(-?[\d.]+)", value)
    return float(m.group(1)) if m else float("nan")


def _cell(cells: list, prefix: str, eco: bool) -> str:
    for classes, value in cells:
        if prefix in classes.split() and ("eco-adjusted-data" in classes) == eco:
            return value
    raise KeyError(prefix)


def map_side_rows(path: Path) -> list[dict]:
    """One row per player and side of one v3 HLTV map, with the side's rating, inputs and rounds."""
    d = json.loads(path.read_text(encoding="utf-8"))
    if d.get("v") != 3 or not d.get("performance", {}).get("rounds"):
        return []
    perf = d["performance"]
    info = d["info"][0]
    date = DATE.search(info)
    event = info[: date.start()] if date else info
    teams = [t["team"] for t in d["roundHistory"]]
    first = teams[0]
    team_of, rows = {}, {}
    for board in d["scoreboards"]:
        cls = board["cls"].split()
        side = "CT" if "ctstats" in cls else "T" if "tstats" in cls else None
        if "totalstats" in cls:
            for r in board["rows"]:
                team_of[r["player"]] = board["head"][0][1]
        if side is None:
            continue
        for r in board["rows"]:
            c = r["cells"]
            rows[(r["pid"], side)] = {
                "rating": _num(_cell(c, "st-rating", False)), "ek": _lead(_cell(c, "st-kills", True)),
                "ed": _lead(_cell(c, "st-deaths", True)), "eadr": _num(_cell(c, "st-adr", True)),
                "ekast": _num(_cell(c, "st-kast", True)), "team": board["head"][0][1], "nick": r["player"],
            }
    pid = {p["nick"]: p["pid"] for p in perf["players"]}
    nicks = sorted(pid, key=len, reverse=True)
    swing = {p["pid"]: {int(n): 100 * float(v) for n, v in p["perRound"]} for p in perf["players"]}
    rounds = defaultdict(int)
    kills_in = defaultdict(lambda: defaultdict(int))  # (pid, side) -> {kills in a round: rounds}
    swing_sum = defaultdict(float)
    for rname, rd in perf["rounds"].items():
        number = int(rname[5:])
        side_first = "CT" if rd["side"] == "ct-side" else "T"
        kills = defaultdict(int)
        for e in rd["events"]:
            title = e["title"]
            pair = next(((n, title[len(n) + 8:]) for n in nicks if title.startswith(n + " killed ") and title[len(n) + 8:] in pid), None)
            if pair and team_of.get(pair[0]) != team_of.get(pair[1]):
                kills[pair[0]] += 1
        for nick, p in pid.items():
            if nick not in team_of:
                continue
            side = side_first if team_of[nick] == first else ("T" if side_first == "CT" else "CT")
            rounds[(p, side)] += 1
            kills_in[(p, side)][kills[nick]] += 1
            swing_sum[(p, side)] += swing.get(p, {}).get(number, float("nan"))
    match = str(d["match"]["matchId"])
    out = []
    for (p, side), r in rows.items():
        n = rounds.get((p, side), 0)
        if n == 0:
            continue
        k = kills_in[(p, side)]
        out.append({
            "map": path.stem, "match": match, "event": event, "date": date.group(1) if date else "", "pid": p, "side": side,
            "rounds": n, "map_rounds": len(perf["rounds"]), "rating": r["rating"],
            "eKPR": r["ek"] / n, "eADR": r["eadr"], "eDPR": r["ed"] / n, "eKAST": r["ekast"], "Swing": swing_sum[(p, side)] / n,
            "K2": k[2] / n, "K3": k[3] / n, "K4": k[4] / n, "K5": sum(v for kk, v in k.items() if kk >= 5) / n,
        })
    return out


def side_rows(hltv: Path) -> list[dict]:
    rows = []
    for path in sorted(hltv.glob("map_*.json")):
        rows.extend(map_side_rows(path))
    rows = [r for r in rows if all(np.isfinite(r[f]) for f in (*CURVES, *KILL_ROUNDS, "rating"))]
    # a player-map counts only when its sides cover every round of the map
    cover = defaultdict(int)
    for r in rows:
        cover[(r["map"], r["pid"])] += r["rounds"]
    return [r for r in rows if cover[(r["map"], r["pid"])] == r["map_rounds"]]


def total_ratings(hltv: Path) -> dict:
    """(map, pid) -> HLTV's displayed total rating."""
    out = {}
    for path in sorted(hltv.glob("map_*.json")):
        d = json.loads(path.read_text(encoding="utf-8"))
        if d.get("v") != 3:
            continue
        for board in d["scoreboards"]:
            if "totalstats" in board["cls"].split():
                for r in board["rows"]:
                    out[(path.stem, r["pid"])] = _num(_cell(r["cells"], "st-rating", False))
    return out


def test_events(rows: list[dict], share: float = TEST_SHARE) -> set[str]:
    first, maps = {}, defaultdict(set)
    for r in rows:
        first[r["event"]] = min(first.get(r["event"], r["date"]), r["date"])
        maps[r["event"]].add(r["map"])
    total = len({r["map"] for r in rows})
    held, n = set(), 0
    for event in sorted(first, key=lambda e: (first[e], e), reverse=True):
        if n >= share * total:
            break
        held.add(event)
        n += len(maps[event])
    return held


def knots_of(rows: list[dict]) -> dict:
    return {f: [float(q) for q in np.quantile([r[f] for r in rows], KNOT_QUANTILES)] for f in CURVES}


def design(rows: list[dict], knots: dict) -> np.ndarray:
    cols = [np.ones(len(rows)), np.array([r["side"] == "CT" for r in rows], float)]
    for f in CURVES:
        x = np.array([r[f] for r in rows])
        cols.append(x)
        cols.extend(np.maximum(0.0, x - k) for k in knots[f])
    for f in KILL_ROUNDS:
        cols.append(np.array([r[f] for r in rows]))
    return np.column_stack(cols)


def fit(rows: list[dict]) -> dict:
    knots = knots_of(rows)
    x = design(rows, knots)
    w = np.sqrt([r["rounds"] for r in rows])
    b = np.linalg.lstsq(x * w[:, None], np.array([r["rating"] for r in rows]) * w, rcond=None)[0]
    model = {"intercept": float(b[0]), "ct_offset": float(b[1]), "curves": {}, "kill_rounds": {}}
    i = 2
    for f in CURVES:
        k = len(knots[f])
        model["curves"][f] = {"slope": float(b[i]), "knots": knots[f], "slope_changes": [float(v) for v in b[i + 1:i + 1 + k]]}
        i += 1 + k
    for f in KILL_ROUNDS:
        model["kill_rounds"][f] = float(b[i])
        i += 1
    return model


def curve(c: dict, x: float) -> float:
    return c["slope"] * x + sum(s * max(0.0, x - k) for k, s in zip(c["knots"], c["slope_changes"]))


def side_rating(model: dict, r: dict) -> float:
    v = model["intercept"] + (model["ct_offset"] if r["side"] == "CT" else 0.0)
    v += sum(curve(model["curves"][f], r[f]) for f in CURVES)
    return v + sum(model["kill_rounds"][f] * r[f] for f in KILL_ROUNDS)


def score(errors: list[float]) -> dict:
    e = np.abs(np.array(errors))
    return {"n": int(len(e)), "mae": float(e.mean()), "p95": float(np.quantile(e, 0.95)), "max": float(e.max()),
            "within_0_01": float((e <= 0.01 + 1e-9).mean())}


def total_errors(model: dict, rows: list[dict], totals: dict) -> list[float]:
    acc = defaultdict(lambda: [0.0, 0])
    for r in rows:
        a = acc[(r["map"], r["pid"])]
        a[0] += r["rounds"] * side_rating(model, r)
        a[1] += r["rounds"]
    return [s / n - totals[key] for key, (s, n) in acc.items() if key in totals and np.isfinite(totals[key])]


def fit_block(hltv: Path) -> dict:
    rows = side_rows(hltv)
    totals = total_ratings(hltv)
    held = test_events(rows)
    train = [r for r in rows if r["event"] not in held]
    test = [r for r in rows if r["event"] in held]
    held_model = fit(train)
    model = fit(rows)
    return {
        "model": model,
        "dataset": {"maps": len({r["map"] for r in rows}), "matches": len({r["match"] for r in rows}),
                    "player_maps": len({(r["map"], r["pid"]) for r in rows}), "side_rows": len(rows)},
        "held_out": {
            "split": f"by event and date: the latest events by first map date, {TEST_SHARE:.0%} of maps",
            "train_maps": len({r["map"] for r in train}), "test_maps": len({r["map"] for r in test}),
            "test_events": len(held), "test_dates": [min(r["date"] for r in test), max(r["date"] for r in test)],
            "train": score(total_errors(held_model, train, totals)),
            "test": score(total_errors(held_model, test, totals)),
        },
        "test_events": sorted(held),
    }
