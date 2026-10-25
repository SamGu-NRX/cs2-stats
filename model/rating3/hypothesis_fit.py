"""Held-out structural tests for the HLTV Rating 3.02 map formula."""
from __future__ import annotations

import argparse
import json
import re
import runpy
from collections import defaultdict
from pathlib import Path

import numpy as np
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.model_selection import GridSearchCV, GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler


BUY_LABELS = {"PISTOL", "ECO", "HALF", "FULL"}
EMPTY_HISTORY = "emptyHistory.svg"
FEATURES = (
    "ekpr", "eadr", "edpr", "ekast", "mk", "swing",
    "kpr", "adr", "dpr", "kast", "hspr", "assists_pr", "flash_assists_pr",
    "traded_dpr", "opening_kpr", "opening_dpr", "clutch_pr", "hs_rate",
    "win_rate", "raw_kills_won_pr", "raw_kills_lost_pr",
    "raw_deaths_won_pr", "raw_deaths_lost_pr",
    "survival_won_pr", "survival_lost_pr", "proxy_kast_won_pr", "proxy_kast_lost_pr",
    "swing_won", "swing_lost", "swing_diff",
    "ekast_x_win", "ekast_x_loss", "mk_x_win", "mk_x_loss",
    "logit_ekast", "sqrt_ekast", "op_diff",
)
BASE = ("ekpr", "eadr", "edpr", "ekast", "mk", "swing")
SIDE_FEATURES = tuple(
    f"{side}_{feature}"
    for side in ("ct", "t")
    for feature in ("ekpr", "eadr", "edpr", "ekast", "mk", "swing")
) + ("ct_fraction",)


