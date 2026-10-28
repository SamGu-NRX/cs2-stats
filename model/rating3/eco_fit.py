"""Fit the provisional duel table to HLTV eco K/D/ADR cells on strict demo joins."""
from __future__ import annotations

import argparse
from collections import defaultdict
import json
import re
from pathlib import Path
import sys

import numpy as np
from scipy.optimize import least_squares
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parent))
from demo_paths import load_demo_tables
from join_demos import joined_players
sys.path.append(str(Path(__file__).resolve().parents[2] / "extractor"))
from repo_guard import check_output, write_json  # noqa: E402  (extractor/repo_guard.py: where outputs may land)


GROUPS = ("sniper", "rifle1", "rifle2", "smg", "pistolPlus", "pistol")
INDEX = {group: index for index, group in enumerate(GROUPS)}


def norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def weapon_group(weapon: str | None) -> str | None:
    value = norm(weapon)
    if any(item in value for item in ("awp", "g3sg1", "scar20")):
        return "sniper"
    if any(item in value for item in ("ak47", "m4a1", "aug", "sg556")):
        return "rifle1"
    if any(item in value for item in ("galilar", "famas", "ssg08")):
        return "rifle2"
    if any(item in value for item in ("mac10", "mp9", "mp7", "mp5sd", "ump45", "p90", "bizon", "nova", "xm1014", "sawedoff", "mag7", "m249", "negev")):
        return "smg"
    if any(item in value for item in ("deagle", "revolver", "p250", "fiveseven", "tec9", "cz75", "dualberetta")):
        return "pistolPlus"
    if any(item in value for item in ("glock", "hkp2000", "usps", "usp")):
        return "pistol"
    return None


def sigmoid(value: float) -> float:
    return 1 / (1 + np.exp(-np.clip(value, -40, 40)))


def empty_provenance() -> dict:
    return {
        "consumed_joins": 0,
        "skipped_joins": 0,
        "layouts": {"schema_v1": 0, "legacy": 0},
        "skipped": [],
    }


def collect(root: Path, joins: list[dict], provenance: dict | None = None):
    rows = []
    duels = []
    provenance = provenance if provenance is not None else empty_provenance()
    for join in joins:
        try:
            layout, tables = load_demo_tables(
                root,
                join["demo"],
                ("match", "player_rounds", "kills", "damages"),
                pq.read_table,
            )
            hltv = json.loads((root / "hltv" / join["hltv"]).read_text(encoding="utf-8"))
            metadata = tables["match"].to_pylist()[0]
            economy = tables["player_rounds"].to_pylist()
            kills = tables["kills"].to_pylist()
            damages = tables["damages"].to_pylist()
        except FileNotFoundError as error:
            provenance["skipped_joins"] += 1
            provenance["skipped"].append({"demo": join["demo"], "reason": str(error)})
            continue

        provenance["consumed_joins"] += 1
        provenance["layouts"][layout.format] += 1
        # {steamid: HLTV name} as the join paired them; an in-game name often differs from HLTV's.
        names = {int(sid): name for sid, name in joined_players(join).items()}
        starts = {
            (row["round"], row["steamid"]): weapon_group(row.get("best_primary") or row.get("best_secondary"))
            or ("pistolPlus" if row.get("armor") else "pistol")
            for row in economy
        }
        map_rows = {
            norm(row["player"]): row
            for board in hltv["scoreboards"]
            if "totalstats" in board["cls"].split()
            for row in board["rows"]
        }
        rounds = max(row["round"] for row in economy)
        match_id = str(hltv.get("match", {}).get("matchId", metadata.get("match_id", join["hltv"])))
        for kill in kills:
            if (
                kill["is_suicide"]
                or kill["is_teamkill"]
                or not kill["attacker_steamid"]
                or kill["attacker_steamid"] not in names
                or kill["victim_steamid"] not in names
            ):
                continue
            attacker_group = weapon_group(kill.get("a_active_weapon")) or starts.get((kill["round"], kill["attacker_steamid"]))
            victim_group = weapon_group(kill.get("v_active_weapon")) or starts.get((kill["round"], kill["victim_steamid"]))
            if attacker_group and victim_group:
                duels.append({
                    "a": attacker_group,
                    "v": victim_group,
                    "side": kill["a_side"],
                    "map": join["hltv"],
                    "match": match_id,
                })
        for damage in damages:
            if (
                damage["is_self"]
                or damage["is_team_damage"]
                or damage.get("attacker_steamid") not in names
                or damage.get("victim_steamid") not in names
            ):
                continue
            attacker_group = weapon_group(damage.get("weapon")) or starts.get((damage["round"], damage["attacker_steamid"]))
            victim_group = starts.get((damage["round"], damage["victim_steamid"]))
            if attacker_group and victim_group:
                rows.append({
                    "map": join["hltv"],
                    "match": match_id,
                    "player": names[damage["attacker_steamid"]],
                    "victim": names[damage["victim_steamid"]],
                    "a": attacker_group,
                    "v": victim_group,
                    "side": damage["a_side"],
                    "dmg": float(damage["dmg_health_capped"]),
                    "kill": False,
                })
        for kill in kills:
            if (
                kill["is_suicide"]
                or kill["is_teamkill"]
                or kill.get("attacker_steamid") not in names
                or kill.get("victim_steamid") not in names
            ):
                continue
            attacker_group = weapon_group(kill.get("a_active_weapon")) or starts.get((kill["round"], kill["attacker_steamid"]))
            victim_group = weapon_group(kill.get("v_active_weapon")) or starts.get((kill["round"], kill["victim_steamid"]))
            if attacker_group and victim_group:
                rows.append({
                    "map": join["hltv"],
                    "match": match_id,
                    "player": names[kill["attacker_steamid"]],
                    "victim": names[kill["victim_steamid"]],
                    "a": attacker_group,
                    "v": victim_group,
                    "side": kill["a_side"],
                    "dmg": None,
                    "kill": True,
                })
        for name, row in map_rows.items():
            def cell(prefix: str, eco: bool = False) -> str:
                for classes, value in row["cells"]:
                    if prefix in classes and ("eco-adjusted-data" in classes) == eco:
                        return value
                raise KeyError(f"{join['hltv']}: missing {prefix} eco={eco}")

            def number(value: str) -> float:
                return float(value.replace("%", "").replace("+", ""))

            def kd(value: str) -> float:
                return float(value.split()[0].split(":")[0])

            rows.append({
                "target": "player",
                "map": join["hltv"],
                "match": match_id,
                "player": name,
                "ek": kd(cell("st-kills", True)),
                "ed": kd(cell("st-deaths", True)),
                "eadr": number(cell("st-adr", True)),
                "rounds": rounds,
            })
    return rows, duels, provenance


