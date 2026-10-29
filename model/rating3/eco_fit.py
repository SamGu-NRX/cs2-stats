"""Fit the duel block (group strengths and the kill-point scale) so the eco inputs the app computes from it match
HLTV's eco-adjusted cells on the joined maps: eKPR, eDPR, eADR and eKAST, each error weighted by how much it moves
the rating."""
from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import dataclass
import json
from pathlib import Path
import sys

import numpy as np
from scipy import sparse
from scipy.optimize import least_squares

sys.path.append(str(Path(__file__).resolve().parents[2] / "extractor"))
from repo_guard import check_output, write_json  # noqa: E402  (extractor/repo_guard.py: where outputs may land)


GROUPS = ("sniper", "rifle1", "rifle2", "smg", "pistolPlus", "pistol")
INDEX = {group: index for index, group in enumerate(GROUPS)}
CELLS = len(GROUPS) * len(GROUPS) * 2
# the published side edge: a T rifle beats a CT rifle 48% of the time (fit_params.duel_block)
CT_EDGE = float(-np.log(0.48 / 0.52))
# each fitted input and the rating curve (params.json rating.curves) whose slope weighs its error
INPUTS = {"ekpr": "eKPR", "edpr": "eDPR", "eadr": "eADR", "ekast": "eKAST"}
# rating3.ts MIN_VALUED_SHARE: a side, and a player-map, is rated only with half its rounds rated
MIN_RATED_SHARE = 0.5
PARAMS = Path(__file__).resolve().parent / "params.json"
DUMP = ("rating-joins.private.jsonl", "rating-rounds.private.jsonl", "rating-kills.private.jsonl",
        "rating-hits.private.jsonl")


def empty_provenance() -> dict:
    return {
        "consumed_joins": 0,
        "skipped_joins": 0,
        "layouts": {"schema_v1": 0, "legacy": 0},
        "skipped": [],
    }


def jsonl(path: Path):
    with path.open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def cell(killer_group: str, victim_group: str, killer_side: str) -> int:
    return (INDEX[killer_group] * len(GROUPS) + INDEX[victim_group]) * 2 + (0 if killer_side == "CT" else 1)


def kill_points(strength: np.ndarray, scale: float, edge: float = CT_EDGE) -> np.ndarray:
    """rating3.ts killPoints for every (killer group, victim group, killer side) cell."""
    gap = strength[:, None] - strength[None, :]
    points = np.empty(CELLS)
    points[0::2] = (scale / (1 + np.exp(gap + edge))).ravel()
    points[1::2] = (scale / (1 + np.exp(gap - edge))).ravel()
    return points


@dataclass
class Duels:
    """The joined maps' eco events, per player-map side over its rated rounds, as linear maps of kill points.

    kills, deaths and damage count each side's enemy kills, deaths and hit damage per cell. A rated round's eco
    KAST is the most its kills and non-flash assists are worth, or 1 for a traded death or survival in a won round
    (rating3.ts ecoAdjust); rounds alike in that floor and those cells share a column of kast_rounds.
    players maps each player-map to the sides the app rates it on."""
    kills: sparse.csr_matrix
    deaths: sparse.csr_matrix
    damage: sparse.csr_matrix
    kast_rounds: sparse.csr_matrix
    kast_floor: np.ndarray
    kast_cells: np.ndarray
    rated: np.ndarray
    players: sparse.csr_matrix
    targets: dict
    match: np.ndarray
    duels: int


