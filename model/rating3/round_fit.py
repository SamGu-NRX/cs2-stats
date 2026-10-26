"""Fit a per-round Rating 3 reference model against total, CT, and T tables."""
from __future__ import annotations

import argparse
import json
import re
import runpy
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares
import sys
sys.path.append(str(Path(__file__).resolve().parents[2] / "extractor"))
from repo_guard import check_output, write_json  # noqa: E402  (extractor/repo_guard.py: where outputs may land)

BUY_ORDER = ("PISTOL", "ECO", "HALF", "FULL")
END_ICONS = {"bomb_exploded.svg", "bomb_defused.svg", "stopwatch.svg"}


def number(value: str) -> float:
    return float(str(value).replace("%", "").replace("+", "").strip())


def kd(value: str) -> tuple[float, float]:
    left = str(value).split("(", 1)[0].replace(":", " ").split()
    return float(left[0]), float(left[1]) if len(left) > 1 else 0.0


def normalize(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(name).lower())


def parse_rounds(info: str) -> tuple[int, int, int]:
    match = re.search(r"(\d+) : (\d+) \(\s*(\d+) : (\d+)\s*\)\s*\(\s*(\d+) : (\d+)\s*\)", info)
    if not match:
        raise ValueError(f"cannot parse map score {info!r}")
    total_a, total_b, half_a, half_b, other_a, other_b = map(int, match.groups())
    return total_a + total_b, half_a + half_b, other_a + other_b


def cell(row: dict, prefix: str) -> str:
    for classes, value in row["cells"]:
        if prefix in classes:
            return value
    raise KeyError(prefix)


def side_tables(data: dict) -> tuple[dict[str, dict], dict[str, int]]:
    total = [b for b in data["scoreboards"] if "totalstats" in b["cls"].split()]
    ct = [b for b in data["scoreboards"] if "ctstats" in b["cls"].split()]
    tt = [b for b in data["scoreboards"] if "tstats" in b["cls"].split()]
    if len(total) != 2 or len(ct) != 2 or len(tt) != 2:
        raise ValueError("expected two total, CT, and T tables")
    targets = {}
    team_of = {}
    for team, board in enumerate(total):
        for row in board["rows"]:
            pid = str(row["pid"])
            team_of[pid] = team
            targets[pid] = {
                "total": number(cell(row, "st-rating")),
            }
    for side_name, boards in (("ct", ct), ("t", tt)):
        for board in boards:
            for row in board["rows"]:
                targets[str(row["pid"])][side_name] = number(cell(row, "st-rating"))
    if any(set(v) != {"total", "ct", "t"} for v in targets.values()):
        raise ValueError("incomplete side rating target")
    return targets, team_of


def round_buy(data: dict, round_name: str, team_of: dict[str, int]) -> tuple[str, str]:
    players = data["performance"]["players"]
    team_one = {pid for pid, team in team_of.items() if team == 0}
    texts = [p["events"][round_name][0][1] for p in players
             if round_name in p.get("events", {}) and str(p["pid"]) in team_one]
    if not texts or len(set(texts)) != 1:
        raise ValueError("inconsistent round equipment tooltip")
    economy = re.findall(r"\$([\d.]+)(K?)\s*\(([^)]+)\)", texts[0])
    if len(economy) != 2:
        raise ValueError(f"cannot parse equipment tooltip {texts[0]!r}")
    return economy[0][2], economy[1][2]


def parse_events(events: list[dict]) -> tuple[dict[str, int], set[str], dict[str, int]]:
    kills = defaultdict(int)
    dead = set()
    multi = defaultdict(int)
    for event in events:
        if " killed " not in event["title"]:
            continue
        attacker, victim = map(normalize, event["title"].split(" killed ", 1))
        kills[attacker] += 1
        multi[attacker] += 1
        dead.add(victim)
    return dict(kills), dead, dict(multi)