def target_errors(target: dict, *, kills: float, deaths: float, adr: float) -> list[float]:
    """Weight map-total K/D errors and an ADR error already in HP per round."""
    return [
        (kills - target["ek"]) * 0.2,
        (deaths - target["ed"]) * 0.2,
        (adr - target["eadr"]) * 0.05,
    ]


def fit_model(root: Path, joins: list[dict]) -> dict:
    provenance = empty_provenance()
    raw, duels, provenance = collect(root, joins, provenance)
    targets = [row for row in raw if row.get("target") == "player"]
    events = [row for row in raw if row.get("target") != "player"]

    def unpack(parameters):
        return np.r_[parameters[:5], 0.0], parameters[5]

    def probability(parameters, attacker, victim, side):
        strengths, _ = unpack(parameters)
        edge = -np.log(0.48 / 0.52)
        return sigmoid(strengths[INDEX[attacker]] - strengths[INDEX[victim]] + (edge if side == "CT" else -edge))

    def residual(parameters, event_source=events, target_source=targets):
        strengths, scale = unpack(parameters)
        predicted = defaultdict(lambda: {"k": 0.0, "d": 0.0, "adr": 0.0})
        for event in event_source:
            points = scale * (1 - probability(parameters, event["a"], event["v"], event["side"]))
            if event.get("kill"):
                predicted[(event["map"], event["player"])]["k"] += points
                predicted[(event["map"], event["victim"])]["d"] += points
            if event.get("dmg") is not None:
                predicted[(event["map"], event["player"])]["adr"] += event["dmg"] * points
        output = []
        for target in target_source:
            values = predicted[(target["map"], target["player"])]
            output.extend(target_errors(
                target,
                kills=values["k"],
                deaths=values["d"],
                adr=values["adr"] / target["rounds"],
            ))
        return output

    initial = np.array([1.5, 1.18, 0.83, 0.56, 0.29, 2.14])
    result = least_squares(residual, initial, bounds=([-4] * 5 + [0.1], [4] * 5 + [8]), max_nfev=1000)
    strengths, scale = unpack(result.x)

    from sklearn.model_selection import GroupKFold
    target_groups = np.asarray([row["match"] for row in targets])
    held_out_predictions = []
    held_out_folds = []
    held_out_baseline_predictions = []
    held_out_baseline_folds = []
    splitter = GroupKFold(n_splits=min(5, len(set(target_groups))))
    for fold, (train_index, test_index) in enumerate(splitter.split(targets, target_groups, target_groups), start=1):
        train_matches = set(target_groups[train_index])
        test_matches = set(target_groups[test_index])
        train_targets = [targets[index] for index in train_index]
        test_targets = [targets[index] for index in test_index]
        train_events = [event for event in events if event["match"] in train_matches]
        test_events = [event for event in events if event["match"] in test_matches]
        fold_result = least_squares(
            lambda parameters: residual(parameters, train_events, train_targets),
            initial,
            bounds=([-4] * 5 + [0.1], [4] * 5 + [8]),
            max_nfev=1000,
        )
        errors = np.abs(np.asarray(residual(fold_result.x, test_events, test_targets), dtype=float))
        held_out_predictions.extend(errors.tolist())
        held_out_folds.append({
            "fold": fold,
            "targets": len(test_targets),
            "matches": len(test_matches),
            "mae": float(errors.mean()),
            "p95": float(np.quantile(errors, 0.95)),
            "max": float(errors.max()),
        })
        baseline_values = {
            "k": float(np.mean([target["ek"] for target in train_targets])),
            "d": float(np.mean([target["ed"] for target in train_targets])),
            "adr": float(np.mean([target["eadr"] for target in train_targets])),
        }
        baseline_errors = np.abs(np.asarray(
            [
                error
                for target in test_targets
                for error in target_errors(
                    target,
                    kills=baseline_values["k"],
                    deaths=baseline_values["d"],
                    adr=baseline_values["adr"],
                )
            ],
            dtype=float,
        ))
        held_out_baseline_predictions.extend(baseline_errors.tolist())
        held_out_baseline_folds.append({
            "fold": fold,
            "targets": len(test_targets),
            "matches": len(test_matches),
            "mae": float(baseline_errors.mean()),
            "p95": float(np.quantile(baseline_errors, 0.95)),
            "max": float(baseline_errors.max()),
        })
    held_out_errors = np.asarray(held_out_predictions, dtype=float)
    held_out_baseline_errors = np.asarray(held_out_baseline_predictions, dtype=float)
    held_out = {
        "split": "5-fold GroupKFold by match",
        "targets": len(targets),
        "matches": int(len(set(target_groups))),
        "mae": float(held_out_errors.mean()),
        "p95": float(np.quantile(held_out_errors, 0.95)),
        "max": float(held_out_errors.max()),
        "folds": held_out_folds,
    }
    held_out_baseline = {
        "model": "training-fold target mean; no duel features",
        "split": "5-fold GroupKFold by match",
        "targets": len(targets),
        "matches": int(len(set(target_groups))),
        "mae": float(held_out_baseline_errors.mean()),
        "p95": float(np.quantile(held_out_baseline_errors, 0.95)),
        "max": float(held_out_baseline_errors.max()),
        "folds": held_out_baseline_folds,
    }
    return {
        "source": {
            "source": "fit",
            "script": "eco_fit.py",
            "accepted_joins": len(joins),
            "consumed_joins": provenance["consumed_joins"],
            "skipped_joins": provenance["skipped_joins"],
            "layouts": provenance["layouts"],
            "skipped": provenance["skipped"],
            "duels": len(duels),
            "targets": len(targets),
        },
        "groups": list(GROUPS),
        "strength": dict(zip(GROUPS, strengths.tolist())),
        "ct_edge": float(-np.log(0.48 / 0.52)),
        "kill_points_scale": float(scale),
        "duels": len(duels),
        "targets": len(targets),
        "objective_mae": float(np.mean(np.abs(residual(result.x)))),
        "target_definition": {
            "predicted": "HLTV eco-adjusted kills, deaths, and ADR cells per player-map",
            "units": {
                "kills": "kills per map",
                "deaths": "deaths per map",
                "adr": "HP per round",
            },
            "error_scale": "0.2 times kill/death error and 0.05 times ADR error; MAE is in weighted residual units",
        },
        "held_out": held_out,
        "held_out_baseline": held_out_baseline,
        "status": "joint fit to eK/eD/eADR; validate exact display rounding before shipping",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--joins", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    # private: built from HLTV rows and pro demos; checked before any data is read
    check_output(args.out, private=True, what="the eco fit report")
    joins = json.loads(args.joins.read_text(encoding="utf-8"))["accepted"]
    result = fit_model(args.data, joins)
    write_json(args.out, result, private=True, what="the eco fit report", indent=2)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
