"""Fit the provisional duel table to HLTV eco K/D/ADR cells on strict demo joins."""
from __future__ import annotations

import argparse
from collections import defaultdict
import json
from pathlib import Path
import sys

import numpy as np
from scipy.optimize import least_squares

sys.path.append(str(Path(__file__).resolve().parents[2] / "extractor"))
from repo_guard import check_output, write_json  # noqa: E402  (extractor/repo_guard.py: where outputs may land)


GROUPS = ("sniper", "rifle1", "rifle2", "smg", "pistolPlus", "pistol")
INDEX = {group: index for index, group in enumerate(GROUPS)}


def sigmoid(value: float) -> float:
    return 1 / (1 + np.exp(-np.clip(value, -40, 40)))


def empty_provenance() -> dict:
    return {
        "consumed_joins": 0,
        "skipped_joins": 0,
        "layouts": {"schema_v1": 0, "legacy": 0},
        "skipped": [],
    }


DUMP = ("rating-kills.private.jsonl", "rating-hits.private.jsonl", "rating-winprob.private.jsonl")


def jsonl(path: Path):
    with path.open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def collect(root: Path, joins: list[dict], provenance: dict | None = None):
    """(rows, duels, provenance) for the duel fit, from the engine's rating dump (app: pnpm rating-dump, in
    <root>/model-rating3) for the joined maps given. Each kill and hit there carries the economy groups derive
    valued it with (aGroup, vGroup: the best primary held at the kill, else the equipment value, else the
    freeze-end group; a hit uses the freeze-end groups), so the fit trains on the groups the app computes with,
    never a second definition: working out its own groups (active weapon, round-start loadout), the fit gave a duel
    block that scored worse in the app (rating MAE 0.0467 against 0.0429 on 1,610 joined maps). A kill or hit
    whose groups the app did not know is left out, as the app leaves it. Players are keyed by HLTV player id, as
    the dump keys them; targets are their HLTV eco-adjusted cells. A joined map missing from the dump is skipped,
    named in provenance."""
    provenance = provenance if provenance is not None else empty_provenance()
    folder = root / "model-rating3"
    missing = [n for n in DUMP if not (folder / n).exists()]
    if missing:
        raise FileNotFoundError(f"the rating dump is missing {missing} in {folder}: run pnpm rating-dump in app/ first")
    wanted = {j["hltv"]: j for j in joins}
    rounds: dict[str, int] = defaultdict(int)
    for r in jsonl(folder / "rating-winprob.private.jsonl"):
        if r["hltv"] in wanted:
            rounds[r["hltv"]] += 1
    match_of = {}
    for file in wanted:
        if file not in rounds:
            provenance["skipped_joins"] += 1
            provenance["skipped"].append({"demo": wanted[file]["demo"], "reason": "not in the rating dump"})
            continue
        provenance["consumed_joins"] += 1
        provenance["layouts"]["schema_v1"] += 1
        match_of[file] = str(json.loads((root / "hltv" / file).read_text(encoding="utf-8")).get("match", {}).get("matchId", file))
    rows, duels = [], []
    known = lambda r: r["aGroup"] in INDEX and r["vGroup"] in INDEX
    for k in jsonl(folder / "rating-kills.private.jsonl"):
        if k["hltv"] not in match_of or not k["enemy"] or k["killer"] is None or k["victim"] is None or not known(k):
            continue
        base = {"a": k["aGroup"], "v": k["vGroup"], "side": k["killerSide"], "map": k["hltv"], "match": match_of[k["hltv"]]}
        duels.append(base)
        rows.append({**base, "player": k["killer"], "victim": k["victim"], "dmg": None, "kill": True})
    for h in jsonl(folder / "rating-hits.private.jsonl"):
        if h["hltv"] not in match_of or h["attacker"] is None or h["victim"] is None or not h["aSide"] or not known(h):
            continue
        rows.append({"a": h["aGroup"], "v": h["vGroup"], "side": h["aSide"], "map": h["hltv"], "match": match_of[h["hltv"]],
                     "player": h["attacker"], "victim": h["victim"], "dmg": float(h["dmg"]), "kill": False})
    for file, match_id in match_of.items():
        page = json.loads((root / "hltv" / file).read_text(encoding="utf-8"))
        paired = {p["pid"] for p in wanted[file]["players"].values()}
        for board in page["scoreboards"]:
            if "totalstats" not in board["cls"].split():
                continue
            for row in board["rows"]:
                if str(row["pid"]) not in paired:
                    continue

                def cell(prefix: str, eco: bool = False) -> str:
                    for classes, value in row["cells"]:
                        if prefix in classes and ("eco-adjusted-data" in classes) == eco:
                            return value
                    raise KeyError(f"{file}: missing {prefix} eco={eco}")

                rows.append({
                    "target": "player", "map": file, "match": match_id, "player": str(row["pid"]),
                    "ek": float(cell("st-kills", True).split()[0].split(":")[0]),
                    "ed": float(cell("st-deaths", True).split()[0].split(":")[0]),
                    "eadr": float(cell("st-adr", True).replace("%", "").replace("+", "")),
                    "rounds": rounds[file],
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
