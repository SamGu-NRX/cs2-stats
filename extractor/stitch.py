"""Join the parts of a map HLTV recorded as several demos (<map>-p1.dem, -p2.dem, ...) into one map, or hold it back.

A split recording's parts are extracted one by one (extract.py). Published as maps, each was its own match:
rounds numbered from 1 inside each part, so a second part's halftime and pistol rounds were wrong, and
neither part could join HLTV's map. Here the parts become one map with the match's own round numbers, but
only when they are provably one continuous recording of the whole match (plan): every part from 1 is present,
the first starts at round 1, each part's first round follows the last one's, both teams' scores and every
player's counters carry over unchanged, the sides are those the swap rule gives, the rosters are the same,
and the last part ends the match. Anything else is held back: its parts are kept, out of every reader's sight,
and parts.jsonl in the parts folder says why, so the map can be joined if a missing part arrives.

Run:  .venv\\Scripts\\python.exe -I stitch.py --data <cs2-stats-data>            (report only)
      .venv\\Scripts\\python.exe -I stitch.py --data <cs2-stats-data> --apply    (also join or withdraw)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I leaves this folder off sys.path
import extract  # noqa: E402

PART = re.compile(r"^(?P<base>.+)-p(?P<n>\d+)$")
# Counters that must carry over from one part's end to the next part's start, per player.
CARRIED = ["kills_total", "deaths_total", "assists_total", "damage_total", "headshot_kills_total"]
PARTS_MANIFEST = "parts.jsonl"  # in the parts folder


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
    end: dict  # SteamID -> CARRIED counters on the part's final scoreboard
    max_rounds: int
    ot_max: int


def part_facts(n: int, T: dict[str, pl.DataFrame]) -> Part:
    m = T["match"].row(0, named=True)
    convars = json.loads(m.get("convars") or "{}")
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
        start={int(r["steamid"]): tuple(int(r[f"{c}_at_start"]) for c in CARRIED) for r in sb.iter_rows(named=True)},
        end={int(r["steamid"]): tuple(int(r[c]) for c in CARRIED) for r in sb.iter_rows(named=True)},
        max_rounds=int(convars.get("mp_maxrounds") or 24), ot_max=int(convars.get("mp_overtime_maxrounds") or 6))


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
        moved = sorted(s for s in b.start if s in a.end and a.end[s] != b.start[s])
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


def _shift(df: pl.DataFrame, rounds: int, ticks: int, engagements: int) -> pl.DataFrame:
    """A part's table moved to the match's round numbers and onto its own stretch of the stitched tick line."""
    cols = []
    for c in df.columns:
        if c == "round":
            cols.append(pl.when(pl.col(c) > 0).then(pl.col(c) + rounds).otherwise(pl.col(c)).cast(df.schema[c]).alias(c))
        elif c == "tick" or c.endswith("_tick"):
            cols.append((pl.col(c) + ticks).cast(df.schema[c]).alias(c))
        elif c == "engagement_id":
            cols.append((pl.col(c) + engagements).cast(df.schema[c]).alias(c))
    return df.with_columns(cols) if cols else df


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
    ticks = eng = 0
    shifted, offsets = [], []
    for T, p in zip(tables, parts):
        m = T["match"].row(0, named=True)
        offsets.append(dict(ticks=ticks, rounds=p.first_round - 1, engagements=eng))
        shifted.append({name: _shift(df, p.first_round - 1, ticks, eng) for name, df in T.items()
                        if name not in ("match", "scoreboard", "players")})
        last_tick = max(int(m["final_tick"] or 0), int(m["playback_ticks"] or 0),
                        *(int(df[c].max() or 0) for df in T.values() for c in df.columns
                          if (c == "tick" or c.endswith("_tick")) and df.height and df.schema[c].is_integer()))
        ticks += last_tick + 1
        e = T.get("engagements")
        eng += int(e["engagement_id"].max()) + 1 if e is not None and e.height else 0
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
    # The final scoreboard is the last part's; what each player held at the match's start is the first part's.
    sb_last = tables[-1]["scoreboard"]
    at_start = [c for c in sb_last.columns if c.endswith("_at_start")]
    base = tables[0]["scoreboard"].select("steamid", *at_start)
    out["scoreboard"] = (sb_last.drop(at_start).join(base, on="steamid", how="left")
                         .with_columns([pl.col(c).fill_null(0) for c in at_start])
                         .with_columns(pl.col("tick") + offsets[-1]["ticks"]).select(sb_last.columns))
    max_rounds = parts[-1].max_rounds
    n = out["rounds"].height
    out["players"] = _players(pl.concat([T["players"] for T in tables], how="vertical"), out["player_rounds"],
                              max_rounds, n)
    out["match"] = _match(tables, parts, offsets, n)
    return out


def _match(tables, parts, offsets, n_rounds) -> pl.DataFrame:
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
        excluded_players=json.dumps(list({x["steamid"]: x for r in rows for x in json.loads(r["excluded_players"] or "[]")}.values())),
        parsed_at_utc=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        parts=json.dumps([dict(part=p.n, dem_file=r["dem_file"], demo_sha256=r["demo_sha256"], tick_offset=o["ticks"],
                               first_round=p.first_round, n_rounds=p.n_rounds) for p, r, o in zip(parts, rows, offsets)]))
    return pl.DataFrame([m], schema=tables[-1]["match"].schema)


def read_tables(map_dir: Path, ignore_retired: bool = False) -> dict[str, pl.DataFrame] | None:
    """A map's tables, or None when it holds no complete map. ignore_retired reads a part a reader no longer sees."""
    d = extract.resolve_map_dir(map_dir)
    if d is None and ignore_retired and (map_dir / extract.CURRENT).exists():
        cand = map_dir / (map_dir / extract.CURRENT).read_text(encoding="utf-8").strip()
        d = cand if extract._complete(cand) else None
    if d is None:
        return None
    return {f.stem: pl.read_parquet(f) for f in sorted(d.glob("*.parquet"))}


