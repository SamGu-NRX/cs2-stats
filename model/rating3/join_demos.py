"""Validate demo/HLTV map joins in place; save identifiers and checks, not tables.

Requires matching map, an archive timestamp within 36 hours of HLTV's match
start, both five-player rosters, every round winner, and every enemy-kill pair
in order. The timestamp window permits a local archive timestamp and long
series, but is not enough to accept a join without the event checks.

Players are matched by what they did, not by name (structural_mapping): an
in-game name often differs from the HLTV one (39% of OpenCS2 maps have at least
one). Every enemy kill, in order, pairs a demo killer and victim with HLTV's; a
pairing must hold across all of them, keep each team together, and give every
player HLTV's kill count. Names and pairs learned from earlier joins only place
players the kills cannot (no kill or death), and only when that leaves one
answer. An accepted map's SteamID to HLTV player id pairs go to the learned map
(--player-ids), private and outside the repository, and each accepted record
lists them (players), which the fits read (joined_players).

A map whose match.extra names its HLTV match (hltv_match_id, as the pipeline
records for a loose OpenCS2 demo) is joined only to that match's HLTV map of the
same map name, among the fit's sources and the ocs_map_*.json scoreboards saved
for OpenCS2; with none saved it is rejected ("HLTV scoreboard not captured"),
never joined by date. The timestamp window is for demos without an id (HLTV
archives); counts say how many maps each way joined. A map is played once in a
match, and the map index OpenCS2 gives (hltv_map_index) names another map than
HLTV's on 6 of 1,148 saved scoreboards.
"""
from __future__ import annotations
import argparse
from collections import defaultdict, Counter
import itertools
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
        players = {nickname(p["player"]): {"pid": str(p.get("pid") or ""), "team": i,
                                           "kills": int(dict(p["cells"])["st-kills traditional-data"].split()[0])}
                   for i, table in enumerate(total_tables) for p in table["rows"]}
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
        by_map[map_name].append({"file": path.name, "date": date, "rosters": rosters, "players": players,
                                 "winner_sides": winner_sides, "kills": kill_sequences, "map": map_name,
                                 "ids": (str(data.get("match", {}).get("matchId")), data.get("mapIndex"))})
    return by_map


def demo_teams(roster_rows: list[dict]) -> dict[int, int]:
    """{steamid: team number}: players on the same side in the same round are teammates, so a substitute joins his
    team from the round he played. Raises ValueError if that does not leave two teams."""
    parent: dict[int, int] = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    by_side = defaultdict(list)
    for r in roster_rows:
        find(r["steamid"])
        by_side[(r["round"], r["side"])].append(r["steamid"])
    for group in by_side.values():
        for other in group[1:]:
            parent[find(other)] = find(group[0])
    roots = sorted({find(x) for x in parent}, key=str)
    if len(roots) != 2:
        raise ValueError(f"the players make {len(roots)} teams, not 2")
    return {x: roots.index(find(x)) for x in parent}


