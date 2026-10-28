"""Join the parts of a map HLTV recorded as several demos (<map>-p1.dem, -p2.dem, ...) into one map, or hold it back.

A split recording's parts are extracted one by one (extract.py). Published as maps, each was its own match:
rounds numbered from 1 inside each part, so a second part's halftime and pistol rounds were wrong, and
neither part could join HLTV's map. Here the parts become one map with the match's own round numbers, but
only when they are provably one continuous recording of the whole match (plan): every part from 1 is present, all
are of one map, tick rate, source, archive, pair of teams and visibility setup, the first starts at round 1, each
part's first round follows the last one's, both teams' scores and every player's counters (one who left included)
carry over unchanged, the sides are those the swap rule gives, the rosters are the same, and the last part ends the
match; and the joined map passes the scoreboard check on its own (join_failures).
Anything else is held back: its parts are kept, out of every reader's sight,
and parts.jsonl in the parts folder says why, so the map can be joined if a missing part arrives.

Run:  .venv\\Scripts\\python.exe -I stitch.py --data <cs2-stats-data>            (report only)
      .venv\\Scripts\\python.exe -I stitch.py --data <cs2-stats-data> --apply    (also join or withdraw)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I leaves this folder off sys.path
import extract  # noqa: E402

PART = re.compile(r"^(?P<base>.+)-p(?P<n>\d+)$")
# Counters that must carry over from one part's end to the next part's start, per player.
CARRIED = ["kills_total", "deaths_total", "assists_total", "damage_total", "headshot_kills_total"]
PARTS_MANIFEST = "parts.jsonl"  # in the parts folder
# In a part folder whose deletion failed part way: JSON naming the files lost and those left. Such a part is never
# joined (split_maps skips it); it is deleted last of the folder's files, so it stays while anything else does.
DAMAGED = "DAMAGED"
# match columns every part must share: one map, one recording setup, one match between the same two teams, and
# one way of judging visibility (the stitched map has one visibility_status, so parts that differ are held).
IDENTITY = ("map", "tick_rate", "source", "archive", "team1_file", "team2_file", "visibility_status", "mesh_sha256",
            "velocity_source")
DUP = re.compile(r"^(?P<key>.+?)(?:_dup)+$")  # demo_pipeline's folder for a second demo with the same map key
# Every column that names something by number, in one of two groups (a test fails on an ID column in neither).
# OFFSET_IDS are numbers the extractor assigns, unique in the match; each part numbers its own from 0, so a later
# part's move past every earlier part's. GAME_IDS are the game's own entity indices and user slots: the game reuses
# them within one demo too, every table reads them with a tick, and an offset would make them name no entity, so
# they stay as recorded. match_id is not here: the stitched map gets its own.
OFFSET_IDS = ("engagement_id", "projectile")
GAME_IDS = ("entity_id", "flash_entity_id", "grenade_entity_id", "site_entity", "user_id")


def split_key(map_key: str) -> tuple[str, int] | None:
    """(base map key, part number) for a part's map key such as m3-dust2-p2; None for a whole map."""
    m = PART.match(map_key)
    return (m["base"], int(m["n"])) if m else None


def swaps_at(round_no: int, max_rounds: int, ot_max: int) -> bool:
    """Whether the teams change sides at the start of round_no. Five HLTV maps that went to overtime (MR12,
    six-round overtimes) swapped at rounds 13, 28 and 34: halftime of regulation and of each overtime, never
    at an overtime's start."""
    half, ot_half = max_rounds // 2, ot_max // 2
    if round_no <= max_rounds:
        return round_no == half + 1
    return (round_no - max_rounds - 1) % ot_max == ot_half


def match_over(a: int, b: int, max_rounds: int, ot_max: int) -> bool:
    """Whether a final score a-b ends a match: 13-x with x <= 11 in regulation (MR12), or one team taking an
    overtime 4-x with x <= 2 (six-round overtimes) after every earlier overtime was drawn."""
    half, o = max_rounds // 2, ot_max // 2
    hi, lo = max(a, b), min(a, b)
    if hi == half + 1 and lo <= half - 1:
        return True
    k, rest = divmod(hi - half - o - 1, o)
    return k >= 0 and rest == 0 and half + k * o <= lo <= half + k * o + o - 1


