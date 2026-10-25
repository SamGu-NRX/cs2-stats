"""Inspect and reconstruct HLTV event probabilities without copying source maps.

Run with model/.venv/Scripts/python.exe -I and an explicit --data directory.
Validation holds out whole matches, in chronological order. Targets use HLTV's
full-precision y, not the one-decimal tooltip. All errors are percentage points.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re


def idle() -> None:
    """Fail rather than silently run a fitting job above the requested priority."""
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = ctypes.c_void_p
        kernel.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        if not kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x40):
            raise ctypes.WinError(ctypes.get_last_error())
    else:
        os.nice(19)


def load_rows(root: Path) -> tuple[list[dict], dict]:
    rows = []
    versions = Counter()
    sources = []
    buy_re = re.compile(r"\$([\d.]+)(K?)\s*\(([^)]+)\)")
    map_re = re.compile(r"Map(Ancient|Anubis|Cache|Dust2|Inferno|Mirage|Nuke)")
    # ct_win/t_win icons also label suicides. Only these three icons end a round.
    end_icons = {"bomb_exploded.svg", "bomb_defused.svg", "stopwatch.svg"}
    for path in sorted(root.glob("map_*.json")):
        content = path.read_bytes()
        data = json.loads(content)
        versions[data.get("v")] += 1
        if data.get("v") != 3:
            continue
        mid = str(data["mapstatsid"])
        match = str(data["match"]["matchId"])
        info = data["info"][0]
        found_map = map_re.search(info)
        date = re.search(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", info)
        if not found_map or not date:
            raise ValueError(f"{path.name}: missing map or date")
        if date[0] < "2026-10-01":
            continue
        sources.append({"file": path.name, "sha256": hashlib.sha256(content).hexdigest()})
        performance = data["performance"]
        players = performance["players"]
        for round_name, round_data in performance["rounds"].items():
            events = round_data["events"]
            if not events:
                continue
            if events[0]["icon"] != "buy.png":
                raise ValueError(f"{path.name}/{round_name}: missing buy event")
            first_team_pids = {str(p["pid"]) for p in data["scoreboards"][0]["rows"]}
            # Team display names differ between tables and tooltips, so join by player ID.
            # Each player's tooltip lists their own team first; the graph uses team 1.
            texts = [p["events"][round_name][0][1] for p in players if round_name in p["events"]
                     and str(p["pid"]) in first_team_pids]
            if not texts or len(set(texts)) != 1:
                raise ValueError(f"{path.name}/{round_name}: inconsistent equipment tooltip")
            economy = buy_re.findall(texts[0])
            if len(economy) != 2:
                raise ValueError(f"{path.name}/{round_name}: cannot parse economy {texts[0]!r}")
            equipment = [round(float(value) * (1000 if suffix else 1)) for value, suffix, _ in economy]
            buys = [buy for _, _, buy in economy]
            side = round_data["side"]
            if side not in ("t-side", "ct-side"):
                raise ValueError(f"{path.name}/{round_name}: unknown side {side!r}")
            ti = 0 if side == "t-side" else 1
            planted = False
            ended = False
            last_kill_side = "none"
            terminal_t = None
            for index, event in enumerate(events):
                icon = event["icon"]
                actor = event["badge"].split("_")[0]
                if icon in {"kill.svg", "ct_win.svg", "t_win.svg"}:
                    last_kill_side = actor
                planted |= icon == "bombplant.svg"
                ended |= icon in end_icons
                if icon in end_icons:
                    terminal_t = int(icon in {"bomb_exploded.svg", "t_win.svg"})
                probability = float(event["y"])
                target = probability if ti == 0 else 1 - probability
                alive = event["alive"]
                if not 0 <= probability <= 1 or len(alive) != 2:
                    raise ValueError(f"{path.name}/{round_name}/{index}: invalid probability or alive state")
                rows.append({
                    "map_id": mid, "match": match, "date": date[0], "map": found_map[1],
                    "round": round_name, "index": index, "icon": icon,
                    "alive_t": alive[ti], "alive_ct": alive[1 - ti],
                    "buy_t": buys[ti], "buy_ct": buys[1 - ti],
                    "equip_t": equipment[ti], "equip_ct": equipment[1 - ti],
                    "planted": int(planted), "ended": int(ended), "target": target,
                    "actor": actor, "last_kill_side": last_kill_side, "terminal_t": terminal_t,
                })
    return rows, {"versions": dict(versions), "sources": sources}


def error_metrics(actual, predicted) -> dict:
    import numpy as np
    error = 100 * np.abs(np.asarray(actual) - np.asarray(predicted))
    return {"n": len(error), "mae_pp": float(error.mean()),
            "rmse_pp": float(np.sqrt(np.mean(error ** 2))),
            "p95_pp": float(np.quantile(error, .95)), "max_pp": float(error.max())}


def lookup(rows: list[dict], columns: tuple[str, ...]) -> dict:
    groups = defaultdict(list)
    for row in rows:
        groups[tuple(row[col] for col in columns)].append(row["target"])
    return groups


def exactness(rows: list[dict], columns: tuple[str, ...]) -> dict:
    import numpy as np
    groups = lookup(rows, columns)
    repeated = [values for values in groups.values() if len(values) > 1]
    fixed = [values for values in repeated if max(values) - min(values) < 1e-10]
    deviations = [abs(value - np.median(values)) for values in groups.values() for value in values]
    return {"columns": columns, "states": len(groups), "repeated_states": len(repeated),
            "constant_repeated_states": len(fixed), "events_in_constant_repeated_states": sum(map(len, fixed)),
            "within_state_median_mae_pp": float(100 * np.mean(deviations)),
            "largest_state_range_pp": 100 * max(max(v) - min(v) for v in groups.values())}


BASE = ("map", "alive_t", "alive_ct", "planted")


def fit_lookup(rows: list[dict], context: tuple[str, ...]) -> list[dict]:
    import numpy as np
    active = [r for r in rows if not r["ended"]]
    # Back off to a pooled-map table before dropping the economic matchup.
    levels = [BASE + ("buy_t", "buy_ct") + context,
              BASE[1:] + ("buy_t", "buy_ct") + context,
              BASE + ("buy_t", "buy_ct"), BASE[1:] + ("buy_t", "buy_ct"),
              BASE + context, BASE[1:] + context, BASE, BASE[1:]]
    tables = []
    for columns in dict.fromkeys(levels):
        groups = lookup(active, columns)
        tables.append({"columns": columns, "states": {
            "|".join(map(str, key)): {"p_t": float(np.median(values)), "n": len(values)}
            for key, values in sorted(groups.items())}})
    return tables


def predict_lookup(rows: list[dict], tables: list[dict]) -> tuple[list[float], list[int]]:
    predictions, levels = [], []
    for row in rows:
        if row["terminal_t"] is not None:
            predictions.append(float(row["terminal_t"]))
            levels.append(-1)
            continue
        for level, table in enumerate(tables):
            key = "|".join(str(row[col]) for col in table["columns"])
            if key in table["states"]:
                predictions.append(table["states"][key]["p_t"])
                levels.append(level)
                break
        else:
            raise ValueError(f"No observed alive/bomb state for {row}")
    return predictions, levels


def chronological_split(rows: list[dict]) -> tuple[list[dict], list[dict], list[dict], dict]:
    # A series can cross a calendar boundary. Its latest observed map determines
    # the split, so maps from the same match cannot leak between partitions.
    dates = {}
    for row in rows:
        dates[row["match"]] = max(dates.get(row["match"], ""), row["date"])
    matches = sorted(dates, key=lambda match: (dates[match], match))
    a, b = int(.7 * len(matches)), int(.85 * len(matches))
    names = ("train", "validation", "test")
    assignment = {match: names[0 if i < a else 1 if i < b else 2] for i, match in enumerate(matches)}
    subsets = [[r for r in rows if assignment[r["match"]] == name] for name in names]
    metadata = {name: {"matches": [m for m in matches if assignment[m] == name],
                       "events": len(subset), "first_date": min(r["date"] for r in subset),
                       "last_date": max(r["date"] for r in subset)}
                for name, subset in zip(names, subsets)}
    return *subsets, metadata


def evaluate(rows: list[dict], tables: list[dict]) -> dict:
    import numpy as np
    predictions, levels = predict_lookup(rows, tables)
    targets = [r["target"] for r in rows]
    result = {"overall": error_metrics(targets, predictions), "lookup_levels": dict(Counter(levels))}
    masks = {"active": [not r["ended"] for r in rows],
             "terminal": [bool(r["ended"]) for r in rows],
             "preplant": [not r["ended"] and not r["planted"] for r in rows],
             "postplant": [not r["ended"] and bool(r["planted"]) for r in rows],
             "outnumbered_1vX": [not r["ended"] and min(r["alive_t"], r["alive_ct"]) == 1
                                  and max(r["alive_t"], r["alive_ct"]) > 1 for r in rows]}
    for field in ("map", "icon", "buy_t", "buy_ct"):
        masks.update({f"{field}={value}": [r[field] == value for r in rows] for value in sorted({r[field] for r in rows})})
    result["situations"] = {name: error_metrics(np.array(targets)[mask], np.array(predictions)[mask])
                            for name, mask in masks.items() if any(mask)}
    active = [i for i, r in enumerate(rows) if not r["ended"]]
    exact = sum(abs(targets[i] - predictions[i]) < 1e-10 for i in active)
    result["active_exact_fraction"] = exact / len(active)
    worst = np.argsort(-np.abs(np.array(targets) - predictions))[:20]
    result["largest_errors"] = [{**rows[i], "predicted": predictions[i], "level": levels[i]} for i in worst]
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--params", type=Path, help="Write the selected lookup parameters for TypeScript")
    args = parser.parse_args()
    idle()
    # One BLAS/OpenMP worker keeps this job out of the way of games and other jobs.
    for name in ("OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "OMP_NUM_THREADS"):
        os.environ[name] = "1"
    import numpy as np
    rows, audit = load_rows(args.data)
    active = [r for r in rows if not r["ended"]]
    base = ("map", "alive_t", "alive_ct", "planted")
    keys = [base, base + ("buy_t", "buy_ct"), base + ("equip_t", "equip_ct"),
            base + ("buy_t", "buy_ct", "icon"),
            base + ("buy_t", "buy_ct", "actor"),
            base + ("buy_t", "buy_ct", "last_kill_side"),
            base + ("buy_t", "buy_ct", "actor", "icon")]
    report = {"source_audit": audit, "events": len(rows), "active_events": len(active),
              "matches": len({r["match"] for r in rows}),
              "buy_types": dict(Counter(r["buy_t"] for r in rows)),
              "exactness": [exactness(active, key) for key in keys]}
    train, validation, test, splits = chronological_split(rows)
    report["splits"] = splits
    candidates = {"state_only": (), "last_kill_side": ("last_kill_side",),
                  "actor": ("actor",), "last_kill_and_icon": ("last_kill_side", "icon")}
    fitted = {name: fit_lookup(train, columns) for name, columns in candidates.items()}
    report["validation"] = {name: evaluate(validation, model) for name, model in fitted.items()}
    selected = min(candidates, key=lambda name: report["validation"][name]["overall"]["mae_pp"])
    report["selected"] = selected
    report["test"] = evaluate(test, fitted[selected])
    report["test_state_only"] = evaluate(test, fitted["state_only"])
    report["equipment_ranges"] = {side: {
        buy: {"min": min(r[f"equip_{side}"] for r in rows if r[f"buy_{side}"] == buy),
              "max": max(r[f"equip_{side}"] for r in rows if r[f"buy_{side}"] == buy)}
        for buy in sorted({r[f"buy_{side}"] for r in rows})} for side in ("t", "ct")}
    summary = {"events": len(rows), "maps": len(audit["sources"]), "selected": selected,
               "validation": {name: value["overall"] for name, value in report["validation"].items()},
               "test": report["test"]["overall"], "test_situations": report["test"]["situations"],
               "test_active_exact_fraction": report["test"]["active_exact_fraction"],
               "equipment_ranges": report["equipment_ranges"]}
    print(json.dumps(summary, indent=2), flush=True)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if args.params:
        parameters = json.loads(args.params.read_text(encoding="utf-8")) if args.params.exists() else {"version": 1}
        parameters["winProbability"] = {
            "target": "HLTV Rating 3.02, post-2026-10-01", "units": "P(T wins)",
            "method": "Hierarchical median lookup, selected on chronological validation matches",
            "selection": selected, "source_maps": len(audit["sources"]),
            "training_matches": splits["train"]["matches"], "test": report["test"]["overall"],
            "note": "Training partition only. Test matches were not added after evaluation.",
            "tables": fitted[selected],
        }
        args.params.write_text(json.dumps(parameters, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