def structural_mapping(sequences: dict[int, list[tuple[int, int]]], teams: dict[int, int], names: dict[int, str],
                       kills: dict[int, int], candidate: dict, learned: dict[str, str]) -> tuple[dict | None, str | None]:
    """({steamid: HLTV nickname}, None) when exactly one pairing of the demo's players with the HLTV map's fits, or
    (None, why not).

    The pairing must:
    - hold across every enemy kill in order: the demo's killer and victim of each are HLTV's (sequences: per round,
      the demo's (attacker, victim) steamids; candidate["kills"]: HLTV's nicknames, in the same order);
    - keep each demo team (teams) on one HLTV team;
    - give each player HLTV's kill count (kills: the demo's enemy kills per steamid, post-round ones included, as
      HLTV's scoreboard counts them).
    Players the kills do not place (no kill or death in the sequences) are paired within their team in every way that
    keeps the kill counts; an exact name match, then a pair from learned ({steamid: HLTV player id}), narrows that.
    Anything but one answer is refused. HLTV's deaths and assists are not compared: its deaths leave out some world
    and bomb deaths but not others, and its assists are not the game's (on 304 maps joined by name, deaths matched
    for 94% of players and assists for 63%; kills for all 3,040).
    """
    players = candidate["players"]
    pairs: dict[int, str] = {}
    taken: dict[str, int] = {}
    for rnd in sorted(set(sequences) | set(candidate["kills"])):
        demo, hltv = sequences.get(rnd, []), candidate["kills"].get(rnd, [])
        if len(demo) != len(hltv):
            return None, f"round {rnd}: {len(demo)} enemy kills in the demo, {len(hltv)} on HLTV"
        for i, ((a, v), (ha, hv)) in enumerate(zip(demo, hltv), 1):
            for sid, nick in ((a, ha), (v, hv)):
                if pairs.get(sid, nick) != nick or taken.get(nick, sid) != sid:
                    return None, (f"round {rnd} kill {i} ({names.get(a)} killed {names.get(v)}; HLTV: {ha} killed {hv}): "
                                  f"{names.get(sid)} is {pairs.get(sid)} by earlier kills, {nick} is "
                                  f"{names.get(taken.get(nick))}")
                pairs[sid], taken[nick] = nick, sid
    unknown = sorted({nick for nick in taken if nick not in players})
    if unknown:
        return None, f"HLTV's kills name {unknown}, who are on neither scoreboard"
    team_map: dict[int, int] = {}
    for sid, nick in pairs.items():
        if team_map.setdefault(teams.get(sid, -1), players[nick]["team"]) != players[nick]["team"]:
            return None, f"{names.get(sid)} ({nick}) would put a demo team on both HLTV teams"
    if len(set(team_map.values())) < len(team_map):
        return None, "both demo teams would be one HLTV team"
    if len(team_map) == 1:  # one team's players all placed: the other demo team is the other HLTV team
        (t, h), = team_map.items()
        team_map[1 - t] = 1 - h
    for team in (0, 1):
        open_demo = sorted(sid for sid, t in teams.items() if t == team and sid not in pairs)
        open_hltv = sorted(n for n, p_ in players.items() if p_["team"] == team_map.get(team) and n not in taken)
        if len(open_demo) != len(open_hltv):
            return None, (f"a team has {len(open_demo)} players the kills do not place and HLTV {len(open_hltv)}: "
                          f"{[names.get(x) for x in open_demo]} against {open_hltv}")
        if len(open_demo) > 6:
            return None, f"{len(open_demo)} players of one team have no kill or death to place them"
        fits = [dict(zip(open_demo, perm)) for perm in itertools.permutations(open_hltv)
                if all(kills.get(sid, 0) == players[n]["kills"] for sid, n in zip(open_demo, perm))]
        for prefer in (lambda sid, n: names.get(sid) == n, lambda sid, n: learned.get(str(sid)) == players[n]["pid"]):
            if len(fits) > 1:
                best = max(sum(prefer(sid, n) for sid, n in f.items()) for f in fits)
                fits = [f for f in fits if sum(prefer(sid, n) for sid, n in f.items()) == best]
        if len(fits) != 1:
            return None, (f"{[names.get(x) for x in open_demo]} have no kill or death, and {len(fits)} ways to pair "
                          f"them with {open_hltv} fit")
        pairs.update(fits[0])
    for sid, nick in pairs.items():
        if kills.get(sid, 0) != players[nick]["kills"]:
            return None, f"{names.get(sid)} pairs with {nick}, who has {players[nick]['kills']} kills on HLTV, not {kills.get(sid, 0)}"
    return pairs, None


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


def join(root: Path, metrics: Path, learned: dict[str, str] | None = None) -> dict:
    """learned: {steamid: HLTV player id} from earlier joins (the --player-ids file), tiebreak evidence only."""
    import pyarrow.parquet as pq
    learned = learned or {}
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
        try:
            teams = demo_teams(roster_rows)
        except ValueError as error:
            rejected.append({"demo": entry["out_dir"], "reason": f"teams: {error}"})
            continue
        kills = pq.read_table(directory / "kills.parquet").to_pylist()
        sequences = defaultdict(list)
        kill_counts = Counter()
        end_ticks = {r["round"]: r["end_tick"] for r in rounds}
        for k in sorted(kills, key=lambda k: (k["round"], k["tick"])):
            if k["is_suicide"] or k["is_teamkill"] or not k["attacker_steamid"]:
                continue
            kill_counts[k["attacker_steamid"]] += 1  # the scoreboard counts post-round kills too
            # HLTV's graph stops at round end, while demo scoreboards include later kills.
            # The cutoff was checked against joined late-round examples.
            if k["tick"] <= end_ticks[k["round"]]:
                sequences[k["round"]].append((k["attacker_steamid"], k["victim_steamid"]))
        if named:
            if by_ids is None:
                by_ids, unreadable = ids_index(root / "hltv", by_map)
            candidates = [by_ids[named]] if named in by_ids else []
            if not candidates:
                rejected.append({"demo": entry["out_dir"], "reason": "HLTV scoreboard not captured", "hltv": named})
                continue
        else:
            candidates = [c for c in by_map[map_name.removeprefix("de_")]
                          if abs((c["date"] - demo_date).total_seconds()) <= 36 * 3600]
        candidates = [c for c in candidates if len(c["winner_sides"]) == len(rounds)]
        matches = []
        near = []
        for candidate in candidates:
            if candidate["winner_sides"] != [r["winner_side"] for r in rounds]:
                near.append({"hltv": candidate["file"], "winners_match": False})
                continue
            pairs, why = structural_mapping(sequences, teams, names, kill_counts, candidate, learned)
            if pairs is None:
                near.append({"hltv": candidate["file"], "winners_match": True, "players": why})
            else:
                matches.append((candidate, pairs))
        if len(matches) == 1:
            candidate, pairs = matches[0]
            accepted.append({"demo": entry["out_dir"], "hltv": candidate["file"], "rounds": len(rounds),
                             "kills": sum(len(v) for v in sequences.values()),
                             **({"hltv_match_map": named} if named else
                                {"timestamp_difference_hours": (demo_date - candidate["date"]).total_seconds() / 3600}),
                             "players": {str(sid): {"hltv": nick, "pid": candidate["players"][nick]["pid"],
                                                    "renamed": names.get(sid) != nick} for sid, nick in sorted(pairs.items())},
                             "checks": ["map", "hltv_match" if named else "archive_date", "all_round_winners",
                                        "one_player_pairing_of_all_enemy_kills", "both_teams", "every_player_kill_count"]})
        else:
            rejected.append({"demo": entry["out_dir"], "reason": "ambiguous" if len(matches) > 1 else "no exact join",
                             "near": near})
    return {"accepted": accepted, "rejected": rejected,
            "counts": {"accepted": len(accepted), "rejected": len(rejected),
                       "rounds": sum(r["rounds"] for r in accepted), "kills": sum(r["kills"] for r in accepted),
                       "renamed_players": sum(p["renamed"] for r in accepted for p in r["players"].values()),
                       "joined_by_hltv_match": sum("hltv_match" in r["checks"] for r in accepted),
                       "joined_by_date_window": sum("archive_date" in r["checks"] for r in accepted)},
            "reasons": dict(Counter(r["reason"] for r in rejected)), "unreadable_hltv": unreadable}


