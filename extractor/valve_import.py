"""Extract Valve matchmaking demos (match730_*.dem) into schema v1 tables, one folder per demo.

Usage: python -I valve_import.py --out DIR [DEMO ...] [--mapdata DIR] [--steam DIR] [--user STEAMID64]
       [--force] [--allow-in-repo] [--progress] [--result FILE]

With no DEMO, every match730_*.dem in the CS2 replays folder of the local Steam install is imported. Each
demo goes to DIR/<demo file name without .dem>/ in the versioned layout of SCHEMA-v1.md (CURRENT names the
version folder) and must reproduce its own scoreboard, as extract.py checks. A demo whose current tables
came from the same file, extractor version and importer version is skipped unless --force. match.extra
records the match date: the match time Steam writes into the .dem.info beside the demo, else the demo's
file time. --progress writes one JSON line per demo start and end to stderr, which the app shows.

The user is identified by SteamID64: --user, else the one already in DIR/valve-user.local.json, else the
most recent account in Steam's config/loginusers.vdf. That file is written with the id and where it came
from, and each result says whether the user played in that match. It holds the user's own id, so it lives
next to the outputs, never in the repository: an --out inside a git work tree is refused unless
--allow-in-repo.

Prints a JSON summary (also written to --result). Exit code 0: every demo validated; 1: at least one failed;
2: bad arguments, an --out inside a repository, or no demo to import.
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import polars as pl  # noqa: E402

import extract  # noqa: E402

USER_FILE = "valve-user.local.json"
DEMO_GLOB = "match730_*.dem"
REPLAYS = Path("steamapps", "common", "Counter-Strike Global Offensive", "game", "csgo", "replays")
CS2_APP_ID = "730"
STEAMID64_MIN = 76561197960265728  # SteamID64 of account id 0 in the public universe


def parse_vdf(text: str) -> dict:
    """Valve's text KeyValues format (loginusers.vdf, libraryfolders.vdf): quoted keys, quoted values or
    braced blocks. Raises ValueError on anything else, so a format change fails loudly."""
    tokens = re.findall(r'"((?:[^"\\]|\\.)*)"|([{}])|(//[^\n]*)|(\S)', text)
    stack, key = [{}], None
    for quoted, brace, comment, other in tokens:
        if comment:
            continue
        if other:
            raise ValueError(f"unexpected {other!r} in VDF")
        if brace == "{":
            if key is None:
                raise ValueError("block without a key in VDF")
            stack[-1][key] = {}
            stack.append(stack[-1][key])
            key = None
        elif brace == "}":
            if len(stack) == 1 or key is not None:
                raise ValueError("unbalanced block in VDF")
            stack.pop()
        elif key is None:
            key = quoted.replace('\\"', '"').replace("\\\\", "\\")
        else:
            stack[-1][key] = quoted.replace('\\"', '"').replace("\\\\", "\\")
            key = None
    if len(stack) != 1 or key is not None:
        raise ValueError("VDF ends inside a block or after a key")
    return stack[0]


def most_recent_user(loginusers: dict) -> int:
    """SteamID64 of the account Steam marks MostRecent, else the one with the newest login timestamp."""
    users = loginusers.get("users")
    if not isinstance(users, dict) or not users:
        raise ValueError("loginusers.vdf lists no users")
    ids = {k: v for k, v in users.items() if k.isdigit() and int(k) >= STEAMID64_MIN and isinstance(v, dict)}
    if not ids:
        raise ValueError("loginusers.vdf has no SteamID64 keys")
    marked = [k for k, v in ids.items() if v.get("MostRecent") == "1"]
    if len(marked) == 1:
        return int(marked[0])
    return int(max(ids, key=lambda k: int(ids[k].get("timestamp", "0") or 0)))


def steam_root() -> Path:
    """The Steam install folder, from the registry on Windows, else the usual locations."""
    if sys.platform == "win32":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as k:
                return Path(winreg.QueryValueEx(k, "SteamPath")[0])
        except OSError:
            pass
    for p in (Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Steam",
              Path.home() / "Library" / "Application Support" / "Steam", Path.home() / ".steam" / "steam",
              Path.home() / ".local" / "share" / "Steam"):
        if (p / "steamapps").is_dir():
            return p
    raise FileNotFoundError("no Steam install found; pass --steam")


def replays_dir(steam: Path) -> Path:
    """The CS2 replays folder in whichever Steam library holds CS2 (app 730), per libraryfolders.vdf."""
    libs = [steam]
    lf = steam / "steamapps" / "libraryfolders.vdf"
    if lf.exists():
        folders = parse_vdf(lf.read_text(encoding="utf-8")).get("libraryfolders", {})
        with_cs2 = [Path(v["path"]) for v in folders.values()
                    if isinstance(v, dict) and "path" in v and CS2_APP_ID in (v.get("apps") or {})]
        libs = with_cs2 + [Path(v["path"]) for v in folders.values() if isinstance(v, dict) and "path" in v]
    for lib in libs:
        if (lib / REPLAYS).is_dir():
            return lib / REPLAYS
    raise FileNotFoundError(f"no CS2 replays folder in the Steam libraries {[str(x) for x in libs]}")


def git_work_tree(path: Path) -> Path | None:
    """The git work tree path is in (an ancestor holding .git, a folder or a worktree's file), or None."""
    for d in [path.resolve(), *path.resolve().parents]:
        if (d / ".git").exists():
            return d
    return None


def resolve_user(out: Path, steam: Path | None, explicit: int | None) -> dict:
    """{steamid, source}: --user, else the saved file, else Steam's most recent login. Writes the file."""
    path = out / USER_FILE
    if explicit is not None:
        user = dict(steamid=explicit, source="--user")
    elif path.exists():
        user = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(user.get("steamid"), int):
            raise ValueError(f"{path}: steamid must be an integer SteamID64")
    else:
        login = (steam or steam_root()) / "config" / "loginusers.vdf"
        user = dict(steamid=most_recent_user(parse_vdf(login.read_text(encoding="utf-8"))),
                    source=f"most recent account in {login}")
    if user["steamid"] < STEAMID64_MIN:
        raise ValueError(f"{user['steamid']} is not a SteamID64")
    out.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(user, indent=1) + "\n", encoding="utf-8")
    return user


