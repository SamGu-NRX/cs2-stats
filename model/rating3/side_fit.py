"""Fit CT and T Rating 3 targets from side-specific scoreboard aggregates."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np
import sys
sys.path.append(str(Path(__file__).resolve().parents[2] / "extractor"))
from repo_guard import check_output, write_json  # noqa: E402  (extractor/repo_guard.py: where outputs may land)

FEATURES = ("eKPR", "eADR", "eDPR", "eKAST", "MK", "Swing")


def number(value: str) -> float:
    text = str(value).replace("%", "").replace("+", "").strip()
    return float("nan") if text in {"", "-", "N/A"} else float(text)


def kd(value: str) -> tuple[int, int]:
    left = str(value).split("(", 1)[0].replace(":", " ").split()
    return int(left[0]), int(left[1]) if len(left) > 1 else 0


def parse_rounds(info: str) -> tuple[int, int, int]:
    match = re.search(r"(\d+) : (\d+) \(\s*(\d+) : (\d+)\s*\)\s*\(\s*(\d+) : (\d+)\s*\)", info)
    if not match:
        raise ValueError(f"cannot parse map score {info!r}")
    total_a, total_b, half_a, half_b, other_a, other_b = map(int, match.groups())
    return total_a + total_b, half_a + half_b, other_a + other_b


def cell(row: dict, prefix: str, eco: bool = False) -> str:
    for classes, value in row["cells"]:
        if prefix in classes and ("eco-adjusted-data" in classes) == eco:
            return value
    raise KeyError((prefix, eco))


def side_tables(data: dict) -> tuple[list[dict], list[dict], list[dict], dict[str, int]]:
    total = [b for b in data["scoreboards"] if "totalstats" in b["cls"].split()]
    ct = [b for b in data["scoreboards"] if "ctstats" in b["cls"].split()]
    t = [b for b in data["scoreboards"] if "tstats" in b["cls"].split()]
    if len(total) != 2 or len(ct) != 2 or len(t) != 2:
        raise ValueError("expected two total, CT, and T tables")
    team_of = {str(row["pid"]): team for team, board in enumerate(total) for row in board["rows"]}
    return total, ct, t, team_of


ICON_SIDE = {
    "t_win.svg": "t",
    "bomb_exploded.svg": "t",
    "ct_win.svg": "ct",
    "bomb_defused.svg": "ct",
    "stopwatch.svg": "ct",
}
EMPTY_HISTORY = "emptyHistory.svg"


def round_history_side_counts(data: dict, map_name: str) -> dict[int, dict[str, int]]:
    history = data.get("roundHistory")
    if not isinstance(history, list) or not history:
        raise ValueError(f"{map_name}: expected roundHistory team entries")
    team_order: list[str] = []
    outcomes_by_team: dict[str, list[str]] = {}
    for entry in history:
        team_name = entry.get("team")
        team_outcomes = entry.get("outcomes")
        if not isinstance(team_name, str) or not isinstance(team_outcomes, list):
            raise ValueError(f"{map_name}: malformed roundHistory entry")
        if team_name not in outcomes_by_team:
            team_order.append(team_name)
            outcomes_by_team[team_name] = []
        outcomes_by_team[team_name].extend(team_outcomes)
    if len(team_order) != 2:
        raise ValueError(f"{map_name}: expected two distinct roundHistory teams")
    outcomes = [outcomes_by_team[team] for team in team_order]
    if len(outcomes[0]) != len(outcomes[1]):
        raise ValueError(f"{map_name}: roundHistory outcome lengths differ")

    assignments: list[tuple[str, str]] = []
    finished = False
    for round_index, (first, second) in enumerate(zip(*outcomes), start=1):
        first_icon = str(first).split("|", 1)[0]
        second_icon = str(second).split("|", 1)[0]
        if first_icon == EMPTY_HISTORY and second_icon == EMPTY_HISTORY:
            finished = True
            continue
        if finished:
            raise ValueError(f"{map_name}: non-empty roundHistory after round {round_index - 1}")
        first_side = ICON_SIDE.get(first_icon)
        second_side = ICON_SIDE.get(second_icon)
        if first_icon != EMPTY_HISTORY and first_side is None:
            raise ValueError(f"{map_name}: unknown roundHistory icon {first_icon!r} in team 0")
        if second_icon != EMPTY_HISTORY and second_side is None:
            raise ValueError(f"{map_name}: unknown roundHistory icon {second_icon!r} in team 1")
        if first_icon == EMPTY_HISTORY and second_icon == EMPTY_HISTORY:
            raise ValueError(f"{map_name}: completed round {round_index} has two empty outcomes")
        if first_icon != EMPTY_HISTORY and second_icon != EMPTY_HISTORY:
            raise ValueError(f"{map_name}: completed round {round_index} has two winners")
        if first_side is None:
            first_side = "ct" if second_side == "t" else "t"
        if second_side is None:
            second_side = "ct" if first_side == "t" else "t"
        if first_side == second_side:
            raise ValueError(f"{map_name}: round {round_index} assigns both teams to {first_side}")
        assignments.append((first_side, second_side))

    if not assignments:
        raise ValueError(f"{map_name}: roundHistory contains no completed rounds")

    blocks = [(0, 12), (12, 24)]
    blocks.extend((start, start + 3) for start in range(24, len(assignments), 3))
    for start, end in blocks:
        block = assignments[start:end]
        if not block:
            continue
        for team in (0, 1):
            sides = {round_sides[team] for round_sides in block}
            if len(sides) != 1:
                phase = "regulation" if start < 24 else "overtime"
                raise ValueError(
                    f"{map_name}: team {team} changes side within {phase} block "
                    f"rounds {start + 1}-{min(end, len(assignments))}"
                )

    counts = {team: {"ct": 0, "t": 0} for team in (0, 1)}
    for first_side, second_side in assignments:
        counts[0][first_side] += 1
        counts[1][second_side] += 1
    return counts


def rows(root: Path) -> list[dict]:
    result = []
    for path in sorted(root.glob("map_*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("v") != 3:
            continue
        if not data.get("roundHistory"):
            continue
        counts = round_history_side_counts(data, path.stem)
        if len(data.get("performance", {}).get("rounds", {})) > 24:
            continue
        try:
            total_rounds, _, _ = parse_rounds(data["info"][1])
            total, ct, t, _ = side_tables(data)
        except (KeyError, ValueError):
            continue
        for team, board in enumerate(total):
            side_rows = {
                "ct": {str(row["pid"]): row for row in ct[team]["rows"]},
                "t": {str(row["pid"]): row for row in t[team]["rows"]},
            }
            for row in board["rows"]:
                pid = str(row["pid"])
                for side in ("ct", "t"):
                    n = counts[team][side]
                    if n <= 0 or pid not in side_rows[side]:
                        continue
                    side_row = side_rows[side][pid]
                    e_k, _ = kd(cell(side_row, "st-kills", True))
                    e_d, _ = kd(cell(side_row, "st-deaths", True))
                    result.append({
                        "map": path.stem,
                        "pid": pid,
                        "side": side,
                        "rounds": n,
                        "map_rounds": total_rounds,
                        "eKPR": e_k / n,
                        "eADR": number(cell(side_row, "st-adr", True)),
                        "eDPR": e_d / n,
                        "eKAST": number(cell(side_row, "st-kast", True)),
                        "MK": 100 * number(cell(side_row, "st-mks")) / n,
                        "Swing": number(cell(side_row, "st-roundSwing")),
                        "rating": number(cell(side_row, "st-rating")),
                    })
    return result


def score(actual: np.ndarray, predicted: np.ndarray) -> dict:
    error = np.abs(actual - predicted)
    return {"n": int(len(error)), "mae": float(error.mean()),
            "p95": float(np.quantile(error, .95)), "max": float(error.max()),
            "r": float(np.corrcoef(actual, predicted)[0, 1])}


def fit_group(group: list[dict], ratio: bool) -> dict:
    x = np.array([[row[f] for f in FEATURES] for row in group], dtype=float)
    y = np.array([row["rating"] for row in group], dtype=float)
    valid = np.isfinite(x).all(axis=1) & np.isfinite(y)
    x, y = x[valid], y[valid]
    means = x.mean(axis=0)
    if ratio:
        x = x / means
    design = np.column_stack([np.ones(len(x)), x])
    coefficients = np.linalg.lstsq(design, y, rcond=None)[0]
    return {"rows": len(group), "means": dict(zip(FEATURES, means.tolist())),
            "coefficients": coefficients.tolist(), "fit": score(y, design @ coefficients)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hltv", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    # private: built from HLTV rows and pro demos; checked before any data is read
    check_output(args.out, private=True, what="the side fit report")
    data = rows(args.hltv)
    result = {"features": FEATURES, "target_floor": {"mae": 0.0025, "max": 0.005}, "groups": {}}
    for side in ("ct", "t"):
        group = [row for row in data if row["side"] == side]
        result["groups"][side] = {"linear": fit_group(group, False), "ratio_to_side_mean": fit_group(group, True)}
    result["maps"] = len({row["map"] for row in data})
    result["rows"] = len(data)
    result["regulation_only"] = True
    write_json(args.out, result, private=True, what="the side fit report", indent=2)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