def joined_players(record: dict) -> dict[str, str]:
    """{steamid (str): HLTV nickname, as nickname() writes it} of an accepted join: the pairing its kills proved. The
    fits read players through this, not by in-game name, which often differs from HLTV's. Raises KeyError for a join
    file written before the join recorded its pairing."""
    if "players" not in record:
        raise KeyError(f"{record['demo']}: this join records no player pairing; run join_demos.py again")
    return {sid: p["hltv"] for sid, p in record["players"].items()}


def learn(path: Path, accepted: list[dict]) -> dict:
    """Merge the accepted maps' SteamID to HLTV player id pairs into the learned map at path (private, marked so), and
    return {steamid: HLTV player id} for the next join. A SteamID seen with two ids keeps both, under "conflicts", and
    gives no evidence."""
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    pairs = data.get("pairs", {})
    conflicts = data.get("conflicts", {})
    for record in accepted:
        for sid, p_ in record["players"].items():
            if not p_["pid"]:
                continue
            known = pairs.get(sid)
            if known and known["pid"] != p_["pid"]:
                conflicts.setdefault(sid, sorted({known["pid"], *conflicts.get(sid, [])}))
                conflicts[sid] = sorted(set(conflicts[sid]) | {p_["pid"]})
                continue
            entry = pairs.setdefault(sid, {"pid": p_["pid"], "hltv": p_["hltv"], "maps": []})
            if record["hltv"] not in entry["maps"]:
                entry["maps"].append(record["hltv"])
    write_json(path, {"_private": True, "pairs": pairs, "conflicts": conflicts}, private=True,
               what="the learned SteamID to HLTV player id map", indent=1)
    return {sid: p_["pid"] for sid, p_ in pairs.items() if sid not in conflicts}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--metrics", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--player-ids", type=Path, help="the learned SteamID to HLTV player id map "
                        "(default <data>/model-rating3/player_ids.private.json)")
    args = parser.parse_args()
    ids_path = args.player_ids or args.data / "model-rating3" / "player_ids.private.json"
    # private: built from HLTV rows and pro demos; checked before any data is read
    check_output(args.out, private=True, what="the demo joins (HLTV rows matched to demos)")
    check_output(ids_path, private=True, what="the learned SteamID to HLTV player id map")
    helpers = runpy.run_path(str(Path(__file__).with_name("winprob_fit.py")))
    helpers["idle"]()
    known = json.loads(ids_path.read_text(encoding="utf-8")) if ids_path.exists() else {}
    learned = {sid: p_["pid"] for sid, p_ in known.get("pairs", {}).items() if sid not in known.get("conflicts", {})}
    result = join(args.data, args.metrics, learned)
    write_json(args.out, result, private=True, what="the demo joins (HLTV rows matched to demos)", indent=2)
    learn(ids_path, result["accepted"])
    print(json.dumps(result["counts"]))


if __name__ == "__main__":
    main()