@dataclass(frozen=True)
class Part:
    """What plan needs from one part's tables."""
    n: int
    extractor_version: str
    first_round: int  # the match's number for the part's round 1: rounds played before it, plus one
    n_rounds: int
    score_start: dict  # team -> rounds won before the part
    score_end: dict  # team -> rounds won by the part's end
    rosters: dict  # team -> frozenset of SteamIDs that played a round for it
    ct_first: str
    ct_last: str
    start: dict  # SteamID -> CARRIED counters at the part's start (the round-1 baseline)
    end: dict  # SteamID -> CARRIED counters on the part's final scoreboard, or at his disconnect for one who left
    max_rounds: int
    ot_max: int
    identity: dict  # IDENTITY columns, the map key without its part number, and the round limits


def departed_rows(T: dict[str, pl.DataFrame]) -> list[dict]:
    """match.departed: players who left before the part's final tick, with their counters there and at its start."""
    return json.loads(T["match"]["departed"][0] or "[]")


def part_facts(n: int, T: dict[str, pl.DataFrame]) -> Part:
    m = T["match"].row(0, named=True)
    convars = json.loads(m.get("convars") or "{}")
    max_rounds, ot_max = int(convars.get("mp_maxrounds") or 24), int(convars.get("mp_overtime_maxrounds") or 6)
    key = split_key(m["map_key"])
    identity = {**{c: m.get(c) for c in IDENTITY}, "map_key": key[0] if key else m["map_key"],
                "mp_maxrounds": max_rounds, "mp_overtime_maxrounds": ot_max}
    gone = [r for r in departed_rows(T) if int(r["steamid"]) not in set(T["scoreboard"]["steamid"].to_list())]
    rounds = T["rounds"].sort("round")
    sb = T["scoreboard"]
    start_score = {t: int(v) for t, v in sb.group_by("team_clan_name").agg(pl.col("team_rounds_total_at_start").max()).iter_rows()}
    teams = sorted(set(rounds["ct_team"].drop_nulls()) | set(rounds["t_team"].drop_nulls()))
    wins = dict(rounds["winner_team"].drop_nulls().value_counts().iter_rows())
    pr = T["player_rounds"].join(rounds.select("round", "ct_team", "t_team"), on="round")
    pr = pr.with_columns(pl.when(pl.col("side") == "CT").then(pl.col("ct_team")).otherwise(pl.col("t_team")).alias("team"))
    rosters = {t: frozenset(int(s) for s in pr.filter(pl.col("team") == t)["steamid"].unique()) for t in teams}
    return Part(
        n=n, extractor_version=str(m["extractor_version"]),
        first_round=sum(start_score.get(t, 0) for t in teams) + 1, n_rounds=rounds.height,
        score_start={t: start_score.get(t, 0) for t in teams},
        score_end={t: start_score.get(t, 0) + int(wins.get(t, 0)) for t in teams},
        rosters=rosters, ct_first=rounds["ct_team"][0], ct_last=rounds["ct_team"][-1],
        start={int(r["steamid"]): tuple(int(r[f"{c}_at_start"]) for c in CARRIED) for r in [*sb.iter_rows(named=True), *gone]},
        end={int(r["steamid"]): tuple(int(r[c]) for c in CARRIED) for r in [*sb.iter_rows(named=True), *gone]},
        max_rounds=max_rounds, ot_max=ot_max, identity=identity)