def collect(root: Path, joins: list[dict], provenance: dict | None = None) -> tuple[Duels, dict]:
    """The duel fit's events and targets, from the engine's rating dump (app: pnpm rating-dump, in
    <root>/model-rating3) for the joined maps given. Each kill and hit there carries the economy groups derive
    valued it with, so the fit trains on the groups the app computes with: working out its own groups (active
    weapon, round-start loadout), the fit gave a duel block that scored worse in the app (rating MAE 0.0467 against
    0.0429 on 1,610 joined maps). A kill or hit whose groups the app did not know is left out, as the app leaves it.
    Only rated rounds count, and a player-map counts on its rated sides, as pnpm rating-check rates it. Players are
    keyed by HLTV player id, as the dump keys them; targets are their HLTV eco-adjusted cells. A joined map missing
    from the dump is skipped, named in provenance. The dump records the join (demo folder, pairing) and table layout
    each map's rows came from; a map dumped under another join than the one given raises, since its rows would pair
    other players."""
    provenance = provenance if provenance is not None else empty_provenance()
    folder = root / "model-rating3"
    missing = [n for n in DUMP if not (folder / n).exists()]
    if missing:
        raise FileNotFoundError(f"the rating dump is missing {missing} in {folder}: run pnpm rating-dump in app/ first")
    wanted = {j["hltv"]: j for j in joins}
    dumped = {r["hltv"]: r for r in jsonl(folder / "rating-joins.private.jsonl")}
    match_of = {}
    for file, join in wanted.items():
        d = dumped.get(file)
        if d is None:
            provenance["skipped_joins"] += 1
            provenance["skipped"].append({"demo": join["demo"], "reason": "not in the rating dump"})
            continue
        if d["demo"] != join["demo"] or d["players"] != join["players"]:
            raise ValueError(f"{file}: the rating dump holds it from another join (demo {d['demo']}, or another "
                             f"pairing) than {join['demo']}'s; run pnpm rating-dump in app/ again")
        provenance["consumed_joins"] += 1
        provenance["layouts"][d["layout"]] += 1
        match_of[file] = str(json.loads((root / "hltv" / file).read_text(encoding="utf-8")).get("match", {}).get("matchId", file))

    side_of: dict[tuple, int] = {}
    rounds, rated = [], []
    played: dict[tuple, dict] = {}
    for r in jsonl(folder / "rating-rounds.private.jsonl"):
        if r["hltv"] not in match_of:
            continue
        key = (r["hltv"], r["pid"], r["side"])
        if key not in side_of:
            side_of[key] = len(side_of)
            rounds.append(0)
            rated.append(0)
        i = side_of[key]
        m = r["m"]
        rounds[i] += m.get("rounds", 0)
        if m.get("ratedRounds"):
            rated[i] += 1
            floor = 1 if (r["won"] and m.get("survived")) or m.get("tradedDeaths") else 0
            played[(r["hltv"], r["pid"], r["ri"])] = {"side": i, "floor": floor, "kast": set()}

    kills, deaths, damage = [], [], []
    duels = 0
    known = lambda row: row["aGroup"] in INDEX and row["vGroup"] in INDEX
    for k in jsonl(folder / "rating-kills.private.jsonl"):
        if k["hltv"] not in match_of or not k["enemy"] or not known(k):
            continue
        c = cell(k["aGroup"], k["vGroup"], k["killerSide"])
        duels += k["killer"] is not None and k["victim"] is not None
        if (p := played.get((k["hltv"], k["killer"], k["ri"]))) is not None:
            kills.append((p["side"], c))
            p["kast"].add(c)
        if (p := played.get((k["hltv"], k["victim"], k["ri"]))) is not None:
            deaths.append((p["side"], c))
        if not k["flashAssist"] and (p := played.get((k["hltv"], k["assister"], k["ri"]))) is not None:
            p["kast"].add(c)
    for h in jsonl(folder / "rating-hits.private.jsonl"):
        if h["hltv"] not in match_of or not h["aSide"] or not known(h):
            continue
        if (p := played.get((h["hltv"], h["attacker"], h["ri"]))) is not None:
            damage.append((p["side"], cell(h["aGroup"], h["vGroup"], h["aSide"]), float(h["dmg"])))

    outcome_of: dict[tuple, int] = {}
    kast = []
    for p in played.values():
        outcome = (p["floor"], tuple(sorted(p["kast"])))
        kast.append((p["side"], outcome_of.setdefault(outcome, len(outcome_of))))
    width = max([len(o[1]) for o in outcome_of] + [1])
    kast_cells = np.full((len(outcome_of), width), CELLS)  # padded with CELLS, a slot worth 0
    for (floor, cells), j in outcome_of.items():
        kast_cells[j, :len(cells)] = cells
    sides = len(side_of)
    counts = lambda pairs, columns: sparse.csr_matrix(
        (np.ones(len(pairs)), ([a for a, _ in pairs], [b for _, b in pairs])), shape=(sides, columns))

    rounds_a, rated_a = np.asarray(rounds, dtype=float), np.asarray(rated, dtype=float)
    by_player = defaultdict(list)
    for (file, pid, _), i in side_of.items():
        by_player[(file, pid)].append(i)
    cells_of = {}
    for file in match_of:
        page = json.loads((root / "hltv" / file).read_text(encoding="utf-8"))
        for board in page["scoreboards"]:
            if "totalstats" not in board["cls"].split():
                continue
            for row in board["rows"]:
                cells_of[(file, str(row["pid"]))] = row["cells"]
    links, targets, match = [], defaultdict(list), []
    for (file, pid), ids in by_player.items():
        cells = cells_of.get((file, str(pid)))
        if cells is None:
            continue
        rated_sides = [i for i in ids if rounds_a[i] > 0 and rated_a[i] >= MIN_RATED_SHARE * rounds_a[i]]
        total = rounds_a[ids].sum()
        if not rated_sides or rated_a[rated_sides].sum() < MIN_RATED_SHARE * total:
            continue

        def value(prefix: str) -> str:
            for classes, v in cells:
                if prefix in classes and "eco-adjusted-data" in classes:
                    return v
            raise KeyError(f"{file}: missing the eco-adjusted {prefix} cell")

        row = len(match)
        links.extend((row, i) for i in rated_sides)
        targets["ekpr"].append(float(value("st-kills").split()[0]) / total)
        targets["edpr"].append(float(value("st-deaths").split()[0]) / total)
        targets["eadr"].append(float(value("st-adr").replace("%", "").replace("+", "")))
        targets["ekast"].append(float(value("st-kast").replace("%", "")))
        match.append(match_of[file])
    duels_out = Duels(
        kills=counts(kills, CELLS), deaths=counts(deaths, CELLS),
        damage=sparse.csr_matrix(([v for *_, v in damage], ([a for a, *_ in damage], [b for _, b, _ in damage])),
                                 shape=(sides, CELLS)),
        kast_rounds=counts(kast, len(outcome_of)),
        kast_floor=np.asarray([o[0] for o in outcome_of], dtype=float), kast_cells=kast_cells,
        rated=rated_a,
        players=sparse.csr_matrix((np.ones(len(links)), ([a for a, _ in links], [b for _, b in links])),
                                  shape=(len(match), sides)),
        targets={k: np.asarray(v) for k, v in targets.items()}, match=np.asarray(match), duels=int(duels))
    return duels_out, provenance


