"""Research HLTV's per-event credit allocation on strictly validated demo joins."""
from __future__ import annotations
import argparse
from collections import defaultdict
import json
from pathlib import Path
import re
import runpy


def nickname(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def credits(player: dict, round_name: str, event_index: int) -> float:
    tooltip = player["events"][round_name][event_index][1]
    match = re.search(r"(?:^| \| )" + re.escape(player["nick"]) + r" \| ([+-][\d.]+)%", tooltip)
    return float(match[1]) / 100 if match else 0.0


def joined_events(root: Path, joins: list[dict]):
    import pyarrow.parquet as pq
    for join in joins:
        directory = root / join["demo"]
        data = json.loads((root / "hltv" / join["hltv"]).read_text(encoding="utf-8"))
        economy = pq.read_table(directory / "economy.parquet").to_pylist()
        names = {r["steamid"]: nickname(r["name"]) for r in economy}
        sid_by_name = {name: sid for sid, name in names.items()}
        players = data["performance"]["players"]
        player_ids = [sid_by_name[nickname(p["nick"])] for p in players]
        kills = pq.read_table(directory / "kills.parquet").to_pylist()
        damages = pq.read_table(directory / "damages.parquet").to_pylist()
        blinds = pq.read_table(directory / "blinds.parquet").to_pylist()
        rounds = {r["round"]: r for r in pq.read_table(directory / "rounds.parquet").to_pylist()}
        tick_rate = pq.read_table(directory / "meta.parquet", columns=["tick_rate"]).to_pylist()[0]["tick_rate"]
        for round_name, rd in data["performance"]["rounds"].items():
            number = int(round_name[5:])
            kills_round = [k for k in kills if k["round"] == number]
            damage_round = [d for d in damages if d["round"] == number]
            sides = {r["steamid"]: r["side"] for r in economy if r["round"] == number}
            alive = set(player_ids)
            positive_kill_credit = set()
            for index, event in enumerate(rd["events"]):
                observed = {sid: credits(p, round_name, index) for sid, p in zip(player_ids, players)}
                previous_y = float(rd["events"][index - 1]["y"]) if index else float(event["y"])
                delta = abs(float(event["y"]) - previous_y)
                kill = None
                shares = defaultdict(float)
                flash = set()
                traded = []
                future_trades = []
                if " killed " in event["title"]:
                    attacker, victim = [sid_by_name[nickname(n)] for n in event["title"].split(" killed ", 1)]
                    matching = [k for k in kills_round if k["attacker_steamid"] == attacker and k["victim_steamid"] == victim]
                    if len(matching) != 1:
                        raise ValueError(f"{join['hltv']}/{round_name}/{index}: kill not uniquely joined")
                    kill = matching[0]
                    for d in damage_round:
                        if d["victim_steamid"] == victim and d["tick"] <= kill["tick"] and not d["is_team_damage"] and not d["is_self"]:
                            shares[d["attacker_steamid"]] += d["dmg_health_capped"]
                    for b in blinds:
                        if b["round"] == number and b["victim_steamid"] == victim and b["tick"] <= kill["tick"]:
                            if (kill["tick"] - b["tick"]) / tick_rate < b["duration"] and b["attacker_steamid"] != attacker and not b["is_team_flash"]:
                                flash.add(b["attacker_steamid"])
                    traded = [k for k in kills_round if k["attacker_steamid"] == victim
                              and k["a_side"] != k["v_side"] and 0 <= kill["tick"] - k["tick"] <= 5 * tick_rate
                              and k["tick"] != kill["tick"]]
                    future_trades = [k for k in kills_round if k["victim_steamid"] == attacker and k["a_side"] != k["v_side"]
                                     and 0 < k["tick"] - kill["tick"] <= 5 * tick_rate]
                    alive.discard(victim)
                    if delta > 0:
                        positive_kill_credit.update(sid for sid, value in observed.items() if value > 0)
                elif " committed suicide" in event["title"]:
                    alive.discard(sid_by_name[nickname(event["title"].split(" committed suicide")[0])])
                yield {"map": join["hltv"], "round": number, "index": index, "event": event,
                       "observed": observed, "delta": delta, "kill": kill, "damage": dict(shares),
                       "flash": flash, "traded": traded, "future_trades": future_trades,
                       "alive": set(alive), "sides": sides, "positive": set(positive_kill_credit),
                       "round_data": rounds[number], "player_ids": player_ids,
                       "per_round": {sid: float(dict(p["perRound"])[str(number)]) for sid, p in zip(player_ids, players)}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--joins", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    helpers = runpy.run_path(str(Path(__file__).with_name("winprob_fit.py")))
    helpers["idle"]()
    import numpy as np
    events = list(joined_events(args.data, json.loads(args.joins.read_text())["accepted"]))
    buckets = defaultdict(list)
    debit = defaultdict(list)
    sums = defaultdict(float)
    truths = {}
    samples = []
    for row in events:
        for sid, amount in row["observed"].items():
            key = (row["map"], row["round"], sid)
            sums[key] += amount
            truths[key] = row["per_round"][sid]
        k = row["kill"]
        delta = row["delta"]
        if not k or delta < .001:
            continue
        a, v = k["attacker_steamid"], k["victim_steamid"]
        helpers_damage = {sid: dmg for sid, dmg in row["damage"].items() if sid != a and dmg > 0}
        label = f"damage={bool(helpers_damage)} flash={bool(row['flash'])} trade={bool(row['traded'])}"
        buckets[label].append(row["observed"][a] / delta)
        debit[f"future_trade={bool(row['future_trades'])}"].append(-row["observed"][v] / delta)
        if len(samples) < 80:
            samples.append({"map": row["map"], "round": row["round"], "index": row["index"],
                            "title": row["event"]["title"], "delta": delta,
                            "credits": {str(s): x / delta for s, x in row["observed"].items() if x},
                            "attacker": a, "victim": v, "damage": row["damage"],
                            "flash": list(row["flash"]), "trade": [x["victim_steamid"] for x in row["traded"]],
                            "future_trade": bool(row["future_trades"])})
    summarise = lambda values: {"n": len(values), "median": float(np.median(values)), "p05": float(np.quantile(values,.05)), "p95": float(np.quantile(values,.95))}
    result = {"events": len(events), "kill_credit_ratios": {k: summarise(v) for k, v in buckets.items()},
              "victim_debit_ratios": {k: summarise(v) for k, v in debit.items()},
              "tooltip_round_sum": helpers["error_metrics"]([truths[k] for k in sums], list(sums.values())),
              "samples": samples}
    args.out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in result.items() if k != "samples"}, indent=2))


if __name__ == "__main__":
    main()