def plan(parts: list[Part], version: str | None = None) -> str | None:
    """None when the parts join into one map; otherwise the reason they are held back. version: the extractor
    version every part must have been extracted by (the running one, whose tables the stitched map holds)."""
    parts = sorted(parts, key=lambda p: p.n)
    numbers = [p.n for p in parts]
    if numbers != list(range(1, len(parts) + 1)):
        missing = sorted(set(range(1, max(numbers) + 1)) - set(numbers))
        return f"part {', '.join(map(str, missing))} missing" if missing else f"part numbers {numbers} repeat"
    if len(parts) < 2:
        return "only part 1 is here"
    versions = sorted({p.extractor_version for p in parts})
    if len(versions) > 1 or (version and versions != [version]):
        return f"parts extracted by extractor {', '.join(versions)}" + (f"; re-extract them with {version}" if version else "")
    for field in parts[0].identity:
        values = [p.identity.get(field) for p in parts]
        if len(set(map(repr, values))) > 1:
            return f"{field} differs: " + ", ".join(f"part {p.n} {v!r}" for p, v in zip(parts, values))
    if parts[0].first_round != 1:
        return f"part 1 starts at round {parts[0].first_round}, not 1"
    for a, b in zip(parts, parts[1:]):
        expected = a.first_round + a.n_rounds
        if b.first_round != expected:
            what = "gap" if b.first_round > expected else "overlap"
            return f"{what}: part {b.n} starts at round {b.first_round}, part {a.n} ends at round {expected - 1}"
        if set(a.rosters) != set(b.rosters):
            return f"teams differ: part {a.n} {sorted(a.rosters)}, part {b.n} {sorted(b.rosters)}"
        if a.score_end != b.score_start:
            return f"score: part {a.n} ends at {a.score_end}, part {b.n} starts at {b.score_start}"
        if a.rosters != b.rosters:
            return f"rosters differ between part {a.n} and part {b.n}"
        new = sorted(set(b.start) - set(a.end))
        if new:
            return (f"{len(new)} player(s) at part {b.n}'s start are neither on part {a.n}'s final scoreboard nor among "
                    f"those who left it (first: {new[0]}), so their counters cannot be carried over")
        moved = sorted(s for s in b.start if a.end[s] != b.start[s])
        if moved:
            s = moved[0]
            return (f"counters of {len(moved)} player(s) changed between part {a.n}'s end and part {b.n}'s start "
                    f"(first: {dict(zip(CARRIED, a.end[s]))} -> {dict(zip(CARRIED, b.start[s]))})")
        swap = swaps_at(b.first_round, b.max_rounds, b.ot_max)
        if (b.ct_first != a.ct_last) != swap:
            return (f"sides: round {b.first_round} has {b.ct_first} on CT after {a.ct_last} in round "
                    f"{expected - 1}, but the teams {'swap' if swap else 'keep sides'} there")
    last = parts[-1]
    a_, b_ = sorted(last.score_end.values())
    if not match_over(a_, b_, last.max_rounds, last.ot_max):
        return f"part {last.n} ends at {b_}-{a_}, before the match does (a later part missing?)"
    return None


def _shift(df: pl.DataFrame, rounds: int, ticks: int, ids: dict[str, int]) -> pl.DataFrame:
    """A part's table moved to the match's round numbers, onto its own stretch of the stitched tick line, and past
    the earlier parts' numbers in each OFFSET_IDS column (ids: column -> offset)."""
    cols = []
    for c in df.columns:
        if c == "round":
            cols.append(pl.when(pl.col(c) > 0).then(pl.col(c) + rounds).otherwise(pl.col(c)).cast(df.schema[c]).alias(c))
        elif c == "tick" or c.endswith("_tick"):
            cols.append((pl.col(c) + ticks).cast(df.schema[c]).alias(c))
        elif c in OFFSET_IDS:
            cols.append((pl.col(c) + ids[c]).cast(df.schema[c]).alias(c))
    return df.with_columns(cols) if cols else df


def _id_span(T: dict[str, pl.DataFrame]) -> dict[str, int]:
    """For each OFFSET_IDS column, one more than the largest number any of the part's tables uses (0 if none)."""
    out = {}
    for c in OFFSET_IDS:
        highest = [int(df[c].max()) for df in T.values() if c in df.columns and df[c].drop_nulls().len()]
        out[c] = max(highest) + 1 if highest else 0
    return out


def _players(players: pl.DataFrame, player_rounds: pl.DataFrame, max_rounds: int, n_rounds: int) -> pl.DataFrame:
    """players with sides and rounds present recomputed over the stitched rounds, as extract.py computes them."""
    half = max_rounds // 2
    rows = []
    for r in players.unique("steamid", keep="last").iter_rows(named=True):
        side = dict(player_rounds.filter(pl.col("steamid") == r["steamid"]).select("round", "side").iter_rows())

        def side_in(rng):
            v = [side[x] for x in rng if isinstance(side.get(x), str)]
            return max(sorted(set(v)), key=v.count) if v else None

        rows.append(dict(r, side_h1=side_in(range(1, half + 1)), side_h2=side_in(range(half + 1, max_rounds + 1)),
                         side_ot=[side_in(range(a, min(a + 3, n_rounds + 1))) for a in range(max_rounds + 1, n_rounds + 1, 3)],
                         rounds_present=len(side)))
    return pl.DataFrame(rows, schema=players.schema)


