"""Join post-plant HLTV event points to demo ticks and test defuse timing rules."""
from __future__ import annotations

import argparse
from collections import defaultdict
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from demo_paths import demo_layout
sys.path.append(str(Path(__file__).resolve().parents[2] / "extractor"))
from repo_guard import check_output, write_json  # noqa: E402  (extractor/repo_guard.py: where outputs may land)


def norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def read_join(root: Path, join: dict) -> list[dict]:
    import pyarrow.parquet as pq

    layout = demo_layout(root, join["demo"])
    hltv = json.loads((root / "hltv" / join["hltv"]).read_text(encoding="utf-8"))
    players_rounds = pq.read_table(layout.table("player_rounds")).to_pylist()
    names = {row["steamid"]: norm(row["name"]) for row in players_rounds}
    rounds = {row["round"]: row for row in pq.read_table(layout.table("rounds")).to_pylist()}
    kills = defaultdict(list)
    for kill in sorted(pq.read_table(layout.table("kills")).to_pylist(), key=lambda row: row["tick"]):
        kills[kill["round"]].append(kill)
    tick_rate = pq.read_table(layout.table("match"), columns=["tick_rate"]).to_pylist()[0]["tick_rate"]
    out = []
    for round_name, round_data in hltv["performance"]["rounds"].items():
        round_number = int(round_name[5:])
        round_row = rounds[round_number]
        demo_kills = kills[round_number]
        kill_index = 0
        plant = None
        kit_holders = {
            row["steamid"]
            for row in players_rounds
            if row["round"] == round_number and row["side"] == "CT" and row["defuser"]
        }
        alive = {row["steamid"] for row in players_rounds if row["round"] == round_number}
        for index, event in enumerate(round_data["events"]):
            tick = None
            victim = None
            if event["icon"] == "bombplant.svg":
                plant = round_row["plant_tick"]
                tick = plant
            elif " killed " in event["title"]:
                attacker_name, victim_name = map(norm, event["title"].split(" killed ", 1))
                while kill_index < len(demo_kills):
                    candidate = demo_kills[kill_index]
                    if (
                        candidate["is_suicide"]
                        or candidate["is_teamkill"]
                        or names.get(candidate.get("attacker_steamid"), "?") != attacker_name
                        or names.get(candidate.get("victim_steamid"), "?") != victim_name
                    ):
                        kill_index += 1
                        continue
                    tick = candidate["tick"]
                    victim = candidate["victim_steamid"]
                    kill_index += 1
                    break
            elif event["icon"] in {"bomb_exploded.svg", "bomb_defused.svg", "stopwatch.svg"}:
                tick = round_row["end_tick"]
            if victim is not None:
                alive.discard(victim)
                kit_holders.discard(victim)
            if plant is not None and tick is not None and tick >= plant:
                explosion_tick = round_row["explode_tick"] if round_row["explode_tick"] is not None else plant + 40 * tick_rate
                kits = sum(steamid in alive for steamid in kit_holders)
                out.append({
                    "map": join["hltv"],
                    "round": round_number,
                    "index": index,
                    "icon": event["icon"],
                    "title": event["title"],
                    "badge": event.get("badge"),
                    "tick": tick,
                    "plant_tick": plant,
                    "end_tick": round_row["end_tick"],
                    "explosion_tick": explosion_tick,
                    "seconds_left": (explosion_tick - tick) / tick_rate,
                    "kits_alive": kits,
                    "y": float(event["y"]),
                    "alive": event["alive"],
                    "side": round_data["side"],
                    "reason": round_row["reason"],
                })
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--joins", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    # private: built from HLTV rows and pro demos; checked before any data is read
    check_output(args.out, private=True, what="the post-plant report")
    joins = json.loads(args.joins.read_text(encoding="utf-8"))["accepted"]
    rows = [row for join in joins for row in read_join(args.data, join)]

    by_round = defaultdict(list)
    for row in rows:
        by_round[(row["map"], row["round"])].append(row)
    for values in by_round.values():
        values.sort(key=lambda row: row["index"])
        for index, row in enumerate(values):
            row["next_y"] = values[index + 1]["y"] if index + 1 < len(values) else None
            row["changed_after"] = row["next_y"] is not None and abs(row["next_y"] - row["y"]) > 1e-12

    import numpy as np

    candidates = {}
    for kit in range(6):
        for threshold in np.arange(0, 20.01, 0.25):
            test = [row for row in rows if row["icon"] == "kill.svg" and row["kits_alive"] == kit]
            low = [row for row in test if row["seconds_left"] <= threshold]
            high = [row for row in test if row["seconds_left"] > threshold]
            candidates[f"kit{kit}_threshold{threshold:g}"] = {
                "n": len(test),
                "threshold": float(threshold),
                "kit": kit,
                "low_n": len(low),
                "low_unchanged": sum(not row["changed_after"] for row in low),
                "high_n": len(high),
                "high_unchanged": sum(not row["changed_after"] for row in high),
            }
    result = {
        "rows": len(rows),
        "rounds": len(by_round),
        "postplant_rounds": len(by_round),
        "events_changed_after_plant": sum(row["changed_after"] for row in rows),
        "rows_data": rows,
        "candidate_thresholds": candidates,
    }
    write_json(args.out, result, private=True, what="the post-plant report", indent=2)
    print(json.dumps({key: result[key] for key in ("rows", "rounds", "events_changed_after_plant")}, indent=2))


if __name__ == "__main__":
    main()