def eco_inputs(d: Duels, points: np.ndarray, rows=None) -> dict[str, np.ndarray]:
    """Each player-map's eKPR, eDPR, eADR and eKAST under the given kill points, as rating3.ts computes them: sums
    over the rated sides' rated rounds, divided by those rounds."""
    padded = np.r_[points, 0.0]
    kast = d.kast_rounds @ np.maximum(d.kast_floor, padded[d.kast_cells].max(axis=1))
    players = d.players if rows is None else d.players[rows]
    n = players @ d.rated
    return {"ekpr": players @ (d.kills @ points) / n, "edpr": players @ (d.deaths @ points) / n,
            "eadr": players @ (d.damage @ points) / n, "ekast": 100 * (players @ kast) / n}


def slope_at(curve: dict, x: np.ndarray) -> np.ndarray:
    """rating3.ts slopeAt: a piecewise-linear rating curve's slope at x."""
    slope = np.full(np.shape(x), float(curve["slope"]))
    for knot, change in zip(curve["knots"], curve["slope_changes"]):
        slope += change * (np.asarray(x) >= knot)
    return slope


def rating_weights(d: Duels, curves: dict) -> dict[str, np.ndarray]:
    """Per player-map, how much the rating moves per unit of each input at HLTV's value of it."""
    return {name: np.abs(slope_at(curves[curve], d.targets[name])) for name, curve in INPUTS.items()}


def residuals(d: Duels, points: np.ndarray, weights: dict, rows=None) -> np.ndarray:
    """Each player-map's input errors in rating points, one block per input: an input's error times the rating's
    slope there. Kept apart, so the fit cannot buy one input's accuracy with another's error."""
    ours = eco_inputs(d, points, rows)
    sel = slice(None) if rows is None else rows
    return np.concatenate([weights[k][sel] * (ours[k] - d.targets[k][sel]) for k in INPUTS])


def unpack(x: np.ndarray) -> tuple[np.ndarray, float]:
    return np.r_[x[:5], 0.0], float(x[5])


INITIAL = np.array([0.77, 0.60, 0.30, 0.43, 0.24, 2.03])
BOUNDS = ([-4] * 5 + [0.1], [4] * 5 + [8])