def stitch(tables: list[dict[str, pl.DataFrame]], parts: list[Part]) -> dict[str, pl.DataFrame]:
    """One map's tables from its parts' (in part order), on the match's round numbers. plan must have passed."""
    ticks = 0
    ids = dict.fromkeys(OFFSET_IDS, 0)
    shifted, offsets = [], []
    for T, p in zip(tables, parts):
        m = T["match"].row(0, named=True)
        offsets.append(dict(ticks=ticks, rounds=p.first_round - 1, ids=dict(ids)))
        shifted.append({name: _shift(df, p.first_round - 1, ticks, ids) for name, df in T.items()
                        if name not in ("match", "scoreboard", "players")})
        last_tick = max(int(m["final_tick"] or 0), int(m["playback_ticks"] or 0),
                        *(int(df[c].max() or 0) for df in T.values() for c in df.columns
                          if (c == "tick" or c.endswith("_tick")) and df.height and df.schema[c].is_integer()))
        ticks += last_tick + 1
        ids = {c: ids[c] + n for c, n in _id_span(T).items()}
    out = {name: pl.concat([s[name] for s in shifted], how="vertical") for name in shifted[0]}
    # Each part counts its scores after a round from 0; the match counts from its start.
    start_of = {}
    for s, p in zip(shifted, parts):
        for r in s["rounds"]["round"]:
            start_of[int(r)] = p.score_start
    rounds = out["rounds"]
    out["rounds"] = rounds.with_columns(
        (pl.col("ct_team_score_after") + pl.struct("round", "ct_team").map_elements(
            lambda x: start_of[x["round"]].get(x["ct_team"], 0), return_dtype=pl.Int64)).cast(rounds.schema["ct_team_score_after"]),
        (pl.col("t_team_score_after") + pl.struct("round", "t_team").map_elements(
            lambda x: start_of[x["round"]].get(x["t_team"], 0), return_dtype=pl.Int64)).cast(rounds.schema["t_team_score_after"]))
    # The final scoreboard is the last part's; what each player held at the match's start is the first part's,
    # from its scoreboard or, for one who left during it, his departed row. plan saw every later player there.
    sb_last = tables[-1]["scoreboard"]
    at_start = [c for c in sb_last.columns if c.endswith("_at_start")]
    base = {int(r["steamid"]): {c: int(r[c]) for c in at_start}
            for r in [*departed_rows(tables[0]), *tables[0]["scoreboard"].iter_rows(named=True)]}
    absent = sorted(set(sb_last["steamid"].to_list()) - set(base))
    if absent:
        raise ValueError(f"{len(absent)} player(s) on the final scoreboard have no row at part 1's start: {absent}")
    out["scoreboard"] = sb_last.with_columns(
        [pl.Series(c, [base[int(s)][c] for s in sb_last["steamid"]], dtype=sb_last.schema[c]) for c in at_start]
        + [pl.col("tick") + offsets[-1]["ticks"]])
    max_rounds = parts[-1].max_rounds
    n = out["rounds"].height
    out["players"] = _players(pl.concat([T["players"] for T in tables], how="vertical"), out["player_rounds"],
                              max_rounds, n)
    out["match"] = _match(tables, parts, offsets, n, base)
    return out


def _departed(tables, offsets, base: dict) -> list[dict]:
    """The stitched map's departed rows: each player off the final scoreboard, as he stood when he last left, on the
    stitched tick line, with his counters at the match's start."""
    final = set(tables[-1]["scoreboard"]["steamid"].to_list())
    last = {}
    for T, o in zip(tables, offsets):
        for r in departed_rows(T):
            if int(r["steamid"]) not in final:
                last[int(r["steamid"])] = dict(r, tick=int(r["tick"]) + o["ticks"],
                                               **{c: v for c, v in base.get(int(r["steamid"]), {}).items()})
    return [last[s] for s in sorted(last)]


def _taken(tables) -> dict[str, dict[str, int]]:
    """match.scoreboard_taken over the parts: what every part's kept dropped attempts put on the scoreboard."""
    out: dict[str, dict[str, int]] = {}
    for T in tables:
        for sid, cols in json.loads(T["match"]["scoreboard_taken"][0] or "{}").items():
            for c, v in cols.items():
                out.setdefault(sid, {})[c] = out.get(sid, {}).get(c, 0) + int(v)
    return out


