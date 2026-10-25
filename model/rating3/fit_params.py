"""Fit the shipped Rating 3.02 approximation and write public parameters.

The input is an explicit directory of v3 HLTV map files. The base parameter
file supplies the published swing, duel, and economy blocks; this command
recomputes the rating block and dataset metadata, then writes only those
shipped blocks. It never writes HLTV-derived rows, identities, or the private
win-probability lookup.

Run with the repository's model virtual environment and Python isolated mode,
for example:

    python -I fit_params.py --hltv DATA/hltv --base params.json --out params.json
"""
from __future__ import annotations

import argparse
from datetime import date
import json
from pathlib import Path

import numpy as np
from sklearn.model_selection import GroupKFold


FEATURES = ("kpr_eco", "adr_eco", "dpr_eco", "kast_eco", "mk", "swing")
OUTPUT_FEATURES = ("eKPR", "eADR", "eDPR", "eKAST", "MK", "Swing")


def num(value: str) -> float:
    value = value.replace("%", "").replace("+", "").strip()
    return float("nan") if value in {"", "-", "N/A"} else float(value)


def rounds_in(data: dict) -> int:
    """Return played regulation and overtime rounds in the performance graph."""
    return len(data.get("performance", {}).get("rounds", {}))


def parse_kd(value: str) -> tuple[float, float]:
    left = value.split("(", 1)[0].strip().replace(":", " ").split()
    if not left:
        return float("nan"), float("nan")
    return float(left[0]), float(left[1]) if len(left) > 1 else float(left[0])


