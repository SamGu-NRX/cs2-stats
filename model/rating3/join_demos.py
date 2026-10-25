"""Validate demo/HLTV map joins in place; save identifiers and checks, not tables.

Requires matching map, an archive timestamp within 36 hours of HLTV's match
start, both five-player rosters, every round winner, and every enemy-kill pair
in order. The timestamp window permits a local archive timestamp and long
series, but is not enough to accept a join without the event checks.
"""
from __future__ import annotations
import argparse
from collections import defaultdict, Counter
from datetime import datetime
import json
from pathlib import Path
import re
import runpy


def nickname(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def hltv_index(root: Path, sources: list[dict]) -> dict:
    by_map = defaultdict(list)
    for source in sources:
        path = root / source["file"]
        data = json.loads(path.read_text(encoding="utf-8"))
        info = data["info"][0]
        map_name = re.search(r"Map(Ancient|Anubis|Cache|Dust2|Inferno|Mirage|Nuke)", info)[1].lower()
        date = datetime.strptime(re.search(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", info)[0], "%Y-%m-%d %H:%M")
        total_tables = [s for s in data["scoreboards"] if "totalstats" in s["cls"].split()]
        rosters = [{nickname(p["player"]) for p in table["rows"]} for table in total_tables]
        history = {team["team"]: [] for team in data["roundHistory"][:2]}
        for segment in data["roundHistory"]:
            history[segment["team"]].extend(segment["outcomes"])
        kill_sequences = {}
        winner_sides = []
        for round_name, rd in sorted(data["performance"]["rounds"].items(), key=lambda x: int(x[0][5:])):
            number = int(round_name[5:])
            winners = [i for i, outcomes in enumerate(history.values())
                       if not outcomes[number - 1].startswith("emptyHistory")]
            if len(winners) != 1:
                raise ValueError(f"{path.name}/{round_name}: ambiguous round winner")
            first_side = "T" if rd["side"] == "t-side" else "CT"
            winner_sides.append(first_side if winners[0] == 0 else "CT" if first_side == "T" else "T")
            kills = []
            for event in rd["events"]:
                if " killed " not in event["title"]:
                    continue
                a, v = event["title"].split(" killed ", 1)
                a, v = nickname(a), nickname(v)
                if any(a in team and v in team for team in rosters):
                    continue
                kills.append((a, v))
            kill_sequences[number] = kills
        by_map[map_name].append({"file": path.name, "date": date, "rosters": rosters,
                                 "winner_sides": winner_sides, "kills": kill_sequences})
    return by_map


def join(root: Path, metrics: Path) -> dict:
    import pyarrow.parquet as pq
    fit = json.loads(metrics.read_text(encoding="utf-8"))
    by_map = hltv_index(root / "hltv", fit["source_audit"]["sources"])
    # The manifest records historical output paths. Enumerate schema-v1 folders
    # in place so a refeed that replaces an archive slug is not silently lost.
    entries = [
        {"out_dir": str(path.parent.relative_to(root)).replace("/", "\\\\")}
        for path in sorted((root / "demos").glob("*/*/meta.parquet"))
    ]
    accepted, rejected = [], []
    seen = set()
    for entry in entries:
        if entry["out_dir"] in seen:
            continue
        seen.add(entry["out_dir"])
        directory = root / entry["out_dir"]
        if not (directory / "meta.parquet").exists():
            rejected.append({"demo": entry["out_dir"], "reason": "manifest output no longer exists"})
            continue
        meta = pq.read_table(directory / "meta.parquet").to_pylist()[0]
        archive_date = json.loads(meta["extra"]).get("dem_modified_in_archive")
        if not archive_date:
            rejected.append({"demo": entry["out_dir"], "reason": "no archive date"})
            continue
        demo_date = datetime.strptime(archive_date[:19], "%Y-%m-%d %H:%M:%S")
        rounds = pq.read_table(directory / "rounds.parquet").to_pylist()
        economy = pq.read_table(directory / "economy.parquet", columns=["round", "steamid", "name", "side"]).to_pylist()
        names = {r["steamid"]: nickname(r["name"]) for r in economy}
        roster_t = {names[r["steamid"]] for r in economy if r["round"] == 1 and r["side"] == "T"}
        roster_ct = {names[r["steamid"]] for r in economy if r["round"] == 1 and r["side"] == "CT"}
        kills = pq.read_table(directory / "kills.parquet").to_pylist()
        sequences = defaultdict(list)
        end_ticks = {r["round"]: r["end_tick"] for r in rounds}
        for k in sorted(kills, key=lambda k: (k["round"], k["tick"])):
            # HLTV's graph stops at round end, while demo scoreboards include later kills.
            # Confirmed on 242792 round 19 and 242799 round 3.
            if k["tick"] > end_ticks[k["round"]] or k["is_suicide"] or k["is_teamkill"] or not k["attacker_steamid"]:
                continue
            sequences[k["round"]].append((names.get(k["attacker_steamid"], "unknown"), names.get(k["victim_steamid"], "unknown")))
        candidates = [c for c in by_map[meta["map_name"].removeprefix("de_")]
                      if abs((c["date"] - demo_date).total_seconds()) <= 36 * 3600]
        candidates = [c for c in candidates if len(c["winner_sides"]) == len(rounds)]
        matches = []
        near = []
        for candidate in candidates:
            if not all(roster in candidate["rosters"] for roster in (roster_t, roster_ct)):
                continue
            winners_match = candidate["winner_sides"] == [r["winner_side"] for r in rounds]
            differing = [r["round"] for r in rounds if candidate["kills"][r["round"]] != sequences[r["round"]]]
            if winners_match and not differing:
                matches.append(candidate)
            else:
                near.append({"hltv": candidate["file"], "winners_match": winners_match, "kill_rounds_differ": differing})
        if len(matches) == 1:
            candidate = matches[0]
            accepted.append({"demo": entry["out_dir"], "hltv": candidate["file"], "rounds": len(rounds),
                             "kills": sum(len(v) for v in sequences.values()),
                             "timestamp_difference_hours": (demo_date - candidate["date"]).total_seconds() / 3600,
                             "checks": ["map", "archive_date", "both_team_rosters", "all_round_winners", "all_enemy_kills_in_order"]})
        else:
            rejected.append({"demo": entry["out_dir"], "reason": "ambiguous" if len(matches) > 1 else "no exact join",
                             "near": near})
    return {"accepted": accepted, "rejected": rejected,
            "counts": {"accepted": len(accepted), "rejected": len(rejected),
                       "rounds": sum(r["rounds"] for r in accepted), "kills": sum(r["kills"] for r in accepted)},
            "reasons": dict(Counter(r["reason"] for r in rejected))}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--metrics", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    helpers = runpy.run_path(str(Path(__file__).with_name("winprob_fit.py")))
    helpers["idle"]()
    result = join(args.data, args.metrics)
    args.out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result["counts"]))


if __name__ == "__main__":
    main()
