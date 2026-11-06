"""Extract demos CS2 recorded on this machine (GOTV tv_autorecord, auto-*.dem) into schema v1 tables.

Usage: python -I local_import.py --out DIR [DEMO ...] [--mapdata DIR] [--steam DIR] [--user STEAMID64]
       [--force] [--progress] [--result FILE]
       python -I local_import.py --version

With no DEMO, every auto-*.dem in the CS2 replays folder of the local Steam install is imported. A demo
goes to DIR/<id>/ in the versioned layout of SCHEMA-v1.md, where <id> is <yyyymmddThhmmZ>_<map>_<sha8>:
the demo's creation time in UTC, the map from its header and the first 8 hex digits of its SHA-256. A
demo already named <id>.dem (the app's demos folder) keeps that id.

The id replaces the file name everywhere, because CS2 names a recorded demo after the server, and a
listen server is named after the player hosting it: auto-<date>-<time>-<map>-<Steam name>.dem. That
name is never stored, printed or used for team names, and match.server_name is left empty for the same
reason. Imports share valve_import.py's core: a demo whose current tables came from the same file,
extractor version and importer version is skipped unless --force.

match.extra records "pov", the SteamID64 of the player who recorded the match: the only human in it
when there is exactly one (a bot match), else the user (--user, else valve-user.local.json in DIR, else
Steam's most recent login, as valve_import.py finds it) when the user played. With neither, "pov" is
left out and the result says why.

Prints a JSON summary (also written to --result); each result has "reason": null when the demo
validated, "no_rounds" when it holds no round played after the match started (a demo cut off in warmup
or freeze time), else "extract_failed". --progress writes one JSON line per demo start and end to
stderr. Exit code 0: every demo validated; 1: at least one failed; 2: bad arguments, an --out inside a
repository, or no demo to import.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pandas as pd  # noqa: E402
import polars as pl  # noqa: E402

import extract  # noqa: E402
import valve_import as vi  # noqa: E402
from repo_guard import OutputRefused, check_output, write_json  # noqa: E402

DEMO_GLOB = "auto-*.dem"
# What import_local writes into match.extra (pov, date, started_at). Bump it when that changes, so demos
# imported before are imported again rather than skipped.
IMPORTER_VERSION = 1
ID_RE = re.compile(r"^\d{8}T\d{4}Z_[a-z0-9_]+_[0-9a-f]{8}$")
# extract.py's error for a demo with no round_end after begin_new_match
NO_ROUNDS = "no round_end events after match start"


def created_utc(dem: Path) -> datetime:
    """When the demo file was created, in UTC: st_birthtime (NTFS creation time; a same-volume move keeps
    it), else the modification time where the system records no creation time."""
    st = dem.stat()
    return datetime.fromtimestamp(getattr(st, "st_birthtime", st.st_mtime), timezone.utc)


def demo_map(dem: Path) -> str:
    """The map name in the demo's header."""
    from demoparser2 import DemoParser
    return str(DemoParser(str(dem)).parse_header().get("map_name") or "")


def demo_id(dem: Path, sha256: str) -> str:
    """<yyyymmddThhmmZ>_<map>_<sha8>; the stem of a demo already named that way."""
    if ID_RE.match(dem.stem):
        return dem.stem
    slug = re.sub(r"[^a-z0-9_]+", "_", demo_map(dem).lower()).strip("_") or "unknown"
    return f"{created_utc(dem):%Y%m%dT%H%MZ}_{slug}_{sha256[:8]}"


def pov_of(players: pd.DataFrame, user: int | None) -> dict:
    """{pov, pov_source} for match.extra: the only human, else the user when the user played; {} with
    neither. Bots carry ids below 2**40 (engagements.bot_id); everyone else has a SteamID64."""
    humans = [int(s) for s, bot in zip(players.steamid, players.is_bot) if not bot]
    if len(humans) == 1:
        return dict(pov=str(humans[0]), pov_source="the only human player")
    if user is not None and user in humans:
        return dict(pov=str(user), pov_source="the user's SteamID64")
    return {}


def scrub(text: str, original: str, demo: str) -> str:
    """text with the demo's original file name (whose end is a Steam name) replaced by its id."""
    return text.replace(original, demo) if original else text


def stored_pov(map_dir: Path) -> str | None:
    """match.extra's pov in the map's current tables."""
    d = extract.resolve_map_dir(map_dir)
    extra = pl.read_parquet(d / "match.parquet", columns=["extra"])["extra"][0] if d else "{}"
    return json.loads(extra).get("pov")