def basis(kills: int, died: bool, swing: float, buy: str) -> np.ndarray:
    # The nonlinear terms are per-round indicators, not map-level aggregates.
    k = min(kills, 4)
    return np.array([
        1.0,
        float(k == 0), float(k == 1), float(k == 2), float(k >= 3),
        float(died), float(not died),
        float(k > 0 or not died), float(k >= 2),
        swing,
        swing * float(buy == "FULL"), swing * float(buy == "PISTOL"),
        float(buy == "PISTOL"), float(buy == "ECO"),
        float(buy == "HALF"), float(buy == "FULL"),
        swing * swing, swing * swing * swing,
        swing * float(k > 0), swing * float(died), swing * float(not died),
        float(k > 0) * float(died), float(k >= 2) * float(died),
        float(k == 1) * float(buy == "PISTOL"),
        float(k >= 2) * float(buy == "FULL"),
    ])


def load(root: Path) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    designs = []
    targets = []
    meta = []
    for path in sorted(root.glob("map_*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("v") != 3:
            continue
        try:
            total_rounds, first_half, second_half = parse_rounds(data["info"][1])
            target, team_of = side_tables(data)
        except (KeyError, ValueError):
            continue
        performance = data["performance"]
        players = {str(p["pid"]): p for p in performance["players"]}
        names = {pid: normalize(p["nick"]) for pid, p in players.items()}
        name_to_pid = {name: pid for pid, name in names.items()}
        per_player = defaultdict(list)
        round_side = {}
        for round_name, rd in performance["rounds"].items():
            round_number = round_name[5:]
            try:
                team_buys = round_buy(data, round_name, team_of)
            except ValueError:
                continue
            kills, dead_names, _ = parse_events(rd["events"])
            first_side = "t" if rd["side"] == "t-side" else "ct"
            for pid, player in players.items():
                per_round = dict(player.get("perRound", []))
                if pid not in target or round_number not in per_round:
                    continue
                team = team_of.get(pid)
                if team is None:
                    continue
                side = first_side if team == 0 else ("ct" if first_side == "t" else "t")
                buy = team_buys[0 if team == 0 else 1]
                if buy not in BUY_ORDER:
                    buy = "FULL"
                name = names[pid]
                swing = number(per_round[round_number])
                per_player[pid].append((side, basis(kills.get(name, 0), name in dead_names, swing, buy)))
        for pid, rounds in per_player.items():
            if not rounds or pid not in target:
                continue
            all_x = np.mean([x for _, x in rounds], axis=0)
            ct_x = [x for side, x in rounds if side == "ct"]
            t_x = [x for side, x in rounds if side == "t"]
            if not ct_x or not t_x:
                continue
            designs.extend([all_x, np.mean(ct_x, axis=0), np.mean(t_x, axis=0)])
            targets.extend([target[pid]["total"], target[pid]["ct"], target[pid]["t"]])
            meta.append({"map": path.stem, "pid": pid, "rounds": len(rounds),
                         "ct_rounds": len(ct_x), "t_rounds": len(t_x),
                         "target": target[pid]})
    return np.asarray(designs), np.asarray(targets), meta


def score(actual: np.ndarray, predicted: np.ndarray) -> dict:
    error = np.abs(actual - predicted)
    return {"n": int(len(error)), "mae": float(error.mean()),
            "p95": float(np.quantile(error, .95)), "max": float(error.max()),
            "r": float(np.corrcoef(actual, predicted)[0, 1])}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hltv", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    # private: built from HLTV rows and pro demos; checked before any data is read
    check_output(args.out, private=True, what="the round fit report")
    runpy.run_path(str(Path(__file__).with_name("winprob_fit.py")))["idle"]()
    X, y, meta = load(args.hltv)
    fit = np.linalg.lstsq(X, y, rcond=None)[0]
    pred = X @ fit
    result = {"basis": "per_round_event_features", "features": int(X.shape[1]),
              "rows": int(len(y)), "fit": score(y, pred),
              "coefficients": fit.tolist(), "note": "research fit; damage, assists, and exact eco adjustment remain open"}
    write_json(args.out, result, private=True, what="the round fit report", indent=2)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
