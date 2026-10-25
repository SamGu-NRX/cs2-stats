"""Fit every public Rating 3 parameter block from explicit private inputs.

The command reads HLTV maps and the private strict-join result. It calls the
repository's Swing and duel fit functions, fits the rating approximation,
and writes only public constants and summary metadata. It does not read a
base parameter file and it never writes derived rows or the private lookup.

Run with isolated Python and explicit paths, for example:

    python -I fit_params.py --data DATA --hltv DATA/hltv \
        --joins DATA/model-rating3/demo_joins.json --out params.json
"""
from __future__ import annotations

import argparse
from datetime import date
import json
from pathlib import Path
import sys

import numpy as np
from sklearn.model_selection import GroupKFold

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eco_fit import fit_model as fit_duel_model
from swing_fit import fit_block as fit_swing_block


FEATURES = ("kpr_eco", "adr_eco", "dpr_eco", "kast_eco", "mk", "swing")
OUTPUT_FEATURES = ("eKPR", "eADR", "eDPR", "eKAST", "MK", "Swing")
INPUT_DEFINITIONS = {
    "eKPR": {
        "definition": "Eco-adjusted kills divided by played rounds",
        "unit": "kills per round",
    },
    "eADR": {
        "definition": "Eco-adjusted damage divided by played rounds",
        "unit": "HP per round",
    },
    "eDPR": {
        "definition": "Eco-adjusted deaths divided by played rounds",
        "unit": "deaths per round",
    },
    "eKAST": {
        "definition": "Eco-adjusted KAST percentage",
        "unit": "percent, 0-100",
    },
    "MK": {
        "definition": "Rounds in which the player made at least two kills",
        "unit": "percent of rounds, 0-100",
    },
    "Swing": {
        "definition": "Mean round swing credited to the player",
        "unit": "percentage points per round",
    },
}
PUBLISHED_CITATION = "HLTV Rating 3.02 methodology, October 2025 update"


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
        match_id = str(data.get("match", {}).get("matchId", ""))
        if not match_id:
            raise ValueError(f"{path.name}: missing match id")
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
                        "match": match_id,
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
    groups = np.array([row["match"] for row in rows])
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
        folds.append({
            "fold": fold,
            "rows": int(len(test)),
            "matches": int(len(set(groups[test]))),
            "score": score(y[test], fold_predicted),
        })
    held_out_predicted = np.empty(len(y), dtype=float)
    for train, test in splitter.split(x, y, groups):
        held_out_predicted[test] = predict(x[test], fit(x[train], y[train]))
    return {
        "coefficients": coefficients,
        "fit": score(y, predict(x, coefficients)),
        "held_out": score(y, held_out_predicted),
        "folds": folds,
        "matches": int(len(set(groups))),
    }


def readable_formula(rating: dict) -> str:
    expression = f"{rating['intercept']:.12f}"
    for name in rating["features"]:
        coefficient = rating["coefficients"][name]
        sign = "+" if coefficient >= 0 else "-"
        expression += f" {sign} {abs(coefficient):.12f}*{name}"
    return expression


def eco_adjustment_block(rows: list[dict], fit_date: str) -> dict:
    return {
        "source": {
            "source": "research",
            "script": "fit_params.py",
            "maps": len({row["map"] for row in rows}),
            "fit_date": fit_date,
        },
        "eKAST": {
            "status": "unresolved",
            "definition": "Eco-adjusted KAST percentage from the HLTV scoreboard",
            "unit": "percent, 0-100",
            "note": "A reduced-power winning-team transform is compatible with the observations, but no validated transform was fitted.",
            "citation": PUBLISHED_CITATION,
        },
        "map_features_available": ["eKPR", "eADR", "eDPR", "eKAST"],
        "eMK": {
            "status": "unavailable",
            "definition": "Eco-adjusted multi-kill percentage",
            "unit": "percent of rounds, 0-100",
            "note": "HLTV map cards do not expose eMK; the rating fit uses raw MK percent.",
        },
    }