# What import_demos writes into match.extra (the app reads "date"). Bump it when that changes, so maps
# imported before are imported again rather than skipped.
IMPORTER_VERSION = 2


def _varint(b: bytes, i: int) -> tuple[int, int]:
    v = shift = 0
    while True:
        if i >= len(b) or shift > 63:
            raise ValueError("truncated varint")
        c = b[i]
        i += 1
        v |= (c & 0x7F) << shift
        shift += 7
        if not c & 0x80:
            return v, i


def info_matchtime(info: bytes) -> int | None:
    """matchtime (field 2, Unix seconds) of the CDataGCCStrike15_v2_MatchInfo message in a .dem.info file,
    or None when the message has no such field or does not parse."""
    i = 0
    try:
        while i < len(info):
            key, i = _varint(info, i)
            field, wire = key >> 3, key & 7
            if wire == 0:
                v, i = _varint(info, i)
                if field == 2:
                    return v
            elif wire == 2:
                n, i = _varint(info, i)
                i += n
            elif wire in (1, 5):
                i += 8 if wire == 1 else 4
            else:
                return None
    except ValueError:
        return None
    return None


def match_date(dem: Path) -> dict:
    """{date (UTC ISO-8601), date_source} for a demo. Demos carry no date; Steam writes the match time into
    the .dem.info beside a matchmaking demo, and the demo's own file time is the fallback."""
    info = dem.with_name(dem.name + ".info")
    t = info_matchtime(info.read_bytes()) if info.is_file() else None
    # matchtime is seconds since 1970; anything before CS2's release (2023-09-27) is not one
    if t is not None and t >= 1695772800:
        return dict(date=datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="seconds"), date_source="dem.info")
    return dict(date=datetime.fromtimestamp(dem.stat().st_mtime, timezone.utc).isoformat(timespec="seconds"),
                date_source="file time")


def already_done(map_dir: Path, dem: Path) -> bool:
    """The map's current tables came from this exact file, this extractor version and this importer."""
    d = extract.resolve_map_dir(map_dir) if map_dir.exists() else None
    if d is None:
        return False
    m = pl.read_parquet(d / "match.parquet", columns=["demo_sha256", "extractor_version", "extra"]).row(0, named=True)
    return (m["extractor_version"] == extract.EXTRACTOR_VERSION and m["demo_sha256"] == extract.file_sha256(dem)
            and json.loads(m["extra"]).get("importer_version") == IMPORTER_VERSION)