def _match(tables, parts, offsets, n_rounds, base) -> pl.DataFrame:
    rows = [T["match"].row(0, named=True) for T in tables]
    first, last = rows[0], rows[-1]
    hashes = [r["demo_sha256"] for r in rows]
    stitched_sha = hashlib.sha256("".join(hashes).encode()).hexdigest()
    base_key = split_key(first["map_key"])[0]

    def merged(col, shift):
        out = []
        for r, off in zip(rows, offsets):
            out += [shift(x, off) for x in json.loads(r[col] or "[]")]
        return json.dumps(out)

    m = dict(last)
    m.update(
        match_id=stitched_sha[:16], demo_sha256=stitched_sha, map_key=base_key,
        dem_file=" + ".join(r["dem_file"] for r in rows), dem_bytes=sum(int(r["dem_bytes"]) for r in rows),
        n_rounds=n_rounds, team_ct_start=first["team_ct_start"], team_t_start=first["team_t_start"],
        score_ct_start=parts[-1].score_end.get(first["team_ct_start"]),
        score_t_start=parts[-1].score_end.get(first["team_t_start"]),
        match_start_tick=first["match_start_tick"], final_tick=int(last["final_tick"]) + offsets[-1]["ticks"],
        playback_ticks=offsets[-1]["ticks"] + int(last["playback_ticks"] or last["final_tick"]),
        truncated=any(r["truncated"] for r in rows), extra=first["extra"],
        unattributed_damage_hp=sum(int(r["unattributed_damage_hp"]) for r in rows),
        voided_windows=merged("voided_windows", lambda w, o: [w[0] + o["ticks"], w[1] + o["ticks"]]),
        dropped_attempts=merged("dropped_attempts", lambda d, o: dict(
            d, round=None if d.get("round") is None else d["round"] + o["rounds"], from_tick=d["from_tick"] + o["ticks"],
            to_tick=d["to_tick"] + o["ticks"], restore_ticks=[t + o["ticks"] for t in d.get("restore_ticks", [])])),
        mesh_kill_agreement=min((r["mesh_kill_agreement"] for r in rows if r.get("mesh_kill_agreement") is not None),
                                default=last.get("mesh_kill_agreement")),
        excluded_players=json.dumps(list({x["steamid"]: x for r in rows for x in json.loads(r["excluded_players"] or "[]")}.values())),
        departed=json.dumps(_departed(tables, offsets, base)), scoreboard_taken=json.dumps(_taken(tables)),
        parsed_at_utc=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        parts=json.dumps([dict(part=p.n, dem_file=r["dem_file"], demo_sha256=r["demo_sha256"], tick_offset=o["ticks"],
                               first_round=p.first_round, n_rounds=p.n_rounds) for p, r, o in zip(parts, rows, offsets)]))
    return pl.DataFrame([m], schema=tables[-1]["match"].schema)


def join_failures(out: dict[str, pl.DataFrame]) -> list[dict]:
    """The fatal scoreboard checks (extract.validate_scoreboard) the stitched map fails: the final scoreboard less
    each player's counters at the match's start and what kept dropped attempts put on it, departed players
    included, against every part's kills and per-round game damage together. Each part passed this on its own;
    this checks the join."""
    m = out["match"].row(0, named=True)
    kills = out["kills"].to_pandas()
    for c in [c for c in out["kills"].columns if c.endswith("_steamid")]:
        kills[c] = pd.array(out["kills"][c].to_list(), dtype="UInt64")  # exact ids; floats would round them
    pr = out["player_rounds"].filter(pl.col("game_damage").is_not_null())
    damage = {int(s): int(v) for s, v in pr.group_by("steamid").agg(pl.col("game_damage").sum()).iter_rows()}
    taken = {int(s): v for s, v in json.loads(m["scoreboard_taken"] or "{}").items()}

    def checked(rows: list[dict]) -> pd.DataFrame:
        df = pd.DataFrame(rows, columns=["steamid", "tick", *extract.BASELINE_PROPS])
        if not rows:
            return df
        for c in extract.BASELINE_PROPS:
            df[c] = [int(r[c]) - int(r[f"{c}_at_start"]) for r in rows]
        return extract.less_taken(df, taken)

    sb = checked(list(out["scoreboard"].iter_rows(named=True)))
    departed = checked(json.loads(m["departed"] or "[]"))
    everyone = {int(s) for s in out["players"]["steamid"]}
    checks = extract.validate_scoreboard(kills, damage, sb, departed, everyone)
    return [c for c in checks if c.get("fatal") and not c["ok"]]