def duel_block(duel: dict) -> dict:
    citation = PUBLISHED_CITATION
    duel["published_anchors"] = {
        "t_rifle_vs_ct_rifle": {"value": 0.48, "source": "published", "citation": citation},
        "t_rifle_vs_starter_pistol": {"value": 0.75, "source": "published", "citation": citation},
        "awp_vs_rifle_t": {"value": 0.56, "source": "published", "citation": citation},
        "awp_vs_rifle_ct": {"value": 0.60, "source": "published", "citation": citation},
    }
    duel["ct_edge_source"] = {
        "source": "published",
        "citation": citation,
        "derived_from": "t_rifle_vs_ct_rifle",
    }
    duel["fit_status"] = "strengths and kill-point scale fit by eco_fit.py; side edge and anchors are published"
    return duel


def win_probability_source_block() -> dict:
    return {
        "preferred": {
            "path": "%APPDATA%/BotMatchStats/packs/winprob-hltv.json",
            "label": "HLTV Rating 3.02 lookup, approximate",
            "source": "private_pack",
        },
        "fallback": {
            "path": "model/export/winprob.ts",
            "label": "CS2RB logistic model, approximate",
            "source": "model_export",
        },
    }


def public_parameters(
    output_path: Path,
    rows: list[dict],
    fit_result: dict,
    swing: dict,
    duel: dict,
    eco_adjustment: dict,
    joins: dict,
    fit_date: str,
) -> dict:
    coefficients = fit_result["coefficients"]
    map_count = len({row["map"] for row in rows})
    rating = {
        "version": "3.02",
        "status": "approximation",
        "basis": "plain_linear_displayed_eco_inputs",
        "features": list(OUTPUT_FEATURES),
        "inputs": INPUT_DEFINITIONS,
        "intercept": float(coefficients[0]),
        "coefficients": {
            name: float(coefficient)
            for name, coefficient in zip(OUTPUT_FEATURES, coefficients[1:])
        },
        "dataset": {
            "maps": map_count,
            "matches": fit_result["matches"],
            "player_maps": int(fit_result["fit"]["n"]),
            "date": fit_date,
            "rounds": "regulation_and_overtime",
        },
        "fit": {
            "method": "ordinary_least_squares",
            "held_out_split": "5-fold GroupKFold by match",
            "held_out_mae": fit_result["held_out"]["mae"],
            "held_out_p95": fit_result["held_out"]["p95"],
            "held_out_max": fit_result["held_out"]["max"],
            "held_out_r": fit_result["held_out"]["r"],
            "folds": fit_result["folds"],
        },
    }
    result = {
        "version": 1,
        "rating": rating,
        "dataset": {
            "hltv_maps": map_count,
            "matches": fit_result["matches"],
            "player_maps": int(fit_result["fit"]["n"]),
            "fit_date": fit_date,
            "rounds": "regulation_and_overtime",
        },
        "swing": swing,
        "duel": duel_block(duel),
        "ecoAdjustment": eco_adjustment,
        "winProbabilitySource": win_probability_source_block(),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path, help="Private data root containing hltv/ and demos/")
    parser.add_argument("--hltv", required=True, type=Path)
    parser.add_argument("--joins", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--date", default=date.today().isoformat(), help="Fit date stored in metadata (YYYY-MM-DD)")
    args = parser.parse_args()

    rows = map_rows(args.hltv)
    if not rows:
        raise ValueError(f"no v3 HLTV map rows found in {args.hltv}")
    x, y, groups = design(rows)
    if len(set(groups)) < 5:
        raise ValueError("at least five match groups are required for held-out evaluation")
    fit_result = fit_summary(x, y, groups)
    joins = json.loads(args.joins.read_text(encoding="utf-8"))
    swing = fit_swing_block(args.data, args.joins)
    duel = fit_duel_model(args.data, joins["accepted"])
    eco_adjustment = eco_adjustment_block(rows, args.date)
    parameters = public_parameters(args.out, rows, fit_result, swing, duel, eco_adjustment, joins, args.date)
    print(json.dumps({
        "formula": readable_formula(parameters["rating"]),
        "dataset": parameters["dataset"],
        "held_out": parameters["rating"]["fit"],
        "swing_flash_credit_fraction": parameters["swing"]["flash_credit_fraction"],
        "duel": {
            "strength": parameters["duel"]["strength"],
            "kill_points_scale": parameters["duel"]["kill_points_scale"],
            "objective_mae": parameters["duel"]["objective_mae"],
        },
    }, indent=2))


if __name__ == "__main__":
    main()