def import_local(demos: list[Path], out: Path, mapdata: Path | None, user_of, force: bool = False,
                 progress=None) -> list[dict]:
    """Extract each demo into out/<id>/. user_of() returns the user's SteamID64, or raises when it cannot be
    found; it is asked only for a demo with more than one human. progress(event) hears each start and end."""
    rows = []
    for i, dem in enumerate(demos, 1):
        sha = extract.file_sha256(dem)
        did = demo_id(dem, sha)
        map_dir = out / did
        if progress:
            progress(dict(event="start", i=i, n=len(demos), demo=did))
        found: dict = {}

        def extra_from_players(players: pd.DataFrame) -> dict:
            humans = int((~players.is_bot.astype(bool)).sum())
            user = None
            if humans > 1:
                try:
                    user = user_of()
                except Exception as e:  # noqa: BLE001 - reported in the result; the tables are still written
                    found["pov_error"] = f"{type(e).__name__}: {e}"
            found.update(pov_of(players, user))
            if "pov" not in found:
                found.setdefault("pov_error", f"{humans} human players and the user is not among them")
            return {k: found[k] for k in ("pov", "pov_source") if k in found}

        at = created_utc(dem).isoformat(timespec="seconds")
        row = dict(demo=did, out=str(map_dir))
        row.update(vi.extract_into(dem, map_dir, "local", mapdata, force=force, archive=did, name=f"{did}.dem",
                                   extra_from_players=extra_from_players,
                                   meta_extra=dict(importer="local_import", importer_version=IMPORTER_VERSION,
                                                   date=at, started_at=at, date_source="file creation time")))
        row["errors"] = [scrub(e, dem.stem, did) for e in row.get("errors", [])]
        row["reason"] = None if row["ok"] else (
            "no_rounds" if any(NO_ROUNDS in e for e in row["errors"]) else "extract_failed")
        row["pov"] = found.get("pov") if "skipped" not in row else stored_pov(map_dir)
        if "pov_error" in found and row["ok"] and "skipped" not in row:
            row["pov_error"] = scrub(found["pov_error"], dem.stem, did)
        rows.append(row)
        if progress:
            progress(dict(event="done", i=i, n=len(demos), demo=did, ok=row["ok"], skipped="skipped" in row))
    return rows


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("demos", nargs="*", type=Path, help="demo files; default: every auto-*.dem in the replays folder")
    ap.add_argument("--out", required=True, type=Path, help="folder for the per-demo table folders")
    ap.add_argument("--mapdata", type=Path, help="awpy-data release folder with geometry/<map>.mesh")
    ap.add_argument("--steam", type=Path, help="Steam install folder (default: found from the system)")
    ap.add_argument("--user", type=int, help="the user's SteamID64, for a demo with more than one human")
    ap.add_argument("--force", action="store_true", help="re-extract demos that are already up to date")
    ap.add_argument("--result", type=Path, help="also write the JSON summary here")
    ap.add_argument("--progress", action="store_true",
                    help="write one JSON line to stderr as each demo starts and ends (for the app)")
    # the app keeps a demo whose extraction failed until the extractor version changes, so it asks first
    ap.add_argument("--version", action="version", version=extract.EXTRACTOR_VERSION,
                    help="print the extractor version and exit")
    a = ap.parse_args(argv)
    if repo := vi.git_work_tree(a.out):
        ap.error(f"--out {a.out} is inside the git work tree {repo}; the tables hold SteamIDs and names, "
                 "so choose a folder outside it")
    try:
        check_output(a.out, private=True, what="the per-demo tables")
        if a.result:
            check_output(a.result, private=True, what="the import summary")
    except OutputRefused as e:
        ap.error(str(e))
    demos = a.demos or sorted(vi.replays_dir(a.steam or vi.steam_root()).glob(DEMO_GLOB))
    if not demos:
        ap.error("no demo to import: none given, and no auto-*.dem in the replays folder")
    if missing := [d for d in demos if not d.is_file()]:
        ap.error(f"{len(missing)} of the demos given do not exist")  # their names may end in a Steam name
    say = (lambda ev: print(json.dumps(ev), file=sys.stderr, flush=True)) if a.progress else None
    rows = import_local(demos, a.out, a.mapdata, lambda: vi.resolve_user(a.out, a.steam, a.user)["steamid"],
                        a.force, say)
    summary = dict(extractor_version=extract.EXTRACTOR_VERSION, importer_version=IMPORTER_VERSION,
                   demos=len(rows), ok=sum(r["ok"] for r in rows), results=rows)
    txt = json.dumps(summary, default=extract._json_default, indent=1)
    if a.result:
        write_json(a.result, summary, private=True, what="the import summary", default=extract._json_default, indent=1)
    print(txt)
    return 0 if all(r["ok"] for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