def read_tables(map_dir: Path, ignore_retired: bool = False) -> dict[str, pl.DataFrame] | None:
    """A map's tables, or None when it holds no complete map. ignore_retired reads a part a reader no longer sees."""
    d = extract.resolve_map_dir(map_dir)
    if d is None and ignore_retired and (map_dir / extract.CURRENT).exists():
        cand = map_dir / (map_dir / extract.CURRENT).read_text(encoding="utf-8").strip()
        d = cand if extract._complete(cand) else None
    if d is None:
        return None
    return {f.stem: pl.read_parquet(f) for f in sorted(d.glob("*.parquet"))}


def join(part_dirs: dict[int, Path], ignore_retired: bool = False) -> tuple[dict | None, str | None]:
    """(the stitched tables, None) when the parts (part number -> map folder) join into one map; (None, the reason)
    when they are held back."""
    tables, facts = [], []
    for n in sorted(part_dirs):
        T = read_tables(part_dirs[n], ignore_retired)
        if T is None:
            return None, f"part {n} holds no complete map"
        version = T["match"]["extractor_version"][0]
        if version != extract.EXTRACTOR_VERSION:  # before part_facts: an older part may lack a column it reads
            return None, f"part {n} was extracted by extractor {version}; re-extract it with {extract.EXTRACTOR_VERSION}"
        tables.append(T)
        facts.append(part_facts(n, T))
    why = plan(facts, extract.EXTRACTOR_VERSION)
    if why:
        return None, why
    stitched = stitch(tables, facts)
    failed = join_failures(stitched)
    if failed:
        f = failed[0]
        return None, (f"the joined scoreboard fails {len(failed)} check(s); first: {f['check']} of player "
                      f"{f.get('steamid')}: scoreboard {f['expected']}, events {f['actual']} {f.get('note') or ''}").strip()
    return stitched, None