def solve(d: Duels, weights: dict, rows=None) -> np.ndarray:
    def fun(x):
        strength, scale = unpack(x)
        return residuals(d, kill_points(strength, scale), weights, rows)
    return least_squares(fun, INITIAL, bounds=BOUNDS, diff_step=1e-4, ftol=1e-10, xtol=1e-10, gtol=1e-10,
                         max_nfev=400).x


def error_summary(errors: np.ndarray) -> dict:
    return {"mae": float(errors.mean()), "p95": float(np.quantile(errors, 0.95)), "max": float(errors.max())}


def fit_model(root: Path, joins: list[dict], curves: dict) -> dict:
    """The duel block for params.json; curves are the rating curves (params.json rating.curves) the errors are
    weighed by."""
    d, provenance = collect(root, joins)
    if not len(d.match):
        raise ValueError("no joined player-map has a rated side: is the rating dump empty?")
    weights = rating_weights(d, curves)
    strength, scale = unpack(solve(d, weights))
    points = kill_points(strength, scale)

    from sklearn.model_selection import GroupKFold
    splitter = GroupKFold(n_splits=min(5, len(set(d.match))))
    held, held_inputs, base, folds, base_folds = [], defaultdict(list), [], [], []
    for fold, (train, test) in enumerate(splitter.split(d.match, d.match, d.match), start=1):
        s, sc = unpack(solve(d, weights, train))
        errors = np.abs(residuals(d, kill_points(s, sc), weights, test))
        ours = eco_inputs(d, kill_points(s, sc), test)
        for k in INPUTS:
            held_inputs[k].extend(np.abs(ours[k] - d.targets[k][test]).tolist())
        # baseline: each input at its training-fold mean, no duel model
        mean = {k: d.targets[k][train].mean() for k in INPUTS}
        base_errors = np.abs(np.concatenate([weights[k][test] * (mean[k] - d.targets[k][test]) for k in INPUTS]))
        held.extend(errors.tolist())
        base.extend(base_errors.tolist())
        info = {"fold": fold, "player_maps": len(test), "matches": len(set(d.match[test]))}
        folds.append({**info, **error_summary(errors)})
        base_folds.append({**info, **error_summary(base_errors)})
    split = {"split": f"{splitter.get_n_splits()}-fold GroupKFold by match", "player_maps": len(d.match),
             "matches": len(set(d.match))}
    return {
        "source": {
            "source": "fit",
            "script": "eco_fit.py",
            "accepted_joins": len(joins),
            "consumed_joins": provenance["consumed_joins"],
            "skipped_joins": provenance["skipped_joins"],
            "layouts": provenance["layouts"],
            "skipped": provenance["skipped"],
            "duels": d.duels,
            "targets": len(d.match),
        },
        "groups": list(GROUPS),
        "strength": dict(zip(GROUPS, strength.tolist())),
        "ct_edge": CT_EDGE,
        "kill_points_scale": scale,
        "duels": d.duels,
        "targets": len(d.match),
        "objective_mae": float(np.mean(np.abs(residuals(d, points, weights)))),
        "target_definition": {
            "predicted": "HLTV eco-adjusted kills and deaths per round, ADR and KAST per player-map, as rating3.ts "
                         "computes each over the rated rounds of the sides it rates",
            "error_scale": "each input's error times the rating curve's slope at HLTV's value (params.json "
                           "rating.curves); MAE is in rating points",
        },
        "held_out": {**split, **error_summary(np.asarray(held)), "folds": folds,
                     "inputs_mae": {k: float(np.mean(v)) for k, v in held_inputs.items()}},
        "held_out_baseline": {"model": "training-fold mean of each input; no duel features", **split,
                              **error_summary(np.asarray(base)), "folds": base_folds},
        "status": "joint fit to eKPR, eDPR, eADR and eKAST weighted by the rating's slopes",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--joins", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--params", type=Path, default=PARAMS, help="params.json whose rating curves weigh the errors")
    args = parser.parse_args()
    # private: built from HLTV rows and pro demos; checked before any data is read
    check_output(args.out, private=True, what="the eco fit report")
    joins = json.loads(args.joins.read_text(encoding="utf-8"))["accepted"]
    curves = json.loads(args.params.read_text(encoding="utf-8"))["rating"]["curves"]
    result = fit_model(args.data, joins, curves)
    write_json(args.out, result, private=True, what="the eco fit report", indent=2)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
