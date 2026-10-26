"""Fit HLTV per-event Swing credit on strictly validated demo joins."""
from __future__ import annotations

import argparse
from collections import defaultdict
import json
from pathlib import Path
import re
import runpy
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from demo_paths import load_demo_tables
sys.path.append(str(Path(__file__).resolve().parents[2] / "extractor"))
from repo_guard import check_output, write_json  # noqa: E402  (extractor/repo_guard.py: where outputs may land)


def nickname(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def credits(player: dict, round_name: str, event_index: int) -> float:
    tooltip = player["events"][round_name][event_index][1]
    match = re.search(r"(?:^| \| )" + re.escape(player["nick"]) + r" \| ([+-][\d.]+)%", tooltip)
    return float(match[1]) / 100 if match else 0.0


def empty_provenance() -> dict:
    return {
        "consumed_joins": 0,
        "skipped_joins": 0,
        "layouts": {"schema_v1": 0, "legacy": 0},
        "skipped": [],
        "unattributed_damage_hp": 0,
        "excluded_damage_rows": 0,
    }


def joined_events(root: Path, joins: list[dict], provenance: dict | None = None):
    import pyarrow.parquet as pq

    provenance = provenance if provenance is not None else empty_provenance()
    for join in joins:
        try:
            layout, tables = load_demo_tables(
                root,
                join["demo"],
                ("player_rounds", "match", "kills", "damages", "blinds", "rounds"),
                pq.read_table,
            )
            economy = tables["player_rounds"].to_pylist()
            match = tables["match"].to_pylist()[0]
            kills = tables["kills"].to_pylist()
            damages = tables["damages"].to_pylist()
            blinds = tables["blinds"].to_pylist()
            rounds = {r["round"]: r for r in tables["rounds"].to_pylist()}
        except FileNotFoundError as error:
            provenance["skipped_joins"] += 1
            provenance["skipped"].append({"demo": join["demo"], "reason": str(error)})
            continue

        provenance["consumed_joins"] += 1
        provenance["layouts"][layout.format] += 1
        provenance["unattributed_damage_hp"] += int(match.get("unattributed_damage_hp", 0) or 0)
        names = {r["steamid"]: nickname(r["name"]) for r in economy}
        sid_by_name = {name: sid for sid, name in names.items()}
        data = json.loads((root / "hltv" / join["hltv"]).read_text(encoding="utf-8"))
        match_id = str(data.get("match", {}).get("matchId", match.get("match_id", join["hltv"])))
        players = data["performance"]["players"]
        player_ids = [sid_by_name[nickname(p["nick"])] for p in players]
        tick_rate = float(match["tick_rate"])
        for round_name, round_data in data["performance"]["rounds"].items():
            number = int(round_name[5:])
            kills_round = [k for k in kills if k["round"] == number]
            damage_round = [d for d in damages if d["round"] == number]
            sides = {r["steamid"]: r["side"] for r in economy if r["round"] == number}
            alive = set(player_ids)
            positive_kill_credit = set()
            for index, event in enumerate(round_data["events"]):
                observed = {sid: credits(p, round_name, index) for sid, p in zip(player_ids, players)}
                previous_y = float(round_data["events"][index - 1]["y"]) if index else float(event["y"])
                delta = abs(float(event["y"]) - previous_y)
                kill = None
                shares = defaultdict(float)
                damage_seen = False
                flash = set()
                traded = []
                future_trades = []
                if " killed " in event["title"]:
                    attacker, victim = [sid_by_name[nickname(n)] for n in event["title"].split(" killed ", 1)]
                    matching = [k for k in kills_round if k["attacker_steamid"] == attacker and k["victim_steamid"] == victim]
                    if len(matching) != 1:
                        raise ValueError(f"{join['hltv']}/{round_name}/{index}: kill not uniquely joined")
                    kill = matching[0]
                    for damage in damage_round:
                        if damage["victim_steamid"] == victim and damage["tick"] <= kill["tick"]:
                            if not damage["is_team_damage"] and not damage["is_self"]:
                                if damage.get("attacker_steamid") != attacker:
                                    damage_seen = True
                                if (
                                    damage.get("source") == "health"
                                    or damage.get("reconstructed_ambiguous")
                                    or damage.get("attacker_steamid") is None
                                ):
                                    provenance["excluded_damage_rows"] += 1
                                    continue
                                if damage["attacker_steamid"] != attacker:
                                    shares[damage["attacker_steamid"]] += damage["dmg_health_capped"]
                    for blind in blinds:
                        if blind["round"] == number and blind["victim_steamid"] == victim and blind["tick"] <= kill["tick"]:
                            if (
                                (kill["tick"] - blind["tick"]) / tick_rate < blind["duration"]
                                and blind["attacker_steamid"] != attacker
                                and not blind["is_team_flash"]
                                and not blind.get("ambiguous", False)
                            ):
                                flash.add(blind["attacker_steamid"])
                    traded = [
                        k for k in kills_round
                        if k["attacker_steamid"] == victim
                        and k["a_side"] != k["v_side"]
                        and 0 <= kill["tick"] - k["tick"] <= 5 * tick_rate
                        and k["tick"] != kill["tick"]
                    ]
                    future_trades = [
                        k for k in kills_round
                        if k["victim_steamid"] == attacker
                        and k["a_side"] != k["v_side"]
                        and 0 < k["tick"] - kill["tick"] <= 5 * tick_rate
                    ]
                    alive.discard(victim)
                    if delta > 0:
                        positive_kill_credit.update(sid for sid, value in observed.items() if value > 0)
                elif " committed suicide" in event["title"]:
                    alive.discard(sid_by_name[nickname(event["title"].split(" committed suicide")[0])])
                yield {
                    "map": join["hltv"],
                    "layout": layout.format,
                    "match": match_id,
                    "round": number,
                    "index": index,
                    "event": event,
                    "observed": observed,
                    "delta": delta,
                    "kill": kill,
                    "damage": dict(shares),
                    "damage_seen": damage_seen,
                    "flash": flash,
                    "traded": traded,
                    "future_trades": future_trades,
                    "alive": set(alive),
                    "sides": sides,
                    "positive": set(positive_kill_credit),
                    "round_data": rounds[number],
                    "player_ids": player_ids,
                    "per_round": {sid: float(dict(p["perRound"])[str(number)]) for sid, p in zip(player_ids, players)},
                }


def fit_model(events: list[dict]) -> dict:
    import numpy as np

    buckets = defaultdict(list)
    debit = defaultdict(list)
    samples = []
    for row in events:
        kill = row["kill"]
        delta = row["delta"]
        if not kill or delta < 0.001:
            continue
        attacker = kill["attacker_steamid"]
        victim = kill["victim_steamid"]
        flash_count = len(row["flash"])
        label = f"damage={row['damage_seen']} flash={flash_count if flash_count < 2 else '2+'} trade={bool(row['traded'])}"
        buckets[label].append(row["observed"][attacker] / delta)
        debit[f"future_trade={bool(row['future_trades'])}"].append(-row["observed"][victim] / delta)
        if len(samples) < 80:
            samples.append({
                "map": row["map"],
                "round": row["round"],
                "index": row["index"],
                "title": row["event"]["title"],
                "delta": delta,
                "credits": {str(s): x / delta for s, x in row["observed"].items() if x},
                "attacker": attacker,
                "victim": victim,
                "damage": row["damage"],
                "flash": list(row["flash"]),
                "trade": [x["victim_steamid"] for x in row["traded"]],
                "future_trade": bool(row["future_trades"]),
            })

    def summarise(values: list[float]) -> dict:
        return {
            "n": len(values),
            "median": float(np.median(values)),
            "p05": float(np.quantile(values, 0.05)),
            "p95": float(np.quantile(values, 0.95)),
        }

    return {
        "events": len(events),
        "kill_credit_ratios": {key: summarise(values) for key, values in buckets.items()},
        "victim_debit_ratios": {key: summarise(values) for key, values in debit.items()},
        "note": "perRound is not additive over event tooltip credits; fit the observed player credits directly",
        "samples": samples,
    }


def single_flash_observations(events: list[dict]) -> list[tuple[str, float]]:
    """Return match and killer credit ratio for the clean single-flash bucket."""
    return [
        (row["match"], row["observed"][row["kill"]["attacker_steamid"]] / row["delta"])
        for row in events
        if row["kill"]
        and row["delta"] >= 0.001
        and not row["damage_seen"]
        and len(row["flash"]) == 1
        and not row["traded"]
    ]


def held_out_flash_error(events: list[dict], key: str) -> dict:
    import numpy as np
    from sklearn.model_selection import GroupKFold

    observations = single_flash_observations(events)
    if len(observations) < 5:
        return {"split": "insufficient observations", "n": len(observations)}
    groups = np.asarray([item[0] for item in observations])
    if len(set(groups)) < 2:
        return {"split": "insufficient match groups", "n": len(observations), "matches": int(len(set(groups)))}
    values = np.asarray([item[1] for item in observations], dtype=float)
    predicted = np.empty(len(values), dtype=float)
    folds = []
    splitter = GroupKFold(n_splits=min(5, len(set(groups))))
    for fold, (train, test) in enumerate(splitter.split(values, values, groups), start=1):
        estimate = float(np.median(values[train]))
        predicted[test] = estimate
        error = np.abs(values[test] - estimate)
        folds.append({
            "fold": fold,
            "n": int(len(test)),
            "matches": int(len(set(groups[test]))),
            "median": estimate,
            "mae": float(error.mean()),
            "p95": float(np.quantile(error, 0.95)),
            "max": float(error.max()),
        })
    error = np.abs(values - predicted)
    return {
        "split": f"{splitter.n_splits}-fold GroupKFold by match",
        "n": int(len(values)),
        "matches": int(len(set(groups))),
        "mae": float(error.mean()),
        "p95": float(np.quantile(error, 0.95)),
        "max": float(error.max()),
        "folds": folds,
        "target": key,
    }


def fit_block(data_root: Path, joins_path: Path) -> dict:
    joins = json.loads(joins_path.read_text(encoding="utf-8"))
    provenance = empty_provenance()
    events = list(joined_events(data_root, joins["accepted"], provenance))
    metrics = fit_model(events)
    key = "damage=False flash=1 trade=False"
    if key not in metrics["kill_credit_ratios"]:
        raise ValueError(f"no clean single-flash observations found for {key}")
    comparison = {}
    for label in ("schema_v1", "legacy"):
        subset = [row for row in events if row["layout"] == label]
        observations = single_flash_observations(subset)
        ratio = fit_model(subset)["kill_credit_ratios"].get(key)
        comparison[label] = {
            "sample_size": len(observations),
            "matches": len({match for match, _ in observations}),
            "killer_credit_median": ratio["median"] if ratio else None,
            "flash_credit_fraction": float(1.0 - ratio["median"]) if ratio else None,
        }
    flash_ratio = metrics["kill_credit_ratios"][key]
    return {
        "source": {
            "source": "fit",
            "script": "swing_fit.py",
            "accepted_joins": joins["counts"]["accepted"],
            "consumed_joins": provenance["consumed_joins"],
            "skipped_joins": provenance["skipped_joins"],
            "layouts": provenance["layouts"],
            "skipped": provenance["skipped"],
            "events": metrics["events"],
            "unattributed_damage_hp": provenance["unattributed_damage_hp"],
            "excluded_damage_rows": provenance["excluded_damage_rows"],
            "flash_calibration_layout": "all_consumed_joins",
            "flash_calibration_events": flash_ratio["n"],
            "layout_comparison": comparison,
        },
        "event_credit_model": "damage_share_then_single_flash_residual",
        "assist_damage": 40,
        "trade_window_seconds": 5.0,
        "flash_credit_fraction": float(1.0 - flash_ratio["median"]),
        "flash_credit_sample_size": flash_ratio["n"],
        "held_out": held_out_flash_error(events, key),
        "zero_rules": [
            "unpreventable post-bomb kills have zero swing",
            "kill credit is never negative",
            "failed trade victim still receives the full victim debit",
            "round with an unvalued probability event is unknown",
            "unattributed, health-reconstructed, or ambiguous damage rows do not receive damage-share credit",
        ],
        "round_end_remainder": {
            "clutcher_weight": 1,
            "kill_swing_player_weight": 2,
            "defuser_weight": 1,
            "survivor_weight": 1,
        },
        "fit_status": "event split partially recovered; round-end remainder not yet fitted to player-map totals",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--joins", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    # private: built from HLTV rows and pro demos; checked before any data is read
    check_output(args.out, private=True, what="the swing fit report")
    helpers = runpy.run_path(str(Path(__file__).with_name("winprob_fit.py")))
    helpers["idle"]()
    provenance = empty_provenance()
    events = list(joined_events(args.data, json.loads(args.joins.read_text(encoding="utf-8"))["accepted"], provenance))
    result = fit_model(events)
    result["provenance"] = provenance
    write_json(args.out, result, private=True, what="the swing fit report", indent=2)
    print(json.dumps({key: value for key, value in result.items() if key != "samples"}, indent=2))


if __name__ == "__main__":
    main()