def user_in_match(map_dir: Path, steamid: int) -> bool | None:
    d = extract.resolve_map_dir(map_dir)
    if d is None:
        return None
    return steamid in pl.read_parquet(d / "players.parquet", columns=["steamid"])["steamid"].to_list()


def import_demos(demos: list[Path], out: Path, mapdata: Path | None, user: dict, force: bool = False,
                 progress=None) -> list[dict]:
    """Extract each demo into out/<demo stem>/. progress(event dict) is told when each demo starts and ends."""
    rows = []
    for i, dem in enumerate(demos, 1):
        map_dir = out / dem.stem
        row = dict(demo=dem.name, out=str(map_dir))
        if progress:
            progress(dict(event="start", i=i, n=len(demos), demo=dem.name))
        if not force and already_done(map_dir, dem):
            row.update(ok=True, skipped="already extracted from this file by this extractor version")
        else:
            res = extract.extract_demo(dem, map_dir, "valve", mapdata=mapdata, archive=dem.stem,
                                       meta_extra=dict(importer="valve_import", importer_version=IMPORTER_VERSION,
                                                       **match_date(dem)))
            v = res.get("validation") or {}
            row.update(ok=res["ok"], errors=res["errors"], map=res.get("map_name"), rounds=res.get("rounds"),
                       final_score=res.get("final_score"), tick_rate=res.get("tick_rate"),
                       visibility=(res.get("visibility") or {}).get("status"), seconds=res.get("seconds"),
                       failed_checks=v.get("failed", []), warnings=v.get("nonfatal_failed", []))
            gc.collect()
        row["user_in_match"] = user_in_match(map_dir, user["steamid"]) if row["ok"] else None
        rows.append(row)
        if progress:
            progress(dict(event="done", i=i, n=len(demos), demo=dem.name, ok=row["ok"], skipped="skipped" in row))
    return rows


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("demos", nargs="*", type=Path, help="demo files; default: every match730_*.dem in the replays folder")
    ap.add_argument("--out", required=True, type=Path, help="folder for the per-demo table folders")
    ap.add_argument("--mapdata", type=Path, help="awpy-data release folder with geometry/<map>.mesh")
    ap.add_argument("--steam", type=Path, help="Steam install folder (default: found from the system)")
    ap.add_argument("--user", type=int, help="the user's SteamID64 (default: saved, else Steam's most recent login)")
    ap.add_argument("--force", action="store_true", help="re-extract demos that are already up to date")
    ap.add_argument("--allow-in-repo", action="store_true",
                    help="allow --out inside a git work tree (it receives the user's SteamID64)")
    ap.add_argument("--result", type=Path, help="also write the JSON summary here")
    ap.add_argument("--progress", action="store_true",
                    help="write one JSON line to stderr as each demo starts and ends (for the app)")
    a = ap.parse_args(argv)
    if (repo := git_work_tree(a.out)) and not a.allow_in_repo:
        ap.error(f"--out {a.out} is inside the git work tree {repo}, and {USER_FILE} would hold the user's "
                 "SteamID64; choose a folder outside it, or pass --allow-in-repo")
    demos = a.demos or sorted(replays_dir(a.steam or steam_root()).glob(DEMO_GLOB))
    if not demos:
        ap.error("no demo to import: none given, and no match730_*.dem in the replays folder")
    if missing := [str(d) for d in demos if not d.is_file()]:
        ap.error(f"no such demo: {missing}")
    user = resolve_user(a.out, a.steam, a.user)
    say = (lambda ev: print(json.dumps(ev), file=sys.stderr, flush=True)) if a.progress else None
    rows = import_demos(demos, a.out, a.mapdata, user, a.force, say)
    summary = dict(extractor_version=extract.EXTRACTOR_VERSION, user_file=str(a.out / USER_FILE),
                   demos=len(rows), ok=sum(r["ok"] for r in rows), results=rows)
    txt = json.dumps(summary, default=extract._json_default, indent=1)
    if a.result:
        a.result.write_text(txt, encoding="utf-8")
    print(txt)
    return 0 if all(r["ok"] for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