def normalize(value: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def number(value: object) -> float:
    text = str(value).replace("%", "").replace("+", "").strip()
    if text in {"", "-", "N/A", "None"}:
        return float("nan")
    return float(text)


def pair(value: object) -> tuple[float, float]:
    text = str(value)
    left = text.split("(", 1)[0].replace(":", " ").split()
    if not left:
        return float("nan"), float("nan")
    parenthetical = text.split("(", 1)[1].split(")", 1)[0] if "(" in text else ""
    right = parenthetical.replace(":", " ").split()
    if right:
        return float(left[0]), float(right[0])
    return float(left[0]), float(left[1]) if len(left) > 1 else 0.0


def cell(row: dict, prefix: str, eco: bool = False) -> str:
    for classes, value in row["cells"]:
        tokens = set(str(classes).split())
        if prefix in tokens and ("eco-adjusted-data" in tokens) == eco:
            return value
    raise KeyError((prefix, eco))


def boards(data: dict, token: str) -> list[dict]:
    return [board for board in data["scoreboards"] if token in board["cls"].split()]


def round_assignments(data: dict) -> tuple[list[int], dict[int, str], dict[int, str]]:
    """Return winner team, team-0 side, and round name for played rounds."""
    outcomes_by_team: dict[str, list[str]] = {}
    team_order: list[str] = []
    for entry in data.get("roundHistory", []):
        team = str(entry.get("team", ""))
        if team not in outcomes_by_team:
            team_order.append(team)
            outcomes_by_team[team] = []
        outcomes_by_team[team].extend(entry.get("outcomes", []))
    if len(team_order) != 2:
        raise ValueError("roundHistory does not contain two teams")
    rounds = sorted(
        data.get("performance", {}).get("rounds", {}).items(),
        key=lambda item: int(str(item[0]).removeprefix("round")),
    )
    winners: list[int] = []
    sides: dict[int, str] = {}
    names: dict[int, str] = {}
    for round_name, round_data in rounds:
        number = int(str(round_name).removeprefix("round"))
        first = str(outcomes_by_team[team_order[0]][number - 1]).split("|", 1)[0]
        second = str(outcomes_by_team[team_order[1]][number - 1]).split("|", 1)[0]
        if first != EMPTY_HISTORY and second == EMPTY_HISTORY:
            winner = 0
        elif second != EMPTY_HISTORY and first == EMPTY_HISTORY:
            winner = 1
        else:
            raise ValueError(f"ambiguous round winner {number}")
        winners.append(winner)
        sides[number] = "T" if round_data.get("side") == "t-side" else "CT"
        names[number] = round_name
    return winners, sides, names


def round_event_stats(data: dict, team_of: dict[str, int], names_by_pid: dict[str, str]) -> dict[int, dict[str, dict[str, float]]]:
    """Derive per-round kill, death, survival, and swing observations."""
    by_name = {name: pid for pid, name in names_by_pid.items()}
    output: dict[int, dict[str, dict[str, float]]] = {}
    for round_name, round_data in data.get("performance", {}).get("rounds", {}).items():
        round_number = int(str(round_name).removeprefix("round"))
        kills: defaultdict[str, int] = defaultdict(int)
        deaths: defaultdict[str, int] = defaultdict(int)
        for event in round_data.get("events", []):
            title = str(event.get("title", ""))
            if " killed " not in title:
                continue
            attacker, victim = (normalize(part) for part in title.split(" killed ", 1))
            if attacker in by_name and victim in by_name:
                kills[by_name[attacker]] += 1
                deaths[by_name[victim]] += 1
        player_stats: dict[str, dict[str, float]] = {}
        for pid, name in names_by_pid.items():
            player = next((p for p in data["performance"].get("players", []) if str(p.get("pid")) == pid), None)
            per_round = dict(player.get("perRound", [])) if player else {}
            swing = number(per_round.get(str(round_number), 0.0))
            killed = float(deaths[pid] > 0)
            kills_count = float(kills[pid])
            player_stats[pid] = {
                "kills": kills_count,
                "death": killed,
                "survival": float(not killed),
                "swing": swing,
                "team": float(team_of[pid]),
            }
        output[round_number] = player_stats
    return output


def map_rows(root: Path) -> list[dict]:
    result: list[dict] = []
    for path in sorted(root.glob("map_*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("v") != 3:
            continue
        try:
            total = boards(data, "totalstats")
            ct_tables = boards(data, "ctstats")
            t_tables = boards(data, "tstats")
            if len(total) != 2 or len(ct_tables) != 2 or len(t_tables) != 2:
                continue
            winners, sides, round_names = round_assignments(data)
        except (KeyError, ValueError, IndexError):
            continue
        rounds = len(winners)
        side_counts = {team: {"CT": 0, "T": 0} for team in (0, 1)}
        for round_number, team0_side in sides.items():
            side_counts[0][team0_side] += 1
            side_counts[1]["CT" if team0_side == "T" else "T"] += 1
        team_of = {
            str(row["pid"]): team
            for team, board in enumerate(total)
            for row in board["rows"]
        }
        names_by_pid = {
            str(row["pid"]): normalize(row["player"])
            for board in total for row in board["rows"]
        }
        events = round_event_stats(data, team_of, names_by_pid)
        side_rows = {
            "ct": [{str(row["pid"]): row for row in board["rows"]} for board in ct_tables],
            "t": [{str(row["pid"]): row for row in board["rows"]} for board in t_tables],
        }

        def side_values(team: int, pid: str, side: str) -> dict[str, float]:
            count = side_counts[team][side]
            source = side_rows[side.lower()][team].get(pid)
            if count <= 0 or source is None:
                return {f"{side.lower()}_{feature}": float("nan") for feature in ("ekpr", "eadr", "edpr", "ekast", "mk", "swing")}
            side_ek, _ = pair(cell(source, "st-kills", True))
            side_ed, _ = pair(cell(source, "st-deaths", True))
            side_eadr = number(cell(source, "st-adr", True))
            side_ekast = number(cell(source, "st-kast", True))
            side_mks = number(cell(source, "st-mks"))
            side_swing = number(cell(source, "st-roundSwing"))
            return {
                f"{side.lower()}_ekpr": side_ek / count,
                f"{side.lower()}_eadr": side_eadr,
                f"{side.lower()}_edpr": side_ed / count,
                f"{side.lower()}_ekast": side_ekast,
                f"{side.lower()}_mk": 100.0 * side_mks / count,
                f"{side.lower()}_swing": side_swing,
            }

        for team, board in enumerate(total):
            for row in board["rows"]:
                pid = str(row["pid"])
                name = names_by_pid[pid]
                k, hs = pair(cell(row, "st-kills"))
                ek, _ = pair(cell(row, "st-kills", True))
                d, traded = pair(cell(row, "st-deaths"))
                ed, _ = pair(cell(row, "st-deaths", True))
                assists, flash_assists = pair(cell(row, "st-assists"))
                opening_kills, opening_deaths = pair(cell(row, "st-opkd"))
                clutch = number(cell(row, "st-clutches"))
                mks = number(cell(row, "st-mks"))
                adr = number(cell(row, "st-adr"))
                eadr = number(cell(row, "st-adr", True))
                kast = number(cell(row, "st-kast"))
                ekast = number(cell(row, "st-kast", True))
                swing = number(cell(row, "st-roundSwing"))
                row_data = {
                    "map": path.stem,
                    "match": str(data["match"]["matchId"]),
                    "player": name,
                    "rating": number(cell(row, "st-rating")),
                    "rounds": float(rounds),
                    "ekpr": ek / rounds,
                    "eadr": eadr,
                    "edpr": ed / rounds,
                    "ekast": ekast,
                    "mk": 100.0 * mks / rounds,
                    "swing": swing,
                    "kpr": k / rounds,
                    "adr": adr,
                    "dpr": d / rounds,
                    "kast": kast,
                    "hspr": hs / rounds,
                    "assists_pr": assists / rounds,
                    "flash_assists_pr": flash_assists / rounds,
                    "traded_dpr": traded / rounds,
                    "opening_kpr": opening_kills / rounds,
                    "opening_dpr": opening_deaths / rounds,
                    "clutch_pr": clutch / rounds,
                    "hs_rate": hs / k if k else 0.0,
                    "op_diff": (opening_kills - opening_deaths) / rounds,
                    **side_values(team, pid, "CT"),
                    **side_values(team, pid, "T"),
                    "ct_fraction": side_counts[team]["CT"] / rounds,
                }
                observations = [events[number][pid] for number in events if pid in events[number]]
                won = [obs for number, obs in ((number, events[number][pid]) for number in events if pid in events[number]) if winners[number - 1] == team]
                lost = [obs for number, obs in ((number, events[number][pid]) for number in events if pid in events[number]) if winners[number - 1] != team]
                # A map can be a one-sided regulation score. Empty groups are zero, not an inferred value.
                def mean_or_zero(items: list[dict], key: str) -> float:
                    return float(np.mean([item[key] for item in items])) if items else 0.0
                win_rate = len(won) / rounds
                row_data.update({
                    "win_rate": win_rate,
                    "raw_kills_won_pr": mean_or_zero(won, "kills"),
                    "raw_kills_lost_pr": mean_or_zero(lost, "kills"),
                    "raw_deaths_won_pr": mean_or_zero(won, "death"),
                    "raw_deaths_lost_pr": mean_or_zero(lost, "death"),
                    "survival_won_pr": mean_or_zero(won, "survival"),
                    "survival_lost_pr": mean_or_zero(lost, "survival"),
                    "proxy_kast_won_pr": mean_or_zero(won, "kills") + mean_or_zero(won, "survival"),
                    "proxy_kast_lost_pr": mean_or_zero(lost, "kills") + mean_or_zero(lost, "survival"),
                    "swing_won": mean_or_zero(won, "swing"),
                    "swing_lost": mean_or_zero(lost, "swing"),
                    "swing_diff": mean_or_zero(won, "swing") - mean_or_zero(lost, "swing"),
                    "ekast_x_win": ekast * win_rate,
                    "ekast_x_loss": ekast * (1.0 - win_rate),
                    "mk_x_win": (100.0 * mks / rounds) * win_rate,
                    "mk_x_loss": (100.0 * mks / rounds) * (1.0 - win_rate),
                    "logit_ekast": np.log(np.clip(ekast / 100.0, 1e-5, 1 - 1e-5) / np.clip(1.0 - ekast / 100.0, 1e-5, 1.0)),
                    "sqrt_ekast": np.sqrt(max(ekast, 0.0)),
                })
                result.append(row_data)
    return result


def score(y: np.ndarray, prediction: np.ndarray) -> dict:
    error = np.abs(y - prediction)
    return {
        "n": int(len(error)),
        "mae": float(np.mean(error)),
        "p95": float(np.quantile(error, 0.95)),
        "max": float(np.max(error)),
        "r": float(np.corrcoef(y, prediction)[0, 1]),
    }


def held_out(rows: list[dict], feature_names: tuple[str, ...], folds: int = 5) -> dict:
    valid = [row for row in rows if np.isfinite([row.get(feature, np.nan) for feature in feature_names]).all() and np.isfinite(row["rating"])]
    x = np.asarray([[row[feature] for feature in feature_names] for row in valid], dtype=float)
    y = np.asarray([row["rating"] for row in valid], dtype=float)
    groups = np.asarray([row["match"] for row in valid])
    prediction = np.full(len(valid), np.nan)
    fold_scores = []
    splitter = GroupKFold(n_splits=folds)
    for fold, (train, test) in enumerate(splitter.split(x, y, groups), start=1):
        model = Pipeline([
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            ("ridge", Ridge()),
        ])
        search = GridSearchCV(
            model,
            {"ridge__alpha": [1e-8, 1e-5, 1e-3, 1e-2, 1e-1, 1.0, 10.0, 100.0]},
            scoring="neg_mean_absolute_error",
            cv=GroupKFold(n_splits=3),
            n_jobs=1,
        )
        search.fit(x[train], y[train], groups=groups[train])
        prediction[test] = search.predict(x[test])
        fold_scores.append({"fold": fold, "rows": int(len(test)), "matches": int(len(set(groups[test]))), "alpha": float(search.best_params_["ridge__alpha"]), "score": score(y[test], prediction[test])})
    return {"features": list(feature_names), "rows": len(valid), "matches": len(set(groups)), "cv": score(y, prediction), "folds": fold_scores}


def fit_formula(rows: list[dict], feature_names: tuple[str, ...]) -> dict:
    valid = [row for row in rows if np.isfinite([row.get(feature, np.nan) for feature in feature_names]).all() and np.isfinite(row["rating"])]
    x = np.asarray([[row[feature] for feature in feature_names] for row in valid], dtype=float)
    y = np.asarray([row["rating"] for row in valid], dtype=float)
    groups = np.asarray([row["match"] for row in valid])
    model = Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("ridge", Ridge()),
    ])
    search = GridSearchCV(
        model,
        {"ridge__alpha": [1e-8, 1e-5, 1e-3, 1e-2, 1e-1, 1.0, 10.0, 100.0]},
        scoring="neg_mean_absolute_error",
        cv=GroupKFold(n_splits=3),
        n_jobs=1,
    )
    search.fit(x, y, groups=groups)
    best = search.best_estimator_
    return {
        "features": list(feature_names),
        "alpha": float(search.best_params_["ridge__alpha"]),
        "intercept_standardised": float(best.named_steps["ridge"].intercept_),
        "means": best.named_steps["scale"].mean_.tolist(),
        "scales": best.named_steps["scale"].scale_.tolist(),
        "coefficients_standardised": best.named_steps["ridge"].coef_.tolist(),
        "fit": score(y, best.predict(x)),
    }


def add_derived_rows(rows: list[dict]) -> None:
    for row in rows:
        row["kast_result_proxy"] = row["ekast"] * row["win_rate"]


def attach_demo_features(rows: list[dict], data_root: Path, joins_path: Path, demo_metrics_path: Path) -> tuple[list[dict], dict]:
    module = runpy.run_path(str(Path(__file__).with_name("demo_round_fit.py")))
    joins = json.loads(joins_path.read_text(encoding="utf-8"))["accepted"]
    metrics = json.loads(demo_metrics_path.read_text(encoding="utf-8"))
    demo_rows = module["build_round_rows"](data_root, joins, metrics["duel_model"])
    feature_names = [
        name for name in module["FEATURES"]
        if name not in {"eco_kills", "eco_deaths", "swing", "team_win", "team_loss"}
        and not name.startswith("eco_")
    ]
    result_conditioned = (
        "kast", "kill", "assist", "flash_assist", "survival", "traded_death",
        "damage_game", "damage_capped100", "swing",
    )
    grouped: defaultdict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in demo_rows:
        grouped[(Path(row["map"]).stem, row["player"])].append(row)
    for row in rows:
        source = grouped.get((row["map"], row["player"]))
        if not source:
            continue
        for feature in feature_names:
            row[f"demo_{feature}"] = float(np.mean([float(item[feature]) for item in source]))
        for outcome, suffix in ((1.0, "won"), (0.0, "lost")):
            subset = [item for item in source if float(item.get("team_win", 0.0)) == outcome]
            for feature in result_conditioned:
                if feature == "kast":
                    values = [float(bool(item["kill"] or item["assist"] or item["survival"] or item["traded_death"])) for item in subset]
                else:
                    values = [float(item[feature]) for item in subset]
                row[f"demo_{feature}_{suffix}"] = float(np.mean(values)) if values else 0.0
    conditional_names = [f"demo_{feature}_{suffix}" for feature in result_conditioned for suffix in ("won", "lost")]
    required = [f"demo_{feature}" for feature in feature_names] + conditional_names
    merged = [row for row in rows if all(name in row for name in required)]
    return merged, {
        "features": [f"demo_{feature}" for feature in feature_names],
        "result_conditioned_features": conditional_names,
        "round_rows": len(demo_rows),
        "player_maps": len(merged),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hltv", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--data", type=Path)
    parser.add_argument("--joins", type=Path)
    parser.add_argument("--demo-metrics", type=Path)
    args = parser.parse_args()

    rows = map_rows(args.hltv)
    add_derived_rows(rows)
    all_scoreboard = tuple(dict.fromkeys(BASE + (
        "kpr", "adr", "dpr", "kast", "hspr", "assists_pr", "flash_assists_pr",
        "traded_dpr", "opening_kpr", "opening_dpr", "clutch_pr", "hs_rate",
    )))
    result = {
        "dataset": {"rows": len(rows), "maps": len({row["map"] for row in rows})},
        "split": "5-fold GroupKFold by match; inner 3-fold GroupKFold selects Ridge alpha by MAE",
        "hypotheses": {},
    }
    row_sets: dict[str, list[dict]] = {}
    hypotheses: dict[str, tuple[str, ...]] = {
        "base_displayed_eco": BASE,
        "kast_result_interaction": BASE + ("win_rate", "ekast_x_win", "ekast_x_loss", "logit_ekast", "sqrt_ekast"),
        "per_round_result_subratings": BASE + (
            "win_rate", "raw_kills_won_pr", "raw_kills_lost_pr", "raw_deaths_won_pr", "raw_deaths_lost_pr",
            "survival_won_pr", "survival_lost_pr", "proxy_kast_won_pr", "proxy_kast_lost_pr",
            "swing_won", "swing_lost", "swing_diff", "mk_x_win", "mk_x_loss",
        ),
        "assists_and_flash_assists": BASE + ("assists_pr", "flash_assists_pr"),
        "opening_clutch_trade_headshot": BASE + ("opening_kpr", "opening_dpr", "clutch_pr", "hspr", "traded_dpr", "hs_rate", "op_diff"),
        "winner_loser_normalisation": BASE + (
            "win_rate", "raw_kills_won_pr", "raw_kills_lost_pr", "raw_deaths_won_pr", "raw_deaths_lost_pr",
            "survival_won_pr", "survival_lost_pr",
            "ekast_x_win", "ekast_x_loss", "mk_x_win", "mk_x_loss",
        ),
        "swing_on_won_rounds": BASE + ("win_rate", "swing_won", "swing_lost", "swing_diff"),
        "all_scoreboard_columns": all_scoreboard,
        "side_displayed_columns": BASE + SIDE_FEATURES,
        "side_displayed_plus_result": BASE + SIDE_FEATURES + ("win_rate", "ekast_x_win", "ekast_x_loss", "swing_won", "swing_lost"),
        "all_map_features": FEATURES,
        "all_map_features_plus_side": FEATURES + SIDE_FEATURES,
    }
    for name, feature_names in hypotheses.items():
        result["hypotheses"][name] = held_out(rows, feature_names)
        row_sets[name] = rows
        print(name, result["hypotheses"][name]["cv"])

    if args.data and args.joins and args.demo_metrics:
        demo_rows, demo_info = attach_demo_features(rows, args.data, args.joins, args.demo_metrics)
        result["demo"] = demo_info
        demo_by_family = {
            "damage": ("damage_game", "damage_raw100", "damage_capped100"),
            "action_counts": (
                "kills_count", "deaths_count", "assists_count", "flash_assists_count",
                "trade_kills_count", "traded_deaths_count",
            ),
            "action_outcomes": (
                "kill", "assist", "flash_assist", "survival", "trade_kill", "traded_death",
                "mk2", "mk3", "mk4", "mk5",
            ),
            "equipment_interactions": (
                "equip_diff", "kill_x_equip", "survival_x_win", "damage_x_equip",
                "kill_x_win", "death_x_loss", "damage_x_survival", "swing_x_kill", "swing_x_survival",
            ),
        }
        demo_names_by_family = {
            family: tuple(f"demo_{feature}" for feature in features)
            for family, features in demo_by_family.items()
        }
        for family, feature_names in demo_names_by_family.items():
            name = f"displayed_plus_demo_{family}"
            result["hypotheses"][name] = held_out(demo_rows, BASE + feature_names)
            row_sets[name] = demo_rows
            print(name, result["hypotheses"][name]["cv"])
        conditional_names = tuple(demo_info["result_conditioned_features"])
        result["hypotheses"]["displayed_plus_demo_result_conditioned"] = held_out(demo_rows, BASE + conditional_names)
        row_sets["displayed_plus_demo_result_conditioned"] = demo_rows
        print("displayed_plus_demo_result_conditioned", result["hypotheses"]["displayed_plus_demo_result_conditioned"]["cv"])
        all_demo_names = tuple(result["hypotheses"]["all_map_features"]["features"] + demo_info["features"])
        result["hypotheses"]["displayed_plus_exact_demo"] = held_out(demo_rows, all_demo_names)
        row_sets["displayed_plus_exact_demo"] = demo_rows
        print("displayed_plus_exact_demo", result["hypotheses"]["displayed_plus_exact_demo"]["cv"])
        result["hypotheses"]["displayed_plus_exact_demo_result_conditioned"] = held_out(
            demo_rows, all_demo_names + conditional_names
        )
        row_sets["displayed_plus_exact_demo_result_conditioned"] = demo_rows
        print("displayed_plus_exact_demo_result_conditioned", result["hypotheses"]["displayed_plus_exact_demo_result_conditioned"]["cv"])
        side_demo_names = tuple(result["hypotheses"]["all_map_features_plus_side"]["features"] + demo_info["features"])
        result["hypotheses"]["all_map_features_plus_side_and_demo"] = held_out(demo_rows, side_demo_names)
        row_sets["all_map_features_plus_side_and_demo"] = demo_rows
        print("all_map_features_plus_side_and_demo", result["hypotheses"]["all_map_features_plus_side_and_demo"]["cv"])

    best_name = min(result["hypotheses"], key=lambda name: result["hypotheses"][name]["cv"]["mae"])
    result["best"] = {
        "name": best_name,
        "cv": result["hypotheses"][best_name]["cv"],
        "formula": fit_formula(row_sets[best_name], tuple(result["hypotheses"][best_name]["features"])),
    }
    all_maps_name = "all_map_features_plus_side"
    result["best_all_maps"] = {
        "name": all_maps_name,
        "cv": result["hypotheses"][all_maps_name]["cv"],
        "formula": fit_formula(row_sets[all_maps_name], tuple(result["hypotheses"][all_maps_name]["features"])),
    }
    args.out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result["best"], indent=2))


if __name__ == "__main__":
    main()