def stitch_map(part_dirs: dict[int, Path], out_dir: Path, ignore_retired: bool = False) -> dict:
    """Join the parts (part number -> map folder) into out_dir, or hold them back. Returns the parts.jsonl row."""
    tables, facts, unreadable = [], [], []
    for n in sorted(part_dirs):
        T = read_tables(part_dirs[n], ignore_retired)
        if T is None:
            unreadable.append(n)
            continue
        tables.append(T)
        facts.append(part_facts(n, T))
    row = dict(map=str(out_dir), parts={str(n): str(d) for n, d in sorted(part_dirs.items())},
               checked_utc=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    why = (f"part {', '.join(map(str, unreadable))} holds no complete map" if unreadable else None) or         plan(facts, extract.EXTRACTOR_VERSION)
    if why:
        return dict(row, status="held", reason=why)
    stitched = stitch(tables, facts)
    result = dict(rows={}, bytes={})
    extract.write_output(stitched, out_dir, result)
    return dict(row, status="stitched", version_dir=result["version_dir"], rounds=stitched["rounds"].height)


def split_maps(root: Path) -> dict[tuple[str, str], dict[int, Path]]:
    """{(archive folder, base map key): {part number: map folder}} under root (demos/ or parts/)."""
    out: dict[tuple[str, str], dict[int, Path]] = {}
    for archive in sorted(p for p in root.iterdir() if p.is_dir()) if root.exists() else []:
        for m in sorted(p for p in archive.iterdir() if p.is_dir()):
            k = split_key(m.name)
            if k:
                out.setdefault((archive.name, k[0]), {})[k[1]] = m
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", type=Path, required=True, help="the cs2-stats-data folder")
    ap.add_argument("--apply", action="store_true", help="write stitched maps and withdraw their parts from demos/")
    a = ap.parse_args(argv)
    demos, parts_root = a.data / "demos", a.data / "parts"
    found = split_maps(demos)
    for key, ps in split_maps(parts_root).items():
        found.setdefault(key, {}).update({n: d for n, d in ps.items() if n not in found.get(key, {})})
    rows = []
    for (archive, base), ps in sorted(found.items()):
        out_dir = demos / archive / base
        if not a.apply:
            facts, why = [], None
            for n in sorted(ps):
                T = read_tables(ps[n], ignore_retired=True)
                if T is None:
                    why = f"part {n} holds no complete map"
                    break
                facts.append(part_facts(n, T))
            row = dict(map=str(out_dir), status="held" if (why := why or plan(facts, extract.EXTRACTOR_VERSION)) else "would stitch",
                       reason=why)
        else:
            extract.check_output(out_dir, private=True, what="a stitched map")
            row = stitch_map(ps, out_dir, ignore_retired=True)
            for n, d in ps.items():
                if d.parent.parent != demos or extract.resolve_map_dir(d) is None:
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