def map_rows(root: Path) -> list[dict]:
    """Read displayed total scoreboard values from v3 HLTV map files."""
    rows = []
    for path in sorted(root.glob("map_*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("v") != 3:
            continue
        nrounds = rounds_in(data)
        if nrounds <= 0:
            continue
        for board in data["scoreboards"]:
            if "totalstats" not in board["cls"].split():
                continue
            for row in board["rows"]:
                def get(prefix: str, eco: bool = False) -> str:
                    for cell in row["cells"]:
                        classes, value = cell
                        if prefix in classes and ("eco-adjusted-data" in classes) == eco:
                            return value
                    raise KeyError(f"{path.name}: missing {prefix} eco={eco}")

                kills, _ = parse_kd(get("st-kills"))
                eco_kills, _ = parse_kd(get("st-kills", True))
                deaths, _ = parse_kd(get("st-deaths"))
                eco_deaths, _ = parse_kd(get("st-deaths", True))
                rows.append(
                    {
                        "map": path.stem,
                        "rating": num(get("st-rating")),
                        "kpr_eco": eco_kills / nrounds,
                        "adr_eco": num(get("st-adr", True)),
                        "dpr_eco": eco_deaths / nrounds,
                        "kast_eco": num(get("st-kast", True)),
                        "mk": 100 * num(get("st-mks")) / nrounds,
                        "swing": num(get("st-roundSwing")),
                        "_raw_kpr": kills / nrounds,
                        "_raw_dpr": deaths / nrounds,
                    }
                )
    return rows


def design(rows: list[dict]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    x = np.array([[row[field] for field in FEATURES] for row in rows], dtype=float)
    y = np.array([row["rating"] for row in rows], dtype=float)
    groups = np.array([row["map"] for row in rows])
    valid = np.isfinite(x).all(axis=1) & np.isfinite(y)
    return x[valid], y[valid], groups[valid]


def fit(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    matrix = np.column_stack((np.ones(len(x)), x))
    return np.linalg.lstsq(matrix, y, rcond=None)[0]


def predict(x: np.ndarray, coefficients: np.ndarray) -> np.ndarray:
    return np.column_stack((np.ones(len(x)), x)) @ coefficients


def score(y: np.ndarray, predicted: np.ndarray) -> dict:
    error = np.abs(y - predicted)
    return {
        "n": int(len(error)),
        "mae": float(error.mean()),
        "p95": float(np.quantile(error, 0.95)),
        "max": float(error.max()),
        "r": float(np.corrcoef(y, predicted)[0, 1]),
    }


def fit_summary(x: np.ndarray, y: np.ndarray, groups: np.ndarray) -> dict:
    coefficients = fit(x, y)
    folds = []
    splitter = GroupKFold(n_splits=5)
    for fold, (train, test) in enumerate(splitter.split(x, y, groups), start=1):
        fold_predicted = predict(x[test], fit(x[train], y[train]))
        folds.append({"fold": fold, "rows": int(len(test)), "maps": int(len(set(groups[test]))), "score": score(y[test], fold_predicted)})
    held_out_predicted = np.empty(len(y), dtype=float)
    for train, test in splitter.split(x, y, groups):
        held_out_predicted[test] = predict(x[test], fit(x[train], y[train]))
    held_out = score(y, held_out_predicted)
    return {"coefficients": coefficients, "fit": score(y, predict(x, coefficients)), "held_out": held_out, "folds": folds}


def formula(coefficients: np.ndarray) -> str:
    expression = f"{coefficients[0]:.12f}"
    for coefficient, name in zip(coefficients[1:], OUTPUT_FEATURES):
        sign = "+" if coefficient >= 0 else "-"
        expression += f" {sign} {abs(coefficient):.12f}*{name}"
    return expression


def public_parameters(base_path: Path, output_path: Path, rows: list[dict], fit_result: dict, fit_date: str) -> dict:
    base = json.loads(base_path.read_text(encoding="utf-8"))
    required = ("swing", "duel", "ecoAdjustment")
    missing = [key for key in required if key not in base]
    if missing:
        raise ValueError(f"base parameter file is missing shipped blocks: {', '.join(missing)}")

    coefficients = fit_result["coefficients"]
    map_count = len({row["map"] for row in rows})
    result = {
        "version": base.get("version", 1),
        "rating": {
            "version": "3.02",
            "status": "approximation",
            "basis": "plain_linear_displayed_eco_inputs",
            "formula": formula(coefficients),
            "features": list(OUTPUT_FEATURES),
            "intercept": float(coefficients[0]),
            "coefficients": {
                name: float(coefficient)
                for name, coefficient in zip(OUTPUT_FEATURES, coefficients[1:])
            },
            "dataset": {
                "maps": map_count,
                "player_maps": int(fit_result["fit"]["n"]),
                "date": fit_date,
                "rounds": "regulation_and_overtime",
            },
            "fit": {
                "method": "ordinary_least_squares",
                "held_out_split": "5-fold GroupKFold by map",
                "held_out_mae": fit_result["held_out"]["mae"],
                "held_out_p95": fit_result["held_out"]["p95"],
                "held_out_max": fit_result["held_out"]["max"],
                "held_out_r": fit_result["held_out"]["r"],
                "folds": fit_result["folds"],
            },
        },
        "dataset": {
            "hltv_maps": map_count,
            "player_maps": int(fit_result["fit"]["n"]),
            "fit_date": fit_date,
            "rounds": "regulation_and_overtime",
        },
        "swing": base["swing"],
        "duel": base["duel"],
        "ecoAdjustment": base["ecoAdjustment"],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hltv", required=True, type=Path)
    parser.add_argument("--base", type=Path, help="Existing params.json supplying non-rating shipped blocks")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--date", default=date.today().isoformat(), help="Fit date stored in metadata (YYYY-MM-DD)")
    args = parser.parse_args()
    base_path = args.base or args.out
    if not base_path.exists():
        raise FileNotFoundError(f"base parameter file does not exist: {base_path}")
    rows = map_rows(args.hltv)
    if not rows:
        raise ValueError(f"no v3 HLTV map rows found in {args.hltv}")
    x, y, groups = design(rows)
    if len(set(groups)) < 5:
        raise ValueError("at least five map groups are required for held-out evaluation")
    result = fit_summary(x, y, groups)
    parameters = public_parameters(base_path, args.out, rows, result, args.date)
    print(json.dumps({
        "formula": parameters["rating"]["formula"],
        "maps": parameters["dataset"]["hltv_maps"],
        "player_maps": parameters["dataset"]["player_maps"],
        "held_out": parameters["rating"]["fit"],
    }, indent=2))


if __name__ == "__main__":
    main()
