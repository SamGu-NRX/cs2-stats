"""Fit every public Rating 3 parameter block from explicit private inputs.

The command reads HLTV maps, the private strict-join result and the engine's
rating dump (app: pnpm rating-dump). It fits the per-side rating
(side_rating_fit.py), the swing credit weights (swing_credit_fit.py) and the
duel block (eco_fit.py), and writes only public constants and summary
metadata. It does not read a base parameter file and it never writes derived
rows or the private lookup.

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


sys.path.insert(0, str(Path(__file__).resolve().parent))
from eco_fit import fit_model as fit_duel_model
from hltv_pages import hltv_pages
from side_rating_fit import fit_block as fit_side_block
from swing_credit_fit import fit_block as fit_swing_credit
sys.path.append(str(Path(__file__).resolve().parents[2] / "extractor"))
from repo_guard import check_output, write_json  # noqa: E402  (extractor/repo_guard.py: where outputs may land)

# the one place params.json may take in the repository (the app reads it from here)
PARAMS_PATH = Path(__file__).resolve().parent / "params.json"


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
    "K2": {"definition": "Rounds with exactly two kills", "unit": "share of the side's rounds, 0-1"},
    "K3": {"definition": "Rounds with exactly three kills", "unit": "share of the side's rounds, 0-1"},
    "K4": {"definition": "Rounds with exactly four kills", "unit": "share of the side's rounds, 0-1"},
    "K5": {"definition": "Rounds with five kills", "unit": "share of the side's rounds, 0-1"},
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
    for path in hltv_pages(root):
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


def readable_formula(rating: dict) -> str:
    curves = ", ".join(f"{name} (slope {c['slope']:.4f}, {len(c['knots'])} knots)" for name, c in rating["curves"].items())
    kills = ", ".join(f"{name} {w:.4f}" for name, w in rating["kill_rounds"].items())
    return (f"side rating = {rating['intercept']:.4f} + {rating['ct_offset']:.4f}*[CT] + curves: {curves}; "
            f"kill rounds: {kills}; total = round-weighted mean of the sides")


def public_parameters(
    output_path: Path,
    side: dict,
    swing: dict,
    duel: dict,
    eco_adjustment: dict,
    fit_date: str,
) -> dict:
    model, held = side["model"], side["held_out"]
    rating = {
        "version": "3.02",
        "status": "approximation",
        "basis": "per_side_piecewise_linear",
        "inputs": INPUT_DEFINITIONS,
        "intercept": model["intercept"],
        "ct_offset": model["ct_offset"],
        "curves": model["curves"],
        "kill_rounds": model["kill_rounds"],
        "dataset": {**side["dataset"], "date": fit_date, "rounds": "regulation_and_overtime"},
        "fit": {
            "method": "weighted_least_squares_per_side",
            "held_out_split": held["split"],
            "held_out_train_maps": held["train_maps"],
            "held_out_test_maps": held["test_maps"],
            "held_out_test_events": held["test_events"],
            "held_out_test_dates": held["test_dates"],
            "train_mae": held["train"]["mae"],
            "held_out_mae": held["test"]["mae"],
            "held_out_p95": held["test"]["p95"],
            "held_out_max": held["test"]["max"],
            "held_out_within_0_01": held["test"]["within_0_01"],
        },
    }
    result = {
        "version": 1,
        "rating": rating,
        "dataset": {
            "hltv_maps": side["dataset"]["maps"],
            "matches": side["dataset"]["matches"],
            "player_maps": side["dataset"]["player_maps"],
            "fit_date": fit_date,
            "rounds": "regulation_and_overtime",
        },
        "swing": swing,
        "duel": duel_block(duel),
        "ecoAdjustment": eco_adjustment,
        "winProbabilitySource": win_probability_source_block(),
    }
    # aggregate coefficients with no names, ids or rows: public, and in the repository only at its own path
    write_json(output_path, result, private=False, what="params.json", in_repo=PARAMS_PATH, indent=2)
    return result


def swing_block(data: Path) -> dict:
    credit = fit_swing_credit(data)
    fit = credit.pop("fit")
    gain = fit["gain"]
    return {
        "source": {"source": "fit", "script": "swing_credit_fit.py", "kills": fit["kills"],
                   "gain_credits": gain["credits"], "gain_within_0_01": gain["within_0_01"], "gain_mae_points": gain["mae_points"],
                   "flash_observations": fit["flash"]["observations"], "failed_trade_observations": fit["debit"]["observations"]},
        "event_credit_model": "weighted_damage_kill_trade_flash",
        # the trade-denial window scoreboard.ts reads; the credit weights carry their own window
        "trade_window_seconds": 5.0,
        "event_credit": credit,
        "zero_rules": [
            "unpreventable post-bomb kills have zero swing",
            "kill credit is never negative",
            "round with an unvalued probability event is unknown",
            "unattributed, health-reconstructed, or ambiguous damage rows carry no damage weight",
        ],
        "fit_status": "kill shares fitted to HLTV per-kill credits; the winners' split of a detonation or time-out is not recovered",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path, help="Private data root containing hltv/, demos/ and model-rating3/")
    parser.add_argument("--hltv", required=True, type=Path)
    parser.add_argument("--joins", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--date", default=date.today().isoformat(), help="Fit date stored in metadata (YYYY-MM-DD)")
    args = parser.parse_args()
    check_output(args.out, private=False, what="params.json", in_repo=PARAMS_PATH)

    side = fit_side_block(args.hltv)
    joins = json.loads(args.joins.read_text(encoding="utf-8"))
    swing = swing_block(args.data)
    duel = fit_duel_model(args.data, joins["accepted"])
    eco_adjustment = eco_adjustment_block(map_rows(args.hltv), args.date)
    parameters = public_parameters(args.out, side, swing, duel, eco_adjustment, args.date)
    print(json.dumps({
        "formula": readable_formula(parameters["rating"]),
        "dataset": parameters["dataset"],
        "fit": parameters["rating"]["fit"],
        "swing_event_credit": parameters["swing"]["event_credit"],
        "duel": {
            "strength": parameters["duel"]["strength"],
            "kill_points_scale": parameters["duel"]["kill_points_scale"],
            "objective_mae": parameters["duel"]["objective_mae"],
        },
    }, indent=2))


if __name__ == "__main__":
    main()