def stitch_map(part_dirs: dict[int, Path], out_dir: Path, ignore_retired: bool = False) -> dict:
    """Join the parts (part number -> map folder) into out_dir, or hold them back. Returns the parts.jsonl row."""
    row = dict(map=str(out_dir), parts={str(n): str(d) for n, d in sorted(part_dirs.items())},
               checked_utc=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    stitched, why = join(part_dirs, ignore_retired)
    if why:
        return dict(row, status="held", reason=why)
    result = dict(rows={}, bytes={})
    extract.write_output(stitched, out_dir, result)
    return dict(row, status="stitched", version_dir=result["version_dir"], rounds=stitched["rounds"].height)


def split_maps(root: Path) -> dict[tuple[str, str], dict[int, list[Path]]]:
    """{(archive folder, base map key): {part number: [map folders]}} under root (demos/ or parts/). A part with two
    folders (the second named <key>_dup by demo_pipeline) has both listed; such a map is held, never joined."""
    out: dict[tuple[str, str], dict[int, list[Path]]] = {}
    for archive in sorted(p for p in root.iterdir() if p.is_dir()) if root.exists() else []:
        for m in sorted(p for p in archive.iterdir() if p.is_dir()):
            if (m / DAMAGED).exists():
                continue
            dup = DUP.match(m.name)
            k = split_key(dup["key"] if dup else m.name)
            if k:
                out.setdefault((archive.name, k[0]), {}).setdefault(k[1], []).append(m)
    return out


def readable(map_dir: Path) -> bool:
    """Whether readers still see a map folder in any layout they read (SCHEMA-v1.md "Finding a map's tables"): not
    withdrawn, and a CURRENT pointer, a schema v1 match.parquet, or a pre-v1 meta.parquet."""
    if (map_dir / extract.RETIRED).exists():
        return False
    return any((map_dir / f).exists() for f in (extract.CURRENT, "match.parquet", "meta.parquet"))


def remove_tree(root: Path) -> tuple[list[str], dict[str, str]]:
    """Delete root and everything in it, file by file. Returns the files removed and {file: why} for each that
    stayed, as paths relative to root; root stays while anything in it does. A DAMAGED marker in root goes only
    once everything else has. A link or junction is removed itself, never followed. shutil.rmtree(ignore_errors=
    True) said none of this: on Windows a table held open by another process stays while the other tables go."""
    removed: list[str] = []
    failed: dict[str, str] = {}

    def gone(p: Path, delete) -> bool:
        rel = p.relative_to(root).as_posix()
        try:
            delete(p)
        except OSError as e:
            failed[rel] = f"{type(e).__name__}: {e}"
            return False
        removed.append(rel)
        return True

    def unlink_link(p: Path) -> None:
        try:
            os.unlink(p)
        except OSError:
            os.rmdir(p)  # a directory symlink or junction on Windows

    def empty(d: Path) -> None:
        with os.scandir(d) as it:
            entries = sorted(it, key=lambda e: e.name)
        for e in entries:
            p = Path(e.path)
            if e.is_symlink() or os.path.isjunction(p):
                gone(p, unlink_link)
            elif e.is_dir(follow_symlinks=False):
                empty(p)
                try:
                    p.rmdir()
                except OSError:
                    pass  # it still holds a file that stayed, named in failed
            elif not (d == root and e.name == DAMAGED):
                gone(p, os.unlink)

    empty(root)
    if not failed and (root / DAMAGED).exists():
        gone(root / DAMAGED, os.unlink)
    try:
        root.rmdir()
    except FileNotFoundError:
        pass
    except OSError as e:
        if not failed:
            failed["."] = f"the folder stayed: {type(e).__name__}: {e}"
    return removed, failed


def delete_part(map_dir: Path) -> bool:
    """Delete a staged part's folder in parts/ under its map lock; False, leaving it, while another process holds
    the lock or a file in it cannot be deleted."""
    try:
        with extract.map_lock(map_dir, wait=False):
            remove_tree(map_dir)
    except extract.MapLocked:
        return False
    return not map_dir.exists()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", type=Path, required=True, help="the cs2-stats-data folder")
    ap.add_argument("--apply", action="store_true", help="write stitched maps and withdraw their parts from demos/")
    a = ap.parse_args(argv)
    demos, parts_root = a.data / "demos", a.data / "parts"
    found = split_maps(demos)
    for key, ps in split_maps(parts_root).items():  # a part published in demos/ wins over a staged copy
        found.setdefault(key, {}).update({n: ds for n, ds in ps.items() if n not in found.get(key, {})})
    rows = []
    for (archive, base), by_n in sorted(found.items()):
        out_dir = demos / archive / base
        ps = {n: ds[0] for n, ds in by_n.items()}
        dup = sorted(n for n, ds in by_n.items() if len(ds) > 1)
        why = f"part {', '.join(map(str, dup))} appears more than once; which copy is the match's cannot be told" \
            if dup else None
        if not a.apply:
            why = why or join(ps, ignore_retired=True)[1]
            row = dict(map=str(out_dir), status="held" if why else "would stitch", reason=why)
        else:
            extract.check_output(out_dir, private=True, what="a stitched map")
            row = dict(map=str(out_dir), status="held", reason=why) if why else stitch_map(ps, out_dir, ignore_retired=True)
            for d in [d for ds in by_n.values() for d in ds]:
                if d.parent.parent == parts_root:
                    if row["status"] == "stitched":
                        delete_part(d)  # staged; the stitched map holds it now, so a later run cannot join it again
                    continue
                if not readable(d):
                    continue  # already out of readers' sight
                if row["status"] == "stitched":
                    extract.retire_map(d, successor=out_dir)
                else:
                    extract.mark_stale(d, f"split part held back: {row['reason']}")
            extract.check_output(parts_root, private=True, what="the parts manifest")
            parts_root.mkdir(parents=True, exist_ok=True)
            with open(parts_root / PARTS_MANIFEST, "a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
        rows.append(row)
        print(json.dumps(dict(map=f"{archive}/{base}", parts=sorted(ps), status=row["status"], reason=row.get("reason"))))
    print(json.dumps(dict(split_maps=len(rows), stitched=sum(r["status"] in ("stitched", "would stitch") for r in rows))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
