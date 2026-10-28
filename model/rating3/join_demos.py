"""Validate demo/HLTV map joins in place; save identifiers and checks, not tables.

Requires matching map, an archive timestamp within 36 hours of HLTV's match
start, both five-player rosters, every round winner, and every enemy-kill pair
in order. The timestamp window permits a local archive timestamp and long
series, but is not enough to accept a join without the event checks.

A map whose match.extra names its HLTV match (hltv_match_id, as the pipeline
records for a loose OpenCS2 demo) is joined to that match's HLTV map of the same
map name, among the fit's sources and the ocs_map_*.json scoreboards saved for
OpenCS2, instead of by timestamp; the roster, round-winner and kill checks still
decide. A map is played once in a match, and the map index OpenCS2 gives
(hltv_map_index) names another map than HLTV's on 6 of 1,148 saved scoreboards.
"""
from __future__ import annotations
import argparse
from collections import defaultdict, Counter
from datetime import datetime
import json
from pathlib import Path
import re
import runpy
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from demo_paths import iter_demo_roots
sys.path.append(str(Path(__file__).resolve().parents[2] / "extractor"))
from repo_guard import check_output, write_json  # noqa: E402  (extractor/repo_guard.py: where outputs may land)


def nickname(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def hltv_index(root: Path, sources: list[dict]) -> dict:
    by_map = defaultdict(list)
    for source in sources:
        path = root / source["file"]
        data = json.loads(path.read_text(encoding="utf-8"))
        info = data["info"][0]
        map_name = re.search(r"Map(Ancient|Anubis|Cache|Dust2|Inferno|Mirage|Nuke|Overpass|Train)", info)[1].lower()
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
                                 "winner_sides": winner_sides, "kills": kill_sequences, "map": map_name,
                                 "ids": (str(data.get("match", {}).get("matchId")), data.get("mapIndex"))})
    return by_map


def ids_index(root: Path, by_map: dict) -> tuple[dict, list[dict]]:
    """{(HLTV match id, map name): HLTV map} over the fit's indexed maps and every ocs_map_*.json, and the files
    that could not be read."""
    out, unreadable = {}, []
    for path in sorted(root.glob("ocs_map_*.json")):
        try:
            extra = hltv_index(root, [{"file": path.name}])
        except (ValueError, KeyError, TypeError, IndexError) as error:
            unreadable.append({"hltv": path.name, "reason": f"{type(error).__name__}: {error}"})
            continue
        for maps in extra.values():
            for m in maps:
                out[(m["ids"][0], m["map"])] = m
    for maps in by_map.values():
        for m in maps:
            out.setdefault((m["ids"][0], m["map"]), m)
    return out, unreadable


def join(root: Path, metrics: Path) -> dict:
    import pyarrow.parquet as pq
    fit = json.loads(metrics.read_text(encoding="utf-8"))
    by_map = hltv_index(root / "hltv", fit["source_audit"]["sources"])
    # Enumerate map folders rather than table files so CURRENT selects one
    # complete extractor version and old versions are not joined twice.
    entries = [
        {"out_dir": str(relative).replace("/", "\\\\"), "layout": layout}
        for relative, layout in iter_demo_roots(root)
    ]
    accepted, rejected = [], []
    by_ids, unreadable = None, []
    for entry in entries:
        directory = entry["layout"].directory
        metadata_path = entry["layout"].table("match")
        meta = pq.read_table(metadata_path).to_pylist()[0]
        extra = json.loads(meta["extra"])
        map_name = meta["map_name"] if "map_name" in meta else meta["map"]
        named = (str(extra["hltv_match_id"]), map_name.removeprefix("de_")) if extra.get("hltv_match_id") else None
        archive_date = extra.get("dem_modified_in_archive")
        if not named and not archive_date:
            rejected.append({"demo": entry["out_dir"], "reason": "no archive date"})
            continue
        demo_date = datetime.strptime(archive_date[:19], "%Y-%m-%d %H:%M:%S") if not named else None
        rounds = pq.read_table(directory / "rounds.parquet").to_pylist()
        roster_rows = pq.read_table(
            entry["layout"].table("player_rounds"),
            columns=["round", "steamid", "name", "side"],
        ).to_pylist()
        names = {r["steamid"]: nickname(r["name"]) for r in roster_rows}
        roster_t = {names[r["steamid"]] for r in roster_rows if r["round"] == 1 and r["side"] == "T"}
        roster_ct = {names[r["steamid"]] for r in roster_rows if r["round"] == 1 and r["side"] == "CT"}
        kills = pq.read_table(directory / "kills.parquet").to_pylist()
        sequences = defaultdict(list)
        end_ticks = {r["round"]: r["end_tick"] for r in rounds}
        for k in sorted(kills, key=lambda k: (k["round"], k["tick"])):
            # HLTV's graph stops at round end, while demo scoreboards include later kills.
            # The cutoff was checked against joined late-round examples.
            if k["tick"] > end_ticks[k["round"]] or k["is_suicide"] or k["is_teamkill"] or not k["attacker_steamid"]:
                continue
            sequences[k["round"]].append((names.get(k["attacker_steamid"], "unknown"), names.get(k["victim_steamid"], "unknown")))
        if named:
            if by_ids is None:
                by_ids, unreadable = ids_index(root / "hltv", by_map)
            candidates = [by_ids[named]] if named in by_ids else []
            if not candidates:
                rejected.append({"demo": entry["out_dir"], "reason": "no HLTV map of its match and map", "hltv": named})
                continue
        else:
            candidates = [c for c in by_map[map_name.removeprefix("de_")]
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
                             **({"hltv_match_map": named} if named else
                                {"timestamp_difference_hours": (demo_date - candidate["date"]).total_seconds() / 3600}),
                             "checks": ["map", "hltv_match" if named else "archive_date", "both_team_rosters",
                                        "all_round_winners", "all_enemy_kills_in_order"]})
        else:
            rejected.append({"demo": entry["out_dir"], "reason": "ambiguous" if len(matches) > 1 else "no exact join",
                             "near": near})
    return {"accepted": accepted, "rejected": rejected,
            "counts": {"accepted": len(accepted), "rejected": len(rejected),
                       "rounds": sum(r["rounds"] for r in accepted), "kills": sum(r["kills"] for r in accepted)},
            "reasons": dict(Counter(r["reason"] for r in rejected)), "unreadable_hltv": unreadable}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--metrics", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    # private: built from HLTV rows and pro demos; checked before any data is read
    check_output(args.out, private=True, what="the demo joins (HLTV rows matched to demos)")
    helpers = runpy.run_path(str(Path(__file__).with_name("winprob_fit.py")))
    helpers["idle"]()
    result = join(args.data, args.metrics)
    write_json(args.out, result, private=True, what="the demo joins (HLTV rows matched to demos)", indent=2)
    print(json.dumps(result["counts"]))


if __name__ == "__main__":
    main()
